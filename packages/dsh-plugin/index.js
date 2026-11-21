import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'muse-agent-link'
export const inject = ['webServer']

export const VERSION = '0.1.1'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(DSH_HOME, 'muse-agent-link')
const STATE_PATH = path.join(STATE_DIR, 'state.json')

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return null
  }
}

function ensureState() {
  let state = loadState()
  if (!state) {
    state = {
      plugin: 'muse-agent-link',
      version: VERSION,
      machine: os.hostname(),
      paired: false,
      createdAt: new Date().toISOString(),
    }
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
    } catch {}
  }
  return state
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

export function apply(ctx) {
  const state = ensureState()
  console.log(`[muse-agent-link] v${VERSION} loaded on ${state.machine} (paired=${state.paired})`)

  const routeDisposers = []
  const registerSafe = (spec) => {
    try {
      routeDisposers.push(ctx.webServer.register(spec))
    } catch (err) {
      if (!String(err?.message || err).includes('duplicate exact route')) throw err
    }
  }

  registerSafe({
    kind: 'exact',
    path: '/api/muse-agent-link/status',
    async handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      const current = loadState() || state
      sendJson(res, 200, {
        ok: true,
        plugin: 'muse-agent-link',
        version: VERSION,
        machine: os.hostname(),
        paired: Boolean(current.paired),
        channel: 'tailscale-direct',
        time: new Date().toISOString(),
      })
    },
  })

  ctx.on('dispose', () => {
    for (const d of routeDisposers) {
      try {
        if (typeof d === 'function') d()
      } catch {}
    }
  })
}

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'muse-agent-link'
export const inject = ['webServer']

export const VERSION = '0.2.1'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(DSH_HOME, 'muse-agent-link')
const STATE_PATH = path.join(STATE_DIR, 'state.json')
const JOBS_DIR = path.join(STATE_DIR, 'jobs')
const DEFAULT_WORKSPACE = path.join(STATE_DIR, 'workspace')

const MAX_CONCURRENT_JOBS = 2
const DEFAULT_TIMEOUT_SEC = 600
const PAIRING_TTL_MS = 30 * 60 * 1000
const RESULT_TAIL_CHARS = 4000

// ---------- state ----------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return null
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
  } catch {}
}

function newPairingCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

function ensureState() {
  let state = loadState()
  if (!state) {
    state = {
      plugin: 'muse-agent-link',
      version: VERSION,
      machine: os.hostname(),
      paired: false,
      tokenHash: null,
      pairingCode: null,
      pairingExpiresAt: null,
      createdAt: new Date().toISOString(),
    }
  }
  state.version = VERSION
  state.machine = os.hostname()
  if (!state.paired) {
    const expired =
      !state.pairingCode ||
      !state.pairingExpiresAt ||
      Date.now() > new Date(state.pairingExpiresAt).getTime()
    if (expired) {
      state.pairingCode = newPairingCode()
      state.pairingExpiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString()
    }
  }
  saveState(state)
  return state
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function tokenMatches(state, token) {
  if (!state?.tokenHash || !token) return false
  const a = Buffer.from(sha256Hex(token), 'hex')
  const b = Buffer.from(state.tokenHash, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// ---------- jobs ----------

const runningJobs = new Map()

function jobPath(id) {
  return path.join(JOBS_DIR, `${id}.json`)
}

function saveJob(job) {
  try {
    fs.mkdirSync(JOBS_DIR, { recursive: true })
    fs.writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2))
  } catch {}
}

function loadJob(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  try {
    return JSON.parse(fs.readFileSync(jobPath(id), 'utf8'))
  } catch {
    return null
  }
}

function listJobs(limit = 20) {
  try {
    return fs
      .readdirSync(JOBS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf8'))
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit)
      .map((j) => ({
        id: j.id,
        state: j.state,
        workspace: j.workspace,
        promptPreview: String(j.prompt || '').slice(0, 120),
        createdAt: j.createdAt,
        finishedAt: j.finishedAt || null,
        exitCode: j.exitCode ?? null,
      }))
  } catch {
    return []
  }
}

function resolveDshEntry() {
  const argv1 = process.argv[1] || ''
  if (argv1 && argv1.replace(/\\/g, '/').includes('@deepseek-ai/dsh/')) return argv1
  return path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'npm',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js'
  )
}

function runJob(job) {
  const entry = resolveDshEntry()
  const child = spawn(process.execPath, [entry, 'headless', job.prompt], {
    cwd: job.workspace,
    env: { ...process.env, DSH_HOME },
    windowsHide: true,
  })
  runningJobs.set(job.id, child)
  let stdout = ''
  let stderr = ''
  const timer = setTimeout(() => {
    try {
      child.kill()
    } catch {}
  }, job.timeoutSec * 1000)
  child.stdout.on('data', (d) => {
    stdout += d.toString()
  })
  child.stderr.on('data', (d) => {
    stderr += d.toString()
  })
  child.on('error', (err) => {
    clearTimeout(timer)
    runningJobs.delete(job.id)
    job.state = 'failed'
    job.error = String(err?.message || err)
    job.finishedAt = new Date().toISOString()
    saveJob(job)
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    runningJobs.delete(job.id)
    job.exitCode = code
    job.finishedAt = new Date().toISOString()
    job.state = code === 0 ? 'succeeded' : 'failed'
    job.result = stdout.slice(-RESULT_TAIL_CHARS)
    if (code !== 0) job.stderrTail = stderr.slice(-2000)
    saveJob(job)
    console.log(`[muse-agent-link] job ${job.id} ${job.state} (exit ${code})`)
  })
}

// ---------- http helpers ----------

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function sendError(res, code, errCode, message) {
  sendJson(res, code, { error: { code: errCode, message } })
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function isLoopback(req) {
  const addr = req.socket?.remoteAddress || ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

// ---------- plugin ----------

export function apply(ctx) {
  let state = ensureState()
  try {
    fs.mkdirSync(DEFAULT_WORKSPACE, { recursive: true })
  } catch {}
  console.log(
    `[muse-agent-link] v${VERSION} loaded on ${state.machine} (paired=${state.paired})`
  )

  const routeDisposers = []
  const registerSafe = (spec) => {
    try {
      routeDisposers.push(ctx.webServer.register(spec))
    } catch (err) {
      if (!String(err?.message || err).includes('duplicate')) throw err
    }
  }

  // NOTE: this host's webServer 'prefix' routes did not match API subpaths
  // in practice (v0.2.0 returned host 404s), so all endpoints are registered
  // as exact routes and job ids travel as query parameters.
  async function dispatch(req, res) {
      const url = new URL(req.url || '/', 'http://localhost')
      const sub = url.pathname.replace('/api/muse-agent-link', '')
      state = loadState() || state

      // --- public: status ---
      if (sub === '/status' && (req.method === 'GET' || req.method === 'HEAD')) {
        const body = {
          ok: true,
          plugin: 'muse-agent-link',
          version: VERSION,
          machine: os.hostname(),
          paired: Boolean(state.paired),
          channel: 'tailscale-direct',
          time: new Date().toISOString(),
        }
        // The one-time pairing code is only disclosed to local requests,
        // so the machine's own sidebar card can show it to the owner.
        if (!state.paired && isLoopback(req)) {
          body.pairingCode = state.pairingCode
          body.pairingExpiresAt = state.pairingExpiresAt
        }
        sendJson(res, 200, body)
        return
      }

      // --- public: pair (one-time code -> device token) ---
      if (sub === '/pair' && req.method === 'POST') {
        if (state.paired) {
          sendError(res, 409, 'already_paired', 'This machine is already paired. Unpair first.')
          return
        }
        let body
        try {
          body = await readJsonBody(req)
        } catch {
          sendError(res, 400, 'bad_request', 'Invalid JSON body.')
          return
        }
        const codeOk =
          body.code &&
          body.code === state.pairingCode &&
          state.pairingExpiresAt &&
          Date.now() <= new Date(state.pairingExpiresAt).getTime()
        if (!codeOk) {
          sendError(res, 401, 'pairing_code_invalid', 'Pairing code is wrong or expired.')
          return
        }
        const token = crypto.randomBytes(32).toString('hex')
        state.paired = true
        state.tokenHash = sha256Hex(token)
        state.pairingCode = null
        state.pairingExpiresAt = null
        state.pairedAt = new Date().toISOString()
        saveState(state)
        console.log('[muse-agent-link] paired with controller')
        sendJson(res, 200, { ok: true, token, machine: os.hostname() })
        return
      }

      // --- everything below requires the device token ---
      const auth = String(req.headers['authorization'] || '')
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      if (!tokenMatches(state, token)) {
        sendError(res, 401, 'unauthorized', 'Missing or invalid device token.')
        return
      }

      if (sub === '/unpair' && req.method === 'POST') {
        state.paired = false
        state.tokenHash = null
        state.pairingCode = newPairingCode()
        state.pairingExpiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString()
        saveState(state)
        console.log('[muse-agent-link] unpaired; new pairing code issued')
        sendJson(res, 200, { ok: true, paired: false })
        return
      }

      if (sub === '/tasks' && req.method === 'POST') {
        if (runningJobs.size >= MAX_CONCURRENT_JOBS) {
          sendError(res, 429, 'concurrency_limit', 'Too many running jobs.')
          return
        }
        let body
        try {
          body = await readJsonBody(req)
        } catch {
          sendError(res, 400, 'bad_request', 'Invalid JSON body.')
          return
        }
        if (!body.prompt || typeof body.prompt !== 'string') {
          sendError(res, 400, 'bad_request', 'prompt is required.')
          return
        }
        let workspace = DEFAULT_WORKSPACE
        if (body.workspace) {
          const resolved = path.resolve(String(body.workspace))
          if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            sendError(res, 400, 'workspace_not_found', `Workspace does not exist: ${resolved}`)
            return
          }
          workspace = resolved
        }
        const job = {
          id: crypto.randomUUID(),
          prompt: body.prompt,
          workspace,
          timeoutSec: Math.min(Math.max(Number(body.timeoutSec) || DEFAULT_TIMEOUT_SEC, 10), 3600),
          state: 'running',
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: null,
          exitCode: null,
          result: null,
        }
        saveJob(job)
        runJob(job)
        console.log(`[muse-agent-link] job ${job.id} started in ${workspace}`)
        sendJson(res, 202, { ok: true, job: { id: job.id, state: job.state, workspace } })
        return
      }

      if (sub === '/tasks' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, jobs: listJobs() })
        return
      }

      if (sub === '/task' && req.method === 'GET') {
        const job = loadJob(url.searchParams.get('id') || '')
        if (!job) {
          sendError(res, 404, 'job_not_found', 'Job not found.')
          return
        }
        sendJson(res, 200, { ok: true, job })
        return
      }

      if (sub === '/task-cancel' && req.method === 'POST') {
        const cancelId = url.searchParams.get('id') || ''
        const child = runningJobs.get(cancelId)
        if (!child) {
          sendError(res, 404, 'job_not_running', 'Job is not running.')
          return
        }
        try {
          child.kill()
        } catch {}
        sendJson(res, 200, { ok: true, cancelling: cancelId })
        return
      }

      sendError(res, 404, 'not_found', `No route for ${req.method} ${sub}`)
  }

  for (const p of [
    '/api/muse-agent-link/status',
    '/api/muse-agent-link/pair',
    '/api/muse-agent-link/unpair',
    '/api/muse-agent-link/tasks',
    '/api/muse-agent-link/task',
    '/api/muse-agent-link/task-cancel',
  ]) {
    registerSafe({ kind: 'exact', path: p, handler: dispatch })
  }

  ctx.on('dispose', () => {
    for (const d of routeDisposers) {
      try {
        if (typeof d === 'function') d()
      } catch {}
    }
  })
}

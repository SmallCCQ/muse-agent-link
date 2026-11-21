// ACP probe: spawn `agy acp`, run initialize -> session/new -> session/prompt,
// log every JSON-RPC message to acp-probe.log next to this script.
// Runs inside the interactive desktop session (agy auth lives there).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const LOG = path.join(here, 'acp-probe.log')
const AGY = path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe')
const WORKSPACE = process.argv[2] || process.env.USERPROFILE || 'C:\\Users\\Smallsun'

function log(line) {
  fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
}

fs.writeFileSync(LOG, '')
log(`probe start; agy=${AGY}; cwd=${WORKSPACE}`)

const child = spawn(AGY, ['acp'], { cwd: WORKSPACE, windowsHide: true })
let buf = ''
let nextId = 1
const pending = new Map()
let sessionId = null
let promptDone = false

function send(obj) {
  const line = JSON.stringify(obj)
  log(`>> ${line.slice(0, 600)}`)
  child.stdin.write(line + '\n')
}

function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

child.stdout.on('data', (d) => {
  buf += d.toString()
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    log(`<< ${line.slice(0, 1200)}`)
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error).slice(0, 400)))
      else p.resolve(msg.result)
    } else if (msg.method && msg.id !== undefined) {
      // Agent -> client request (e.g. permission). Answer permissively in the
      // probe: pick the first option if options are offered.
      const options = msg.params?.options
      const choice = Array.isArray(options) && options.length ? { optionId: options[0].optionId } : {}
      log(`agent request ${msg.method}; auto-reply ${JSON.stringify(choice)}`)
      send({ jsonrpc: '2.0', id: msg.id, result: choice })
    }
  }
})
child.stderr.on('data', (d) => log(`STDERR ${d.toString().slice(0, 400)}`))
child.on('error', (e) => log(`spawn error ${e.message}`))
child.on('close', (code) => log(`agy exited ${code}`))

const timeout = setTimeout(() => {
  log('TIMEOUT 120s')
  try { child.kill() } catch {}
  process.exit(2)
}, 120000)

try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'muse-agent-link-probe', version: '0.1.0' },
  })
  log(`initialize ok: ${JSON.stringify(init)?.slice(0, 500)}`)
  const sess = await request('session/new', { cwd: WORKSPACE, mcpServers: [] })
  sessionId = sess?.sessionId
  log(`session/new ok: sessionId=${sessionId}`)
  const res = await request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'Reply with exactly: AGY_OK' }],
  })
  promptDone = true
  log(`session/prompt result: ${JSON.stringify(res)?.slice(0, 500)}`)
  log('PROBE_SUCCESS')
} catch (err) {
  log(`PROBE_FAILED ${err?.message || err}`)
} finally {
  clearTimeout(timeout)
  try { child.kill() } catch {}
  setTimeout(() => process.exit(promptDone ? 0 : 1), 500)
}

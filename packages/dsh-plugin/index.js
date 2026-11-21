import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'muse-agent-link'
// Same injection set dsh-im uses for host session control, plus webServer
// for this plugin's own channel routes. Never probe ctx.<service> without
// injecting it: this Cordis host throws on un-injected property access.
export const inject = ['webServer', 'connection', 'typertGateway']

export const VERSION = '0.4.0'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(DSH_HOME, 'muse-agent-link')
const STATE_PATH = path.join(STATE_DIR, 'state.json')
const JOBS_DIR = path.join(STATE_DIR, 'jobs')
const THREADS_PATH = path.join(STATE_DIR, 'threads.json')
const DEBUG_DIR = path.join(STATE_DIR, 'threads-debug')
const DEFAULT_WORKSPACE = path.join(STATE_DIR, 'workspace')

const MAX_CONCURRENT_JOBS = 2
const DEFAULT_TIMEOUT_SEC = 600
const PAIRING_TTL_MS = 30 * 60 * 1000
const RESULT_TAIL_CHARS = 4000
const APPROVAL_TTL_MS = 10 * 60 * 1000
const THREAD_EVENT_CAP = 500
const WAIT_SLICE_MS = 120000

// ---------- small utils ----------

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

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

// Unwrap a Typert RemoteResult defensively: { value } | { ok, value } | raw.
function unwrap(result) {
  if (result && typeof result === 'object') {
    if ('error' in result && result.error) {
      throw new Error(String(result.error?.message || result.error))
    }
    if ('value' in result) return result.value
  }
  return result
}

// Extract assistant text from history records / events of varying shapes.
function extractText(node, depth = 0) {
  if (!node || depth > 5) return ''
  if (typeof node === 'string') return ''
  if (Array.isArray(node)) return node.map((n) => extractText(n, depth + 1)).join('')
  if (typeof node !== 'object') return ''
  if (node.type === 'text' && typeof node.text === 'string') return node.text
  let out = ''
  for (const key of ['content', 'message', 'parts', 'records', 'items']) {
    if (node[key]) out += extractText(node[key], depth + 1)
  }
  return out
}

// ---------- pairing state ----------

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

function tokenMatches(state, token) {
  if (!state?.tokenHash || !token) return false
  const a = Buffer.from(sha256Hex(token), 'hex')
  const b = Buffer.from(state.tokenHash, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// ---------- headless jobs (fallback channel) ----------

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

// ---------- interactive threads (real host sessions via Typert gateway) ----------

const threads = new Map()
const threadsBySession = new Map()
const pendingApprovals = new Map()

function loadThreads() {
  try {
    const arr = JSON.parse(fs.readFileSync(THREADS_PATH, 'utf8'))
    for (const t of arr) {
      threads.set(t.id, { ...t, events: [], seq: 0, waitSeq: 0, waiting: false })
      threadsBySession.set(t.sessionId, t.id)
    }
  } catch {}
}

function saveThreads() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    const arr = [...threads.values()].map((t) => ({
      id: t.id,
      agent: t.agent || 'dsh',
      sessionId: t.sessionId,
      workspace: t.workspace,
      preset: t.preset || null,
      title: t.title || null,
      state: t.state,
      createdAt: t.createdAt,
      lastActivityAt: t.lastActivityAt,
      lastTurn: t.lastTurn || null,
    }))
    fs.writeFileSync(THREADS_PATH, JSON.stringify(arr, null, 2))
  } catch {}
}

function threadView(t) {
  return {
    id: t.id,
    agent: t.agent || 'dsh',
    sessionId: t.sessionId,
    workspace: t.workspace,
    preset: t.preset || null,
    title: t.title || null,
    state: t.state,
    createdAt: t.createdAt,
    lastActivityAt: t.lastActivityAt,
    lastTurn: t.lastTurn || null,
    pendingApprovals: [
      ...[...pendingApprovals.values()]
        .filter((p) => p.threadId === t.id)
        .map((p) => ({
          id: p.id,
          toolName: p.toolName,
          reason: p.reason || null,
          workspace: t.workspace,
          risk: p.risk || 'normal',
          expiresAt: p.expiresAt,
        })),
      ...[...agyPermissions.entries()]
        .filter(([, p]) => p.threadId === t.id)
        .map(([id, p]) => ({
          id,
          toolName: p.toolName,
          reason: null,
          workspace: t.workspace,
          risk: 'normal',
          expiresAt: null,
          agent: 'antigravity',
        })),
    ],
  }
}

function pushThreadEvent(t, type, payload) {
  t.seq += 1
  t.events.push({ seq: t.seq, type, at: new Date().toISOString(), payload })
  if (t.events.length > THREAD_EVENT_CAP) {
    t.events.splice(0, t.events.length - THREAD_EVENT_CAP)
  }
  t.lastActivityAt = new Date().toISOString()
}

function debugCapture(sessionId, event) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true })
    const file = path.join(DEBUG_DIR, `${sessionId}.jsonl`)
    const line = JSON.stringify(event) + '\n'
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0
    if (size < 512 * 1024) fs.appendFileSync(file, line)
  } catch {}
}


// ---------- Antigravity daemon client (loopback, same machine) ----------

const DAEMON_PORT = 47615
const DAEMON_TOKEN_PATH = path.join(STATE_DIR, 'daemon-token.txt')

function daemonToken() {
  try {
    return fs.readFileSync(DAEMON_TOKEN_PATH, 'utf8').trim()
  } catch {
    return null
  }
}

async function daemonCall(method, pathname, body) {
  const token = daemonToken()
  if (!token) throw new Error('daemon token not found (daemon not started yet)')
  const payload = body === undefined ? null : JSON.stringify(body)
  const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    body: payload,
    signal: AbortSignal.timeout(30 * 60 * 1000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error?.message || `daemon HTTP ${res.status}`)
  return data
}

// Pending Antigravity permission requests, mirrored from the daemon:
// permId -> { threadId, options, toolName }
const agyPermissions = new Map()

async function refreshAgyPermissions() {
  try {
    const data = await daemonCall('GET', '/permissions')
    const seen = new Set()
    for (const perm of data.permissions || []) {
      seen.add(perm.id)
      const threadId = threadsBySession.get(perm.sessionId)
      if (!threadId) continue
      if (!agyPermissions.has(perm.id)) {
        agyPermissions.set(perm.id, {
          threadId,
          options: perm.options || [],
          toolName: perm.toolCall?.title || perm.toolCall?.kind || 'tool',
        })
        const t = threads.get(threadId)
        if (t) {
          t.state = 'awaiting_approval'
          pushThreadEvent(t, 'approval.requested', {
            id: perm.id,
            toolName: agyPermissions.get(perm.id).toolName,
            reason: null,
            agent: 'antigravity',
          })
        }
      }
    }
    for (const id of [...agyPermissions.keys()]) {
      if (!seen.has(id)) agyPermissions.delete(id)
    }
  } catch {}
}

// ---------- plugin ----------

export function apply(ctx) {
  let state = ensureState()
  try {
    fs.mkdirSync(DEFAULT_WORKSPACE, { recursive: true })
  } catch {}
  loadThreads()

  let peer = null
  function getPeer() {
    if (!peer) {
      peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
    }
    return peer
  }

  async function gw(namespace, method, args) {
    const result = await ctx.typertGateway.invoke({ namespace, method, args, peer: getPeer() })
    return unwrap(result)
  }

  console.log(`[muse-agent-link] v${VERSION} loaded on ${state.machine} (paired=${state.paired})`)

  // ----- turn completion via session/wait -----

  async function waitForTurn(t) {
    if (t.waiting) return
    t.waiting = true
    try {
      for (;;) {
        const value = await gw('session', 'wait', {
          request: {
            sessionId: t.sessionId,
            timeoutMs: WAIT_SLICE_MS,
            ...(t.waitSeq ? { afterSeq: t.waitSeq } : {}),
            maxMessages: 20,
          },
        })
        const records = value?.output?.records ?? []
        for (const r of records) {
          if (Number.isSafeInteger(r?.seq) && r.seq > t.waitSeq) t.waitSeq = r.seq
        }
        if (value?.reason === 'timeout') {
          if (t.state !== 'running' && t.state !== 'awaiting_approval') break
          continue
        }
        const waitText = records.map((r) => extractText(r)).filter(Boolean).join('\n').trim()
        const text = waitText || (t.turnText || '').trim()
        if (value?.reason === 'idle') {
          t.state = 'active'
          t.lastTurn = {
            status: 'ok',
            finishedAt: new Date().toISOString(),
            resultText: (text || t.lastTurn?.resultText || '').slice(-RESULT_TAIL_CHARS),
          }
          pushThreadEvent(t, 'turn.finished', { status: 'ok', resultText: t.lastTurn.resultText })
        } else if (value?.reason === 'input-required') {
          t.state = 'awaiting_input'
          if (text) {
            t.lastTurn = {
              status: 'input-required',
              finishedAt: new Date().toISOString(),
              resultText: text.slice(-RESULT_TAIL_CHARS),
            }
          }
          pushThreadEvent(t, 'turn.input_required', { resultText: text.slice(-RESULT_TAIL_CHARS) })
        }
        saveThreads()
        break
      }
    } catch (err) {
      console.warn(`[muse-agent-link] wait failed for ${t.sessionId}:`, err?.message || err)
      if (t.state === 'running') t.state = 'active'
    } finally {
      t.waiting = false
    }
  }

  // ----- host event observation (state + approvals bookkeeping) -----

  if (typeof ctx.on === 'function') {
    try {
      ctx.on(
        'session/event',
        (session, event) => {
          const sessionId = session?.id ?? session?.sessionId
          if (typeof sessionId !== 'string' || !event) return
          const threadId = threadsBySession.get(sessionId)
          if (!threadId) return
          const t = threads.get(threadId)
          if (!t) return
          debugCapture(sessionId, event)
          if (Number.isSafeInteger(event.seq) && event.seq > (t.eventSeq || 0)) t.eventSeq = event.seq
          if (event.type === 'turn/start') {
            if (t.state !== 'awaiting_approval') t.state = 'running'
            t.turnText = ''
            pushThreadEvent(t, 'turn.started', { turn: event.data?.turn ?? null })
          } else if (event.type === 'assistant/message') {
            const text = extractText(event.data?.message ?? event.data)
            if (text) {
              t.turnText = (t.turnText || '') + text
              pushThreadEvent(t, 'output.delta', { text })
            }
          } else if (event.type === 'approval/asked') {
            pushThreadEvent(t, 'approval.asked', {
              id: event.data?.id ?? null,
              callId: event.data?.callId ?? null,
            })
          } else if (event.type === 'approval/decided') {
            pushThreadEvent(t, 'approval.decided', { id: event.data?.id ?? null })
          }
        },
        { global: true }
      )
    } catch (err) {
      console.warn('[muse-agent-link] session/event subscription failed:', err?.message || err)
    }

    // Competitive approvals for our own threads only; every other session
    // passes straight through to the native providers.
    try {
      ctx.on(
        'approval/request',
        (request, next) => {
          const session = request?.agent?.session
          const sessionId = session?.id ?? request?.agent?.id
          const threadId = typeof sessionId === 'string' ? threadsBySession.get(sessionId) : undefined
          if (!threadId) return next()
          const t = threads.get(threadId)
          if (!t) return next()

          let events = []
          try {
            events =
              typeof session?.snapshotEvents === 'function'
                ? session.snapshotEvents()
                : session?.events ?? []
          } catch {}
          const decided = new Set()
          let approvalId = null
          for (let i = events.length - 1; i >= 0; i--) {
            const e = events[i]
            if (e?.type === 'approval/decided') decided.add(e.data?.id)
            if (e?.type !== 'approval/asked') continue
            const id = e.data?.id
            if (!id || decided.has(id)) continue
            if ((request.callId ?? null) !== (e.data?.callId ?? null)) continue
            approvalId = id
            break
          }
          if (!approvalId) return next()

          return new Promise((resolve) => {
            const pending = {
              id: approvalId,
              threadId,
              toolName: request.toolName ?? null,
              reason: request.reason ?? null,
              risk: 'normal',
              expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
              settle: (outcome) => {
                if (!pendingApprovals.delete(approvalId)) return
                clearTimeout(timer)
                pushThreadEvent(t, 'approval.resolved', {
                  id: approvalId,
                  decision: outcome,
                  via: pending.via || 'controller',
                })
                if (t.state === 'awaiting_approval') t.state = 'running'
                saveThreads()
                resolve(outcome)
              },
              via: null,
            }
            const timer = setTimeout(() => {
              pending.via = 'expired'
              pending.settle('rejected')
            }, APPROVAL_TTL_MS)
            pendingApprovals.set(approvalId, pending)
            t.state = 'awaiting_approval'
            pushThreadEvent(t, 'approval.requested', {
              id: approvalId,
              toolName: pending.toolName,
              reason: pending.reason,
              expiresAt: pending.expiresAt,
            })
            saveThreads()
            // Native UI races us; first decision wins (same rule as dsh-im).
            Promise.resolve()
              .then(() => next())
              .then(
                (outcome) => {
                  if (outcome === 'allowed-once' || outcome === 'rejected') {
                    if (pendingApprovals.has(approvalId)) {
                      pending.via = 'local-ui'
                      pending.settle(outcome)
                    }
                  }
                },
                () => {}
              )
          })
        },
        { global: true, prepend: true }
      )
    } catch (err) {
      console.warn('[muse-agent-link] approval/request hook failed:', err?.message || err)
    }
  }

  // ----- http routes -----

  const routeDisposers = []
  const registerSafe = (spec) => {
    try {
      routeDisposers.push(ctx.webServer.register(spec))
    } catch (err) {
      if (!String(err?.message || err).includes('duplicate')) throw err
    }
  }

  async function dispatch(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    const sub = url.pathname.replace('/api/muse-agent-link', '')
    state = loadState() || state

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
      if (!state.paired && isLoopback(req)) {
        body.pairingCode = state.pairingCode
        body.pairingExpiresAt = state.pairingExpiresAt
      }
      sendJson(res, 200, body)
      return
    }

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

    // ----- threads -----

    if (sub === '/threads' && req.method === 'POST') {
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        sendError(res, 400, 'bad_request', 'Invalid JSON body.')
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
      if (body.agent === 'antigravity') {
        let conv
        try {
          const data = await daemonCall('POST', '/conversations', { cwd: workspace })
          conv = data.conversation
        } catch (err) {
          sendError(res, 502, 'daemon_unavailable', String(err?.message || err))
          return
        }
        const t = {
          id: crypto.randomUUID(),
          agent: 'antigravity',
          sessionId: conv.id,
          workspace,
          preset: null,
          title: null,
          state: 'active',
          createdAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          lastTurn: null,
          events: [],
          seq: 0,
          waitSeq: 0,
          eventSeq: 0,
          waiting: false,
          turnText: '',
        }
        threads.set(t.id, t)
        threadsBySession.set(t.sessionId, t.id)
        pushThreadEvent(t, 'thread.state', { state: 'active', sessionId: t.sessionId, agent: 'antigravity' })
        saveThreads()
        console.log(`[muse-agent-link] agy thread ${t.id} -> conversation ${t.sessionId}`)
        sendJson(res, 201, { ok: true, thread: threadView(t) })
        return
      }
      let sessionId
      try {
        const value = await gw('session', 'create', {
          request: {
            cwd: workspace,
            ...(body.preset ? { agentPreset: String(body.preset) } : {}),
          },
        })
        sessionId = typeof value?.sessionId === 'string' ? value.sessionId : String(value?.sessionId ?? '')
        if (!sessionId || sessionId === '[object Object]') {
          throw new Error(`create returned unusable value: ${JSON.stringify(value)?.slice(0, 200)}`)
        }
      } catch (err) {
        sendError(res, 500, 'session_create_failed', String(err?.message || err))
        return
      }
      const t = {
        id: crypto.randomUUID(),
        sessionId,
        workspace,
        preset: body.preset ? String(body.preset) : null,
        title: body.title ? String(body.title) : null,
        state: 'active',
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        lastTurn: null,
        events: [],
        seq: 0,
        waitSeq: 0,
        eventSeq: 0,
        waiting: false,
      }
      threads.set(t.id, t)
      threadsBySession.set(t.sessionId, t.id)
      // Give the session a recognisable title in the DSH UI (rename pins it).
      const stamp = new Date()
      const label =
        t.title ||
        `Muse 直连 · ${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')} ${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`
      try {
        const renamed = await gw('session', 'rename', { request: { sessionId, title: label } })
        if (renamed?.title) t.title = renamed.title
      } catch (err) {
        console.warn('[muse-agent-link] rename failed:', err?.message || err)
      }
      pushThreadEvent(t, 'thread.state', { state: 'active', sessionId: t.sessionId })
      saveThreads()
      console.log(`[muse-agent-link] thread ${t.id} -> session ${t.sessionId}`)
      sendJson(res, 201, { ok: true, thread: threadView(t) })
      return
    }

    if (sub === '/threads' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, threads: [...threads.values()].map(threadView) })
      return
    }

    if (sub === '/thread' && req.method === 'GET') {
      await refreshAgyPermissions()
      const t = threads.get(url.searchParams.get('id') || '')
      if (!t) {
        sendError(res, 404, 'thread_not_found', 'Thread not found.')
        return
      }
      sendJson(res, 200, { ok: true, thread: threadView(t) })
      return
    }

    if (sub === '/thread-message' && req.method === 'POST') {
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        sendError(res, 400, 'bad_request', 'Invalid JSON body.')
        return
      }
      const t = threads.get(String(body.threadId || url.searchParams.get('id') || ''))
      if (!t) {
        sendError(res, 404, 'thread_not_found', 'Thread not found.')
        return
      }
      if (!body.text || typeof body.text !== 'string') {
        sendError(res, 400, 'bad_request', 'text is required.')
        return
      }
      if (t.agent === 'antigravity') {
        t.state = 'running'
        t.lastActivityAt = new Date().toISOString()
        saveThreads()
        void (async () => {
          try {
            const data = await daemonCall('POST', `/conversations/${t.sessionId}/prompt`, { text: body.text })
            const conv = data.conversation || {}
            t.lastTurn = conv.lastTurn || { status: 'ok', finishedAt: new Date().toISOString(), resultText: '' }
            if (conv.title) t.title = conv.title
            pushThreadEvent(t, 'turn.finished', { status: t.lastTurn.status, resultText: t.lastTurn.resultText || '' })
          } catch (err) {
            t.lastTurn = { status: 'failed', finishedAt: new Date().toISOString(), resultText: '', error: String(err?.message || err) }
            pushThreadEvent(t, 'turn.finished', { status: 'failed', error: t.lastTurn.error })
          } finally {
            if (t.state === 'running') t.state = 'active'
            saveThreads()
          }
        })()
        sendJson(res, 202, { ok: true, thread: threadView(t) })
        return
      }
      const mode = body.mode === 'steer' ? 'steer' : 'queue'
      try {
        await gw('session', 'prompt', {
          request: {
            requestId: crypto.randomUUID(),
            sessionId: t.sessionId,
            mode,
            content: [{ type: 'text', text: body.text }],
            clientTimeZone: 'Asia/Shanghai',
          },
        })
      } catch (err) {
        sendError(res, 502, 'prompt_failed', String(err?.message || err))
        return
      }
      t.state = 'running'
      t.lastActivityAt = new Date().toISOString()
      saveThreads()
      void waitForTurn(t)
      sendJson(res, 202, { ok: true, thread: threadView(t) })
      return
    }

    if (sub === '/thread-stop' && req.method === 'POST') {
      const t = threads.get(url.searchParams.get('id') || '')
      if (!t) {
        sendError(res, 404, 'thread_not_found', 'Thread not found.')
        return
      }
      if (t.agent === 'antigravity') {
        try {
          await daemonCall('POST', `/conversations/${t.sessionId}/cancel`)
        } catch (err) {
          sendError(res, 502, 'daemon_unavailable', String(err?.message || err))
          return
        }
        sendJson(res, 200, { ok: true, thread: threadView(t) })
        return
      }
      try {
        await gw('session', 'cancel', { request: { sessionId: t.sessionId } })
      } catch (err) {
        sendError(res, 502, 'cancel_failed', String(err?.message || err))
        return
      }
      sendJson(res, 200, { ok: true, thread: threadView(t) })
      return
    }

    if (sub === '/thread-events' && req.method === 'GET') {
      const t = threads.get(url.searchParams.get('id') || '')
      if (!t) {
        sendError(res, 404, 'thread_not_found', 'Thread not found.')
        return
      }
      const cursor = Number(url.searchParams.get('cursor') || 0)
      sendJson(res, 200, {
        ok: true,
        cursor: t.seq,
        events: t.events.filter((e) => e.seq > cursor),
      })
      return
    }

    if (sub === '/approvals' && req.method === 'POST') {
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        sendError(res, 400, 'bad_request', 'Invalid JSON body.')
        return
      }
      const id = String(body.id || url.searchParams.get('id') || '')
      const agyPerm = agyPermissions.get(id)
      if (agyPerm) {
        const kinds =
          body.decision === 'approve_once'
            ? ['allow_once', 'allow_always']
            : ['reject_once', 'reject_always']
        const option =
          agyPerm.options.find((o) => kinds.includes(o.kind)) || agyPerm.options[0]
        if (!option) {
          sendError(res, 400, 'bad_request', 'No option available for this permission.')
          return
        }
        try {
          await daemonCall('POST', `/permissions/${id}`, { optionId: option.optionId })
        } catch (err) {
          sendError(res, 502, 'daemon_unavailable', String(err?.message || err))
          return
        }
        agyPermissions.delete(id)
        const t = threads.get(agyPerm.threadId)
        if (t) {
          pushThreadEvent(t, 'approval.resolved', { id, decision: body.decision, via: 'controller', agent: 'antigravity' })
          if (t.state === 'awaiting_approval') t.state = 'running'
          saveThreads()
        }
        sendJson(res, 200, { ok: true, id, decision: body.decision, optionId: option.optionId })
        return
      }
      const pending = pendingApprovals.get(id)
      if (!pending) {
        sendError(res, 410, 'approval_expired', 'Approval is no longer pending.')
        return
      }
      const outcome = body.decision === 'approve_once' ? 'allowed-once' : 'rejected'
      pending.via = 'controller'
      pending.settle(outcome)
      sendJson(res, 200, { ok: true, id, decision: outcome })
      return
    }

    // ----- headless jobs (fallback) -----

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
    '/api/muse-agent-link/threads',
    '/api/muse-agent-link/thread',
    '/api/muse-agent-link/thread-message',
    '/api/muse-agent-link/thread-stop',
    '/api/muse-agent-link/thread-events',
    '/api/muse-agent-link/approvals',
  ]) {
    registerSafe({ kind: 'exact', path: p, handler: dispatch })
  }

  ctx.on('dispose', () => {
    for (const d of routeDisposers) {
      try {
        if (typeof d === 'function') d()
      } catch {}
    }
    try {
      peer?.dispose?.()
    } catch {}
  })
}

// Muse Agent Link v2 — Thin DSH Runtime Adapter (Cordis Plugin)
// No longer binds Tailscale :47616! The standalone muse-hub.mjs owns :47616 so
// Antigravity Desktop and DSH are completely fault-isolated.
// This plugin:
//   1. Runs a loopback-only RPC server (127.0.0.1:<ephemeral>) authenticated via hub-internal-token.txt.
//   2. Registers with Muse Hub (127.0.0.1:47617) every 10s and hydrates bound DSH sessions.
//   3. Streams DSH session/event & competitive approval/request to Muse Hub.
//   4. Proxies exact local admin routes (/api/muse-agent-link/admin-*) for client.js.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

export const name = 'muse-agent-link'
export const inject = ['webServer', 'connection', 'typertGateway']
export const VERSION = '2.0.0'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(DSH_HOME, 'muse-agent-link')
const INTERNAL_TOKEN_PATH = path.join(STATE_DIR, 'hub-internal-token.txt')
const HUB_ADMIN_URL = process.env.MUSE_HUB_ADMIN_URL || 'http://127.0.0.1:47617'

const APPROVAL_TTL_MS = 10 * 60 * 1000
const WAIT_SLICE_MS = 120_000
const RESULT_TAIL_CHARS = 12_000
const PROGRESS_THROTTLE_MS = 2500

function readInternalToken() {
  try {
    return fs.readFileSync(INTERNAL_TOKEN_PATH, 'utf8').trim()
  } catch {
    return ''
  }
}

function tokenEquals(given, expected) {
  if (!given || !expected || given.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}

function sendJson(res, code, obj) {
  if (res.writableEnded) return
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
    if (size > 2 * 1024 * 1024) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function isLoopback(req) {
  const addr = req.socket?.remoteAddress || ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function unwrap(result) {
  if (result && typeof result === 'object') {
    if ('error' in result && result.error) {
      throw new Error(String(result.error?.message || result.error))
    }
    if ('value' in result) return result.value
  }
  return result
}

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

function mimeFromExt(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase()
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
  }
  return map[ext] || 'application/octet-stream'
}

const ARTIFACT_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg',
  '.pdf', '.html', '.md', '.txt', '.csv', '.json',
  '.xlsx', '.docx', '.pptx', '.zip',
])
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__', 'dist', '.cache'])

function collectTurnArtifacts(cwd, resultText, sinceMs) {
  const found = new Map() // realPath -> { path, name, mime, mtimeMs }
  const maxBytes = 10 * 1024 * 1024
  const cutoff = (sinceMs || Date.now()) - 1500

  function tryAdd(filePath) {
    try {
      const resolved = path.resolve(filePath)
      if (!fs.existsSync(resolved)) return
      const st = fs.statSync(resolved)
      if (!st.isFile() || st.size <= 0 || st.size > maxBytes) return
      if (st.mtimeMs < cutoff) return
      const ext = path.extname(resolved).toLowerCase()
      if (!ARTIFACT_EXTS.has(ext)) return
      const real = fs.realpathSync(resolved)
      if (!found.has(real)) {
        found.set(real, {
          path: real,
          name: path.basename(real),
          mime: mimeFromExt(real),
          mtimeMs: st.mtimeMs,
        })
      }
    } catch {}
  }

  // 1. Scan workspace up to depth 2 for files modified/created during this turn
  if (cwd && fs.existsSync(cwd)) {
    let scanned = 0
    function walk(dir, depth) {
      if (depth > 2 || scanned > 200) return
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (scanned > 200) break
        scanned += 1
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full, depth + 1)
        } else if (e.isFile()) {
          tryAdd(full)
        }
      }
    }
    walk(cwd, 0)
  }

  // 2. Extract explicit file:/// or Windows absolute paths mentioned in reply text
  const text = String(resultText || '')
  const fileUriRe = /file:\/\/\/([A-Za-z]:\/[^\s)"'`<>#?]+)/g
  let m
  while ((m = fileUriRe.exec(text)) !== null) {
    tryAdd(decodeURIComponent(m[1]))
  }
  const winPathRe = /([A-Za-z]:\\[^\s"'`<>|*?]+?\.(?:png|jpg|jpeg|webp|gif|svg|pdf|html|md|txt|csv|json|xlsx|docx|pptx|zip))/gi
  while ((m = winPathRe.exec(text)) !== null) {
    tryAdd(m[1])
  }

  return [...found.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 10)
    .map(({ mtimeMs, ...rest }) => rest)
}

function scanLocalDshSessions(limit = 25) {
  const sessionsDir = path.join(DSH_HOME, 'sessions')
  const items = []
  try {
    for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      const full = path.join(sessionsDir, entry.name)
      const st = fs.statSync(full)
      const sessionId = entry.isFile() ? entry.name.replace(/\.json$/i, '') : entry.name
      if (!sessionId || sessionId.startsWith('.')) continue
      items.push({
        agent: 'dsh',
        localSessionId: sessionId,
        updatedAt: new Date(st.mtimeMs).toISOString(),
        mtimeMs: st.mtimeMs,
      })
    }
  } catch {}
  items.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return items.slice(0, limit).map(({ mtimeMs, ...rest }) => rest)
}

export function apply(ctx) {
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

  // sessionId -> { threadId, ownerAccountId, approvalPolicy, waiting, waitSeq, turnText, lastProgressAt, currentTurnId }
  const boundSessions = new Map()
  // approvalId -> { id, sessionId, threadId, settle, via }
  const pendingApprovals = new Map()

  async function hubPost(pathname, body) {
    const tok = readInternalToken()
    if (!tok) return null
    try {
      const res = await fetch(`${HUB_ADMIN_URL}${pathname}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-internal-token': tok,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
      return await res.json().catch(() => null)
    } catch {
      return null
    }
  }

  function pushHubEvent(entry, type, payload = {}) {
    void hubPost('/internal/events', {
      type,
      sessionId: entry.sessionId,
      threadId: entry.threadId,
      payload,
    })
  }

  function upsertBoundSession({ threadId, sessionId, ownerAccountId, approvalPolicy, cwd }) {
    if (!sessionId) return null
    const existing = boundSessions.get(sessionId)
    if (existing) {
      if (threadId) existing.threadId = threadId
      if (ownerAccountId) existing.ownerAccountId = ownerAccountId
      if (approvalPolicy) existing.approvalPolicy = approvalPolicy
      if (cwd) existing.cwd = cwd
      return existing
    }
    const entry = {
      sessionId,
      threadId: threadId || null,
      ownerAccountId: ownerAccountId || null,
      approvalPolicy: approvalPolicy || 'remote_or_local',
      cwd: cwd || path.join(STATE_DIR, 'workspace'),
      waiting: false,
      waitSeq: 0,
      turnText: '',
      turnStartedAt: Date.now(),
      lastProgressAt: 0,
      currentTurnId: null,
    }
    boundSessions.set(sessionId, entry)
    return entry
  }

  async function waitForTurn(entry, turnId) {
    if (entry.waiting) return
    entry.waiting = true
    entry.turnStartedAt = Date.now()
    entry.currentTurnId = turnId || entry.currentTurnId
    try {
      for (;;) {
        const value = await gw('session', 'wait', {
          request: {
            sessionId: entry.sessionId,
            timeoutMs: WAIT_SLICE_MS,
            ...(entry.waitSeq ? { afterSeq: entry.waitSeq } : {}),
            maxMessages: 20,
          },
        })
        const records = value?.output?.records ?? []
        for (const r of records) {
          if (Number.isSafeInteger(r?.seq) && r.seq > entry.waitSeq) entry.waitSeq = r.seq
        }
        if (value?.reason === 'timeout') {
          continue
        }
        const waitText = records.map((r) => extractText(r)).filter(Boolean).join('\n').trim()
        const text = (waitText || entry.turnText || '').trim().slice(-RESULT_TAIL_CHARS)
        if (value?.reason === 'idle') {
          const artifacts = collectTurnArtifacts(entry.cwd, text, entry.turnStartedAt)
          pushHubEvent(entry, 'turn.finished', {
            turnId: entry.currentTurnId,
            status: 'ok',
            resultText: text,
            ...(artifacts.length > 0 ? { artifacts } : {}),
          })
        } else if (value?.reason === 'input-required') {
          pushHubEvent(entry, 'turn.input_required', {
            turnId: entry.currentTurnId,
            resultText: text,
          })
        }
        break
      }
    } catch (err) {
      pushHubEvent(entry, 'turn.finished', {
        turnId: entry.currentTurnId,
        status: 'failed',
        resultText: '',
        error: String(err?.message || err),
      })
    } finally {
      entry.waiting = false
    }
  }

  // ---------- Host event subscription ----------

  if (typeof ctx.on === 'function') {
    try {
      ctx.on(
        'session/event',
        (session, event) => {
          const sessionId = session?.id ?? session?.sessionId
          if (typeof sessionId !== 'string' || !event) return
          const entry = boundSessions.get(sessionId)
          if (!entry) return

          if (event.type === 'turn/start') {
            entry.turnText = ''
            pushHubEvent(entry, 'turn.started', {
              turnId: entry.currentTurnId,
              source: entry.waiting ? 'muse' : 'local_ui',
            })
            // If user started a turn locally inside DSH desktop UI, also wait for completion!
            if (!entry.waiting) {
              void waitForTurn(entry, `local_${Date.now().toString(36)}`)
            }
          } else if (event.type === 'user/message') {
            const text = extractText(event.data?.message ?? event.data)
            if (text && text.trim()) {
              pushHubEvent(entry, 'user.message', { text })
            }
          } else if (event.type === 'assistant/message') {
            const text = extractText(event.data?.message ?? event.data)
            if (text) {
              entry.turnText = (entry.turnText || '') + text
              const now = Date.now()
              if (now - entry.lastProgressAt >= PROGRESS_THROTTLE_MS) {
                entry.lastProgressAt = now
                pushHubEvent(entry, 'output.progress', {
                  turnId: entry.currentTurnId,
                  deltaTail: entry.turnText.slice(-300),
                })
              }
            }
          }
        },
        { global: true }
      )
    } catch (err) {
      console.warn('[muse-agent-link] session/event subscription failed:', err?.message || err)
    }

    // Competitive approval hook gated by account approvalPolicy
    try {
      ctx.on(
        'approval/request',
        (request, next) => {
          const session = request?.agent?.session
          const sessionId = session?.id ?? request?.agent?.id
          const entry = typeof sessionId === 'string' ? boundSessions.get(sessionId) : undefined
          if (!entry) return next()

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

          const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString()

          // Collaborator or local_only policy: notify Hub for visibility, NEVER allow remote approve
          if (entry.approvalPolicy === 'local_only') {
            pushHubEvent(entry, 'approval.requested', {
              id: approvalId,
              toolName: request.toolName ?? 'tool',
              reason: request.reason ?? null,
              expiresAt,
              canRemoteApprove: false,
            })
            return Promise.resolve()
              .then(() => next())
              .then((outcome) => {
                pushHubEvent(entry, 'approval.resolved', {
                  id: approvalId,
                  decision: outcome,
                  via: 'local-ui',
                })
                return outcome
              })
          }

          // Owner competitive race: first decision (remote Muse OR local DSH UI) wins
          return new Promise((resolve) => {
            const pending = {
              id: approvalId,
              sessionId,
              threadId: entry.threadId,
              via: null,
              settle: (outcome) => {
                if (!pendingApprovals.delete(approvalId)) return
                clearTimeout(timer)
                pushHubEvent(entry, 'approval.resolved', {
                  id: approvalId,
                  decision: outcome,
                  via: pending.via || 'controller',
                })
                resolve(outcome)
              },
            }
            const timer = setTimeout(() => {
              pending.via = 'expired'
              pending.settle('rejected')
            }, APPROVAL_TTL_MS)
            pendingApprovals.set(approvalId, pending)
            pushHubEvent(entry, 'approval.requested', {
              id: approvalId,
              toolName: request.toolName ?? 'tool',
              reason: request.reason ?? null,
              expiresAt,
              canRemoteApprove: true,
            })
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

  // ---------- Loopback RPC server for Muse Hub -> DSH ----------

  let rpcBaseUrl = null
  const rpcServer = createServer(async (req, res) => {
    try {
      const expected = readInternalToken()
      const given = String(req.headers['x-hub-internal-token'] || '')
      if (!tokenEquals(given, expected)) {
        sendError(res, 401, 'unauthorized', 'Invalid internal token.')
        return
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const body = req.method === 'POST' ? await readJsonBody(req) : {}

      if (url.pathname === '/rpc/session/create' && req.method === 'POST') {
        const value = await gw('session', 'create', {
          request: {
            cwd: String(body.cwd || path.join(STATE_DIR, 'workspace')),
            ...(body.preset ? { agentPreset: String(body.preset) } : {}),
          },
        })
        const sessionId = typeof value?.sessionId === 'string' ? value.sessionId : String(value?.sessionId ?? '')
        if (!sessionId || sessionId === '[object Object]') {
          sendError(res, 500, 'internal', 'DSH session create returned invalid sessionId')
          return
        }
        let title = body.title || null
        if (title) {
          try {
            const renamed = await gw('session', 'rename', { request: { sessionId, title: String(title) } })
            if (renamed?.title) title = renamed.title
          } catch {}
        }
        sendJson(res, 200, { ok: true, sessionId, title })
        return
      }

      if (url.pathname === '/rpc/binding/sync' && req.method === 'POST') {
        upsertBoundSession(body)
        sendJson(res, 200, { ok: true })
        return
      }

      if (url.pathname === '/rpc/session/prompt' && req.method === 'POST') {
        const entry = upsertBoundSession(body)
        const mode = body.mode === 'steer' ? 'steer' : 'queue'
        await gw('session', 'prompt', {
          request: {
            requestId: crypto.randomUUID(),
            sessionId: entry.sessionId,
            mode,
            content: [{ type: 'text', text: String(body.text || '') }],
            clientTimeZone: 'Asia/Shanghai',
          },
        })
        void waitForTurn(entry, body.turnId)
        sendJson(res, 202, { ok: true })
        return
      }

      if (url.pathname === '/rpc/session/cancel' && req.method === 'POST') {
        await gw('session', 'cancel', { request: { sessionId: String(body.sessionId || '') } })
        sendJson(res, 200, { ok: true })
        return
      }

      if (url.pathname === '/rpc/session/list' && req.method === 'POST') {
        let sessions = []
        try {
          const listed = await gw('session', 'list', { request: {} })
          const rawList = listed?.sessions || listed?.items || (Array.isArray(listed) ? listed : [])
          sessions = rawList.slice(0, Number(body.limit) || 25).map((s) => ({
            agent: 'dsh',
            localSessionId: s.sessionId || s.id,
            title: s.title || null,
            cwd: s.cwd || null,
            updatedAt: s.updatedAt || s.lastActivityAt || null,
          }))
        } catch {
          sessions = scanLocalDshSessions(Number(body.limit) || 25)
        }
        sendJson(res, 200, { ok: true, sessions })
        return
      }

      if (url.pathname === '/rpc/approval/decide' && req.method === 'POST') {
        const pending = pendingApprovals.get(String(body.id || ''))
        if (!pending) {
          sendError(res, 410, 'approval_expired', 'Approval is no longer pending.')
          return
        }
        const outcome = body.decision === 'approve_once' ? 'allowed-once' : 'rejected'
        pending.via = 'controller'
        pending.settle(outcome)
        sendJson(res, 200, { ok: true, decision: outcome })
        return
      }

      sendError(res, 404, 'not_found', `Unknown RPC ${url.pathname}`)
    } catch (err) {
      sendError(res, 500, 'internal', String(err?.message || err))
    }
  })

  let lastAutoLaunchMs = 0
  function maybeAutoLaunchHub() {
    const now = Date.now()
    if (now - lastAutoLaunchMs < 30_000) return
    lastAutoLaunchMs = now
    const vbsPath = path.join(STATE_DIR, 'run-hub-hidden.vbs')
    const hubPath = path.join(STATE_DIR, 'muse-hub.mjs')
    try {
      let child = null
      if (process.platform === 'win32' && fs.existsSync(vbsPath)) {
        child = spawn('wscript.exe', [vbsPath], { detached: true, stdio: 'ignore', windowsHide: true })
      } else if (fs.existsSync(hubPath)) {
        child = spawn(process.execPath, [hubPath], { detached: true, stdio: 'ignore', windowsHide: true })
      }
      child?.unref?.()
    } catch {}
  }

  async function registerWithHub() {
    if (!rpcBaseUrl) return
    const resp = await hubPost('/internal/adapters/dsh/register', {
      rpcBaseUrl,
      version: VERSION,
      pid: process.pid,
    })
    if (!resp) {
      maybeAutoLaunchHub()
      return
    }
    if (Array.isArray(resp.bindings)) {
      for (const b of resp.bindings) {
        upsertBoundSession(b)
      }
    }
  }

  let heartbeatTimer = null
  rpcServer.listen(0, '127.0.0.1', () => {
    const addr = rpcServer.address()
    if (addr && typeof addr === 'object') {
      rpcBaseUrl = `http://127.0.0.1:${addr.port}`
      console.log(`[muse-agent-link] v${VERSION} thin DSH adapter listening on ${rpcBaseUrl}`)
      void registerWithHub()
      heartbeatTimer = setInterval(() => void registerWithHub(), 10_000)
      heartbeatTimer.unref?.()
    }
  })

  // ---------- Same-origin exact admin proxy routes for client.js ----------

  async function proxyToHub(req, res, targetPath, methodOverride = null) {
    if (!isLoopback(req)) {
      sendError(res, 403, 'forbidden_source', 'Loopback UI only.')
      return
    }
    try {
      const method = methodOverride || req.method
      const body = method === 'POST' || method === 'PATCH' ? await readJsonBody(req) : undefined
      const upstream = await fetch(`${HUB_ADMIN_URL}${targetPath}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      })
      const text = await upstream.text()
      res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(text)
    } catch (err) {
      sendError(res, 503, 'hub_offline', `Muse Hub offline (${err?.message || err})`)
    }
  }

  const routeDisposers = []
  const registerSafe = (spec) => {
    try {
      routeDisposers.push(ctx.webServer.register(spec))
    } catch (err) {
      if (!String(err?.message || err).includes('duplicate')) throw err
    }
  }

  registerSafe({
    kind: 'exact',
    path: '/api/muse-agent-link/status',
    handler: (req, res) => proxyToHub(req, res, '/v2/status', 'GET'),
  })
  registerSafe({
    kind: 'exact',
    path: '/api/muse-agent-link/admin-overview',
    handler: (req, res) => proxyToHub(req, res, '/admin/overview', 'GET'),
  })
  registerSafe({
    kind: 'exact',
    path: '/api/muse-agent-link/admin-ticket',
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      if (req.method === 'DELETE') {
        const id = url.searchParams.get('id') || ''
        return proxyToHub(req, res, `/admin/pairing-tickets/${encodeURIComponent(id)}`, 'DELETE')
      }
      return proxyToHub(req, res, '/admin/pairing-tickets', 'POST')
    },
  })
  registerSafe({
    kind: 'exact',
    path: '/api/muse-agent-link/admin-revoke',
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      const id = url.searchParams.get('id') || ''
      return proxyToHub(req, res, `/admin/accounts/${encodeURIComponent(id)}/revoke`, 'POST')
    },
  })
  registerSafe({
    kind: 'exact',
    path: '/api/muse-agent-link/admin-local-sessions',
    handler: (req, res) => proxyToHub(req, res, '/admin/local-sessions', 'GET'),
  })
  registerSafe({
    kind: 'exact',
    path: '/api/muse-agent-link/admin-attach',
    handler: (req, res) => proxyToHub(req, res, '/admin/attach', 'POST'),
  })
  registerSafe({
    kind: 'exact',
    path: '/api/muse-agent-link/admin-funnel-enable',
    handler: (req, res) => proxyToHub(req, res, '/admin/funnel/enable', 'POST'),
  })
  registerSafe({
    kind: 'exact',
    path: '/api/muse-agent-link/admin-funnel-disable',
    handler: (req, res) => proxyToHub(req, res, '/admin/funnel/disable', 'POST'),
  })

  ctx.on('dispose', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    try { rpcServer.close() } catch {}
    for (const d of routeDisposers) {
      try { if (typeof d === 'function') d() } catch {}
    }
    try { peer?.dispose?.() } catch {}
  })
}

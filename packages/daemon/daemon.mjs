// Muse Agent Link daemon for Antigravity (office-workstation).
//
// Runs inside the interactive desktop session (agy can only read its auth
// there), hosts ONE `agy acp` process, and exposes a loopback-only HTTP API
// that the DSH plugin proxies to. Conversations created here are real
// Antigravity conversations, visible in the Antigravity app.
//
// API (Authorization: Bearer <daemon token from daemon-token.txt>):
//   GET  /status
//   GET  /conversations
//   POST /conversations { cwd }                  -> { conversation }
//   GET  /conversations/:id
//   POST /conversations/:id/prompt { text }      -> blocks until turn end
//   POST /conversations/:id/cancel
//   GET  /permissions                            -> pending permission requests
//   POST /permissions/:id { optionId }           -> decide
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const VERSION = '0.1.0'
const PORT = 47615
const HOST = '127.0.0.1'
const STATE_DIR = path.join(os.homedir(), '.dsh', 'muse-agent-link')
const TOKEN_PATH = path.join(STATE_DIR, 'daemon-token.txt')
const INDEX_PATH = path.join(STATE_DIR, 'agy-conversations.json')
const LOG_PATH = path.join(STATE_DIR, 'daemon.log')
const AGY = path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe')

function log(line) {
  const msg = `${new Date().toISOString()} ${line}\n`
  try {
    fs.appendFileSync(LOG_PATH, msg)
  } catch {}
  process.stdout.write(msg)
}

function ensureToken() {
  try {
    const t = fs.readFileSync(TOKEN_PATH, 'utf8').trim()
    if (t) return t
  } catch {}
  const t = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(TOKEN_PATH, t)
  return t
}
const TOKEN = ensureToken()

function tokenOk(req) {
  const auth = String(req.headers['authorization'] || '')
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!given || given.length !== TOKEN.length) return false
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN))
}

// ---------- conversation index (persisted) ----------

function loadIndex() {
  try {
    return new Map(JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')).map((c) => [c.id, c]))
  } catch {
    return new Map()
  }
}
const conversations = loadIndex()
function saveIndex() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(INDEX_PATH, JSON.stringify([...conversations.values()], null, 2))
  } catch {}
}

// ---------- agy ACP process ----------

let acp = null // { child, nextId, pending: Map, buffer }
const loadedSessions = new Set()
const turnCollectors = new Map() // sessionId -> { text, resolve }
const pendingPermissions = new Map() // permId -> { sessionId, options, rpcId, createdAt }

function startAcp() {
  const child = spawn(AGY, ['acp'], { cwd: os.homedir(), windowsHide: true })
  const proc = { child, nextId: 1, pending: new Map(), buffer: '' }
  acp = proc
  loadedSessions.clear()
  child.stdout.on('data', (d) => {
    proc.buffer += d.toString()
    let idx
    while ((idx = proc.buffer.indexOf('\n')) >= 0) {
      const line = proc.buffer.slice(0, idx).trim()
      proc.buffer = proc.buffer.slice(idx + 1)
      if (line) handleAcpMessage(proc, line)
    }
  })
  child.stderr.on('data', (d) => log(`agy stderr: ${d.toString().slice(0, 300)}`))
  child.on('error', (e) => log(`agy spawn error: ${e.message}`))
  child.on('close', (code) => {
    log(`agy exited (${code}); will restart on next request`)
    for (const p of proc.pending.values()) p.reject(new Error('agy exited'))
    proc.pending.clear()
    if (acp === proc) acp = null
  })
  log('agy acp started')
  return proc
}

async function ensureAcp() {
  if (!acp) {
    const proc = startAcp()
    await acpRequest(proc, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'muse-agent-link-daemon', version: VERSION },
    })
    log('agy initialize ok')
  }
  return acp
}

function acpSend(proc, obj) {
  proc.child.stdin.write(JSON.stringify(obj) + '\n')
}

function acpRequest(proc, method, params) {
  const id = proc.nextId++
  return new Promise((resolve, reject) => {
    proc.pending.set(id, { resolve, reject })
    acpSend(proc, { jsonrpc: '2.0', id, method, params })
  })
}

function handleAcpMessage(proc, line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id !== undefined && proc.pending.has(msg.id)) {
    const p = proc.pending.get(msg.id)
    proc.pending.delete(msg.id)
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error).slice(0, 400)))
    else p.resolve(msg.result)
    return
  }
  if (msg.method === 'session/update') {
    const { sessionId, update } = msg.params || {}
    const conv = conversations.get(sessionId)
    if (conv && update?.sessionUpdate === 'session_info_update' && update.title) {
      conv.title = update.title
      saveIndex()
    }
    const collector = turnCollectors.get(sessionId)
    if (collector && update?.sessionUpdate === 'agent_message_chunk') {
      const text = update.content?.type === 'text' ? update.content.text : ''
      if (text) collector.text += text
    }
    return
  }
  if (msg.method && msg.id !== undefined) {
    // Agent -> client request. Permission requests are held for the
    // controller (via the DSH plugin) to decide; anything else gets a
    // minimal refusal so the agent is never blocked on us.
    if (msg.method === 'session/request_permission') {
      const permId = crypto.randomUUID()
      pendingPermissions.set(permId, {
        id: permId,
        sessionId: msg.params?.sessionId || null,
        toolCall: msg.params?.toolCall || null,
        options: msg.params?.options || [],
        rpcId: msg.id,
        proc,
        createdAt: new Date().toISOString(),
      })
      log(`permission requested ${permId} for session ${msg.params?.sessionId}`)
      return
    }
    acpSend(proc, {
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `unsupported client method: ${msg.method}` },
    })
  }
}

async function ensureSessionLoaded(conv) {
  const proc = await ensureAcp()
  if (loadedSessions.has(conv.id)) return proc
  try {
    await acpRequest(proc, 'session/load', {
      sessionId: conv.id,
      cwd: conv.cwd,
      mcpServers: [],
    })
  } catch {
    // A brand-new conversation is already live in its creating process; after
    // a daemon/agy restart, load is the path. If load fails, surface it.
    if (conv.fresh) {
      conv.fresh = false
    } else {
      throw new Error(`session/load failed for ${conv.id}`)
    }
  }
  loadedSessions.add(conv.id)
  return proc
}

// ---------- http api ----------

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function convView(c) {
  return {
    id: c.id,
    cwd: c.cwd,
    title: c.title || null,
    createdAt: c.createdAt,
    lastTurn: c.lastTurn || null,
    busy: turnCollectors.has(c.id),
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)
  try {
    if (url.pathname === '/status' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        daemon: 'muse-agent-link',
        version: VERSION,
        machine: os.hostname(),
        acpRunning: Boolean(acp),
        conversations: conversations.size,
        time: new Date().toISOString(),
      })
      return
    }
    if (!tokenOk(req)) {
      sendJson(res, 401, { error: { code: 'unauthorized', message: 'bad daemon token' } })
      return
    }

    if (url.pathname === '/conversations' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, conversations: [...conversations.values()].map(convView) })
      return
    }

    if (url.pathname === '/conversations' && req.method === 'POST') {
      const body = await readBody(req)
      const cwd = body.cwd ? path.resolve(String(body.cwd)) : path.join(STATE_DIR, 'workspace')
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        sendJson(res, 400, { error: { code: 'cwd_not_found', message: `cwd does not exist: ${cwd}` } })
        return
      }
      const proc = await ensureAcp()
      const result = await acpRequest(proc, 'session/new', { cwd, mcpServers: [] })
      const id = result?.sessionId
      if (!id) throw new Error('session/new returned no sessionId')
      const conv = { id, cwd, title: null, createdAt: new Date().toISOString(), lastTurn: null, fresh: true }
      conversations.set(id, conv)
      loadedSessions.add(id)
      saveIndex()
      log(`conversation created ${id} in ${cwd}`)
      sendJson(res, 201, { ok: true, conversation: convView(conv) })
      return
    }

    if (parts[0] === 'conversations' && parts[1] && parts.length === 2 && req.method === 'GET') {
      const conv = conversations.get(parts[1])
      if (!conv) {
        sendJson(res, 404, { error: { code: 'not_found', message: 'conversation not found' } })
        return
      }
      sendJson(res, 200, { ok: true, conversation: convView(conv) })
      return
    }

    if (parts[0] === 'conversations' && parts[2] === 'prompt' && req.method === 'POST') {
      const conv = conversations.get(parts[1])
      if (!conv) {
        sendJson(res, 404, { error: { code: 'not_found', message: 'conversation not found' } })
        return
      }
      if (turnCollectors.has(conv.id)) {
        sendJson(res, 409, { error: { code: 'busy', message: 'a turn is already running' } })
        return
      }
      const body = await readBody(req)
      if (!body.text || typeof body.text !== 'string') {
        sendJson(res, 400, { error: { code: 'bad_request', message: 'text is required' } })
        return
      }
      const proc = await ensureSessionLoaded(conv)
      const collector = { text: '' }
      turnCollectors.set(conv.id, collector)
      try {
        const result = await acpRequest(proc, 'session/prompt', {
          sessionId: conv.id,
          prompt: [{ type: 'text', text: body.text }],
        })
        conv.lastTurn = {
          status: 'ok',
          stopReason: result?.stopReason || null,
          finishedAt: new Date().toISOString(),
          resultText: collector.text.trim().slice(-4000),
        }
      } catch (err) {
        conv.lastTurn = {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          resultText: '',
          error: String(err?.message || err),
        }
      } finally {
        turnCollectors.delete(conv.id)
        saveIndex()
      }
      sendJson(res, 200, { ok: true, conversation: convView(conv) })
      return
    }

    if (parts[0] === 'conversations' && parts[2] === 'cancel' && req.method === 'POST') {
      const conv = conversations.get(parts[1])
      if (!conv) {
        sendJson(res, 404, { error: { code: 'not_found', message: 'conversation not found' } })
        return
      }
      const proc = await ensureAcp()
      acpSend(proc, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: conv.id } })
      sendJson(res, 200, { ok: true })
      return
    }

    if (url.pathname === '/permissions' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        permissions: [...pendingPermissions.values()].map((p) => ({
          id: p.id,
          sessionId: p.sessionId,
          toolCall: p.toolCall,
          options: p.options,
          createdAt: p.createdAt,
        })),
      })
      return
    }

    if (parts[0] === 'permissions' && parts[1] && req.method === 'POST') {
      const pending = pendingPermissions.get(parts[1])
      if (!pending) {
        sendJson(res, 410, { error: { code: 'gone', message: 'permission no longer pending' } })
        return
      }
      const body = await readBody(req)
      const optionId = String(body.optionId || '')
      if (!pending.options.some((o) => o.optionId === optionId)) {
        sendJson(res, 400, { error: { code: 'bad_option', message: 'optionId not offered' } })
        return
      }
      pendingPermissions.delete(parts[1])
      acpSend(pending.proc, {
        jsonrpc: '2.0',
        id: pending.rpcId,
        result: { outcome: { outcome: 'selected', optionId } },
      })
      log(`permission ${parts[1]} decided -> ${optionId}`)
      sendJson(res, 200, { ok: true })
      return
    }

    sendJson(res, 404, { error: { code: 'not_found', message: `no route ${req.method} ${url.pathname}` } })
  } catch (err) {
    log(`http error: ${err?.message || err}`)
    sendJson(res, 500, { error: { code: 'internal', message: String(err?.message || err) } })
  }
})

server.listen(PORT, HOST, () => {
  log(`daemon v${VERSION} listening on http://${HOST}:${PORT} (machine ${os.hostname()})`)
})

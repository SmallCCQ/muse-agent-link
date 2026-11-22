// Muse Agent Link daemon for the Antigravity DESKTOP app (office-workstation).
//
// Backend history: v0.1.0 drove the `agy` CLI through its ACP server, which
// created CLI conversations (~/.gemini/antigravity-cli) that never appear in
// the desktop app. Cai corrected the target on 2026-11-22: the desktop app is
// the product surface. v0.2.0 therefore drives the desktop app itself through
// its own agent interface:
//
//   - The desktop app runs a language server ("hub") that publishes
//     ~/.gemini/antigravity/daemon/hub_<httpPort>.json { httpsPort, httpPort,
//     lsVersion, csrfToken }.
//   - `language_server.exe agentapi` (wrapped by ~/.gemini/antigravity/bin/
//     agentapi.bat) talks to that hub when ANTIGRAVITY_LS_ADDRESS is set to
//     http://127.0.0.1:<httpPort> and ANTIGRAVITY_CSRF_TOKEN to the hub token:
//       agentapi new-conversation [--model=..] [--title=..] <prompt>
//       agentapi get-conversation-metadata <conversation_id>
//     new-conversation returns the real desktop conversation id immediately;
//     the turn then runs asynchronously inside the desktop app. Follow-up
//     turns use the LS Connect RPC SendUserCascadeMessage (see lsRpc below):
//     agentapi's send-message only injects a SYSTEM_MESSAGE, which an idle
//     cascade never answers.
//   - Turn results are read from the conversation's own transcript:
//     ~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl
//     (JSONL steps: USER_INPUT / PLANNER_RESPONSE / ..., each with status).
//     A turn is complete when a MODEL PLANNER_RESPONSE step with status DONE
//     lands after the turn's USER_INPUT step and the transcript goes quiet.
//
// The daemon keeps its loopback HTTP API shape (the DSH plugin proxies to
// it), so the plugin side barely changes. Conversation ids exposed by this
// API are daemon-local: a record starts as a provisional UUID (agentapi can
// only create a conversation together with its first prompt) and gains a
// `desktopConversationId` once the first prompt creates the real thing.
//
// Approvals: the desktop app presents tool approvals in its own UI; there is
// no agentapi surface for them, so /permissions is inert here. A turn that
// stops producing transcript output for a long while is flagged
// `awaitingApproval` on the conversation view as a hint.
//
// API (Authorization: Bearer <daemon token from daemon-token.txt>):
//   GET  /status
//   GET  /conversations
//   POST /conversations { cwd, title }           -> { conversation }
//   GET  /conversations/:id
//   POST /conversations/:id/prompt { text }      -> blocks until turn end
//   POST /conversations/:id/cancel               -> stops waiting locally
//   GET  /permissions                            -> always empty (see above)
//   POST /permissions/:id                        -> 410
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const VERSION = '0.2.2'
const PORT = 47615
const HOST = '127.0.0.1'
const STATE_DIR = path.join(os.homedir(), '.dsh', 'muse-agent-link')
const TOKEN_PATH = path.join(STATE_DIR, 'daemon-token.txt')
const INDEX_PATH = path.join(STATE_DIR, 'desktop-conversations.json')
const LOG_PATH = path.join(STATE_DIR, 'daemon.log')
const AGY_HOME = path.join(os.homedir(), '.gemini', 'antigravity')
const HUB_DIR = path.join(AGY_HOME, 'daemon')
const BRAIN_DIR = path.join(AGY_HOME, 'brain')
const LS_EXE = path.join(
  process.env.LOCALAPPDATA || '',
  'Programs',
  'antigravity',
  'resources',
  'bin',
  'language_server.exe',
)
const DEFAULT_TURN_TIMEOUT_MS = 600_000
const STALL_HINT_MS = 120_000

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

function findConversation(id) {
  if (conversations.has(id)) return conversations.get(id)
  for (const c of conversations.values()) if (c.desktopConversationId === id) return c
  return null
}

// ---------- desktop hub + agentapi ----------

function hubInfo() {
  let files = []
  try {
    files = fs
      .readdirSync(HUB_DIR)
      .filter((f) => /^hub_\d+\.json$/.test(f))
      .map((f) => ({ f, mtime: fs.statSync(path.join(HUB_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
  } catch {}
  for (const { f } of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(HUB_DIR, f), 'utf8'))
      if (j.httpPort && j.csrfToken) return j
    } catch {}
  }
  return null
}

function agentapi(args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const hub = hubInfo()
    if (!hub) {
      reject(new Error('no Antigravity desktop hub found (is the desktop app running?)'))
      return
    }
    const child = spawn(LS_EXE, ['agentapi', ...args], {
      windowsHide: true,
      env: {
        ...process.env,
        ANTIGRAVITY_LS_ADDRESS: `http://127.0.0.1:${hub.httpPort}`,
        ANTIGRAVITY_CSRF_TOKEN: hub.csrfToken,
      },
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`agentapi ${args[0]} timed out`))
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const start = out.indexOf('{')
      const end = out.lastIndexOf('}')
      if (start < 0 || end <= start) {
        reject(new Error(`agentapi ${args[0]}: no JSON in output: ${(out || err).slice(0, 300)}`))
        return
      }
      let parsed
      try {
        parsed = JSON.parse(out.slice(start, end + 1))
      } catch (e) {
        reject(new Error(`agentapi ${args[0]}: bad JSON: ${e.message}`))
        return
      }
      if (parsed.error) {
        reject(new Error(`agentapi ${args[0]}: ${typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error).slice(0, 300)}`))
        return
      }
      resolve(parsed.response || {})
    })
  })
}

// Follow-up user turns go through the language server's own RPC, not
// agentapi: `agentapi send-message` only injects a SYSTEM_MESSAGE into the
// conversation, which an idle cascade never answers (verified live
// 2026-11-22). The LS serves Connect-protocol JSON on the hub httpPort;
// SendUserCascadeMessage with header x-codeium-csrf-token creates a real
// USER_INPUT turn in an existing conversation.
async function lsRpc(method, body) {
  const hub = hubInfo()
  if (!hub) throw new Error('no Antigravity desktop hub found (is the desktop app running?)')
  const res = await fetch(
    `http://127.0.0.1:${hub.httpPort}/exa.language_server_pb.LanguageServerService/${method}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': hub.csrfToken },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    },
  )
  const text = await res.text()
  if (!res.ok) throw new Error(`LS ${method} HTTP ${res.status}: ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

// ---------- transcript watching ----------

function transcriptPath(desktopId) {
  return path.join(BRAIN_DIR, desktopId, '.system_generated', 'logs', 'transcript.jsonl')
}

function readSteps(desktopId) {
  try {
    const raw = fs.readFileSync(transcriptPath(desktopId), 'utf8')
    const steps = []
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        steps.push(JSON.parse(t))
      } catch {}
    }
    return steps
  } catch {
    return []
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const runningTurns = new Map() // daemon conv id -> { cancelled: boolean }

async function waitForTurn(conv, baselineMaxStep, timeoutMs) {
  const desktopId = conv.desktopConversationId
  const startedAt = Date.now()
  let lastSize = -1
  let lastChangeAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const ctl = runningTurns.get(conv.id)
    if (ctl?.cancelled) return { status: 'cancelled', resultText: '' }
    await sleep(1500)
    let size = -1
    try {
      size = fs.statSync(transcriptPath(desktopId)).size
    } catch {}
    if (size !== lastSize) {
      lastSize = size
      lastChangeAt = Date.now()
      conv.awaitingApproval = false
    } else if (Date.now() - lastChangeAt > STALL_HINT_MS) {
      // No transcript movement for a while: the desktop app may be waiting
      // for Cai to approve something in its UI. Hint only; keep waiting.
      conv.awaitingApproval = true
    }
    const steps = readSteps(desktopId)
    // The turn's steps are everything past the pre-dispatch baseline. Do not
    // key on a USER_INPUT step: new-conversation produces one, but
    // send-message delivers follow-ups as SYSTEM_MESSAGE steps instead
    // (observed live 2026-11-22), and the model answers them the same way.
    const turnSteps = steps.filter((s) => s.step_index > baselineMaxStep)
    if (!turnSteps.length) continue
    const errorStep = turnSteps.find((s) => s.status === 'ERROR')
    if (errorStep) {
      return { status: 'failed', resultText: '', error: String(errorStep.error_details || errorStep.content || 'step error').slice(0, 500) }
    }
    const replies = turnSteps.filter(
      (s) => s.type === 'PLANNER_RESPONSE' && s.status === 'DONE' && typeof s.content === 'string' && s.content.trim(),
    )
    const quiet = Date.now() - lastChangeAt >= 4000
    if (replies.length && quiet) {
      return { status: 'ok', resultText: replies[replies.length - 1].content.trim().slice(-4000) }
    }
  }
  return { status: 'timeout', resultText: '', error: `turn did not finish within ${Math.round(timeoutMs / 1000)}s` }
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
    desktopConversationId: c.desktopConversationId || null,
    cwd: c.cwd,
    title: c.title || null,
    createdAt: c.createdAt,
    lastTurn: c.lastTurn || null,
    busy: runningTurns.has(c.id),
    awaitingApproval: Boolean(c.awaitingApproval),
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)
  // CORS: the Antigravity app window (and only loopback pages like it)
  // fetches /status for the link status card; without these headers the
  // renderer blocks the response and the card falsely shows "offline".
  // The daemon binds loopback only and protected routes still require
  // the bearer token, so a wildcard origin does not weaken auth.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  try {
    if (url.pathname === '/status' && req.method === 'GET') {
      const hub = hubInfo()
      sendJson(res, 200, {
        ok: true,
        daemon: 'muse-agent-link',
        version: VERSION,
        backend: 'antigravity-desktop',
        machine: os.hostname(),
        hubPort: hub?.httpPort || null,
        lsVersion: hub?.lsVersion || null,
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
      // agentapi creates a conversation only together with its first prompt,
      // so this record starts provisional; the desktop conversation appears
      // on the first /prompt call.
      const conv = {
        id: crypto.randomUUID(),
        desktopConversationId: null,
        cwd,
        title: body.title ? String(body.title) : null,
        createdAt: new Date().toISOString(),
        lastTurn: null,
        awaitingApproval: false,
      }
      conversations.set(conv.id, conv)
      saveIndex()
      log(`conversation record created ${conv.id} (provisional, cwd ${cwd})`)
      sendJson(res, 201, { ok: true, conversation: convView(conv) })
      return
    }

    if (parts[0] === 'conversations' && parts[1] && parts.length === 2 && req.method === 'GET') {
      const conv = findConversation(parts[1])
      if (!conv) {
        sendJson(res, 404, { error: { code: 'not_found', message: 'conversation not found' } })
        return
      }
      sendJson(res, 200, { ok: true, conversation: convView(conv) })
      return
    }

    if (parts[0] === 'conversations' && parts[2] === 'prompt' && req.method === 'POST') {
      const conv = findConversation(parts[1])
      if (!conv) {
        sendJson(res, 404, { error: { code: 'not_found', message: 'conversation not found' } })
        return
      }
      if (runningTurns.has(conv.id)) {
        sendJson(res, 409, { error: { code: 'busy', message: 'a turn is already running' } })
        return
      }
      const body = await readBody(req)
      if (!body.text || typeof body.text !== 'string') {
        sendJson(res, 400, { error: { code: 'bad_request', message: 'text is required' } })
        return
      }
      const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || DEFAULT_TURN_TIMEOUT_MS, 30_000), 900_000)
      runningTurns.set(conv.id, { cancelled: false })
      try {
        let baseline = -1
        if (!conv.desktopConversationId) {
          const args = ['new-conversation']
          if (conv.title) args.push(`--title=${conv.title}`)
          args.push(body.text)
          const resp = await agentapi(args)
          const newId = resp?.newConversation?.conversationId
          if (!newId) throw new Error('new-conversation returned no conversationId')
          conv.desktopConversationId = newId
          saveIndex()
          log(`desktop conversation created ${newId} for record ${conv.id}`)
        } else {
          baseline = readSteps(conv.desktopConversationId).reduce((m, s) => Math.max(m, s.step_index ?? -1), -1)
          await lsRpc('SendUserCascadeMessage', {
            cascadeId: conv.desktopConversationId,
            items: [{ text: body.text }],
          })
        }
        const outcome = await waitForTurn(conv, baseline, timeoutMs)
        conv.lastTurn = {
          status: outcome.status,
          stopReason: outcome.status === 'ok' ? 'end_turn' : null,
          finishedAt: new Date().toISOString(),
          resultText: outcome.resultText || '',
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.status === 'cancelled'
            ? { error: 'wait cancelled locally; the desktop agent may still finish the turn in the app' }
            : {}),
        }
      } catch (err) {
        conv.lastTurn = {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          resultText: '',
          error: String(err?.message || err),
        }
      } finally {
        conv.awaitingApproval = false
        runningTurns.delete(conv.id)
        saveIndex()
      }
      sendJson(res, 200, { ok: true, conversation: convView(conv) })
      return
    }

    if (parts[0] === 'conversations' && parts[2] === 'cancel' && req.method === 'POST') {
      const conv = findConversation(parts[1])
      if (!conv) {
        sendJson(res, 404, { error: { code: 'not_found', message: 'conversation not found' } })
        return
      }
      // agentapi has no cancel: stop waiting locally. The turn itself may
      // still complete inside the desktop app.
      const ctl = runningTurns.get(conv.id)
      if (ctl) ctl.cancelled = true
      sendJson(res, 200, { ok: true })
      return
    }

    if (url.pathname === '/permissions' && req.method === 'GET') {
      // The desktop app owns approvals in its own UI; nothing to mirror.
      sendJson(res, 200, { ok: true, permissions: [] })
      return
    }

    if (parts[0] === 'permissions' && parts[1] && req.method === 'POST') {
      sendJson(res, 410, {
        error: { code: 'gone', message: 'the desktop app handles approvals in its own UI' },
      })
      return
    }

    sendJson(res, 404, { error: { code: 'not_found', message: `no route ${req.method} ${url.pathname}` } })
  } catch (err) {
    log(`http error: ${err?.message || err}`)
    sendJson(res, 500, { error: { code: 'internal', message: String(err?.message || err) } })
  }
})

server.listen(PORT, HOST, () => {
  log(`daemon v${VERSION} listening on http://${HOST}:${PORT} (machine ${os.hostname()}, backend antigravity-desktop)`)
})

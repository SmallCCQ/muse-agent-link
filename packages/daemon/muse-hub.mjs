// Muse Hub v2 — Standalone Multi-Account Session Gateway for Antigravity Desktop & DSH
// - Tailscale listener (<tailnet-ip>:47616): /v2/* + /api/muse-agent-link/* (v1 compat)
// - Loopback Admin/Internal listener (127.0.0.1:47617): /admin/* + /internal/* + /v2/*
// - Legacy Loopback Compat listener (127.0.0.1:47615): /status (for AGY pill) + legacy daemon compat
// UTF-8 without BOM. Pure Node.js built-ins.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AntigravityAdapter } from './antigravity-adapter.mjs'
import {
  DEFAULT_WORKSPACE,
  DSH_HOME,
  HUB_VERSION,
  HubStore,
  JOBS_DIR,
  STATE_DIR,
  isLoopbackIp,
  normalizeIp,
  writeFileAtomicSync,
} from './store.mjs'
import { WakeEngine } from './wake.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TAILNET_PORT = Number(process.env.MUSE_HUB_TAILNET_PORT || 47616)
const ADMIN_PORT = Number(process.env.MUSE_HUB_ADMIN_PORT || 47617)
const LEGACY_PORT = Number(process.env.MUSE_HUB_LEGACY_PORT || 47615)
const LOG_PATH = path.join(STATE_DIR, 'hub.log')
const PID_PATH = path.join(STATE_DIR, 'hub.pid')
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_FETCH_FILE_BYTES = 10 * 1024 * 1024
const DSH_ADAPTER_TTL_MS = 35_000
const MAX_CONCURRENT_JOBS = 2
const DEFAULT_JOB_TIMEOUT_SEC = 600
const JOB_RESULT_TAIL_CHARS = 4000

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

async function ensureSingleInstance() {
  try {
    if (fs.existsSync(PID_PATH)) {
      const existingPid = Number(fs.readFileSync(PID_PATH, 'utf8').trim())
      if (isPidAlive(existingPid)) {
        try {
          const probe = await fetch(`http://127.0.0.1:${ADMIN_PORT}/v2/status`, {
            signal: AbortSignal.timeout(1200),
          })
          if (probe.ok) {
            process.stdout.write(
              `${new Date().toISOString()} [hub] single-instance lock: PID ${existingPid} already serving :${ADMIN_PORT}, exiting cleanly.\n`
            )
            process.exit(0)
          }
        } catch {}
      }
    }
  } catch {}
}

function writePidFile() {
  try {
    writeFileAtomicSync(PID_PATH, String(process.pid))
  } catch {}
}

function removePidFileIfOurs() {
  try {
    if (fs.existsSync(PID_PATH) && Number(fs.readFileSync(PID_PATH, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(PID_PATH)
    }
  } catch {}
}

await ensureSingleInstance()

function log(line) {
  const msg = `${new Date().toISOString()} ${line}\n`
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.appendFileSync(LOG_PATH, msg, 'utf8')
  } catch {}
  process.stdout.write(msg)
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
    if (size > MAX_BODY_BYTES) {
      const e = new Error('Request body too large')
      e.status = 413
      throw e
    }
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function extractBearer(req) {
  const auth = String(req.headers['authorization'] || '')
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
}

function tailscaleIpv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      const parts = info.address.split('.').map(Number)
      if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return info.address
    }
  }
  return null
}

function formatStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function formatThreadTitle(account, requestedTitle) {
  const prefix = `[Muse·${account.label}]`
  const raw = requestedTitle ? String(requestedTitle).trim() : ''
  if (!raw) return `${prefix} ${formatStamp()}`
  if (raw.startsWith('[Muse·')) return raw.slice(0, 120)
  return `${prefix} ${raw}`.slice(0, 120)
}

// ---------- Core singletons ----------

const wake = new WakeEngine({ log })
const store = new HubStore({
  onEvent: (ev, account) => wake.maybeWake(ev, account),
})
const agyAdapter = new AntigravityAdapter({ store, log })
agyAdapter.start()

// Registered DSH Cordis adapter state
let dshAdapter = null // { rpcBaseUrl, version, pid, lastSeenMs }
const pendingApprovals = new Map() // approvalId -> { id, threadId, ownerAccountId, agent, toolName, argsSummary, reason, workspace, risk, expiresAt, canRemoteApprove }
const runningJobs = new Map() // jobId -> ChildProcess

function isDshAvailable() {
  return Boolean(dshAdapter && Date.now() - dshAdapter.lastSeenMs <= DSH_ADAPTER_TTL_MS)
}

async function dshRpc(pathname, body = {}) {
  if (!isDshAvailable()) {
    const err = new Error('DSH adapter is offline (is DSH running with @local/muse-agent-link v2?)')
    err.status = 503
    err.code = 'adapter_offline'
    throw err
  }
  const res = await fetch(`${dshAdapter.rpcBaseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-internal-token': store.internalToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data?.error?.message || `DSH RPC ${pathname} HTTP ${res.status}`)
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502
    err.code = data?.error?.code || 'internal'
    throw err
  }
  return data
}

function threadView(b) {
  const owner = store.getAccount(b.ownerAccountId)
  const approvals = [...pendingApprovals.values()]
    .filter((p) => p.threadId === b.id)
    .map((p) => ({
      id: p.id,
      toolName: p.toolName,
      argsSummary: p.argsSummary || null,
      reason: p.reason || null,
      workspace: p.workspace,
      risk: p.risk || 'normal',
      expiresAt: p.expiresAt,
      canRemoteApprove: Boolean(p.canRemoteApprove),
      agent: p.agent,
    }))
  return {
    id: b.id,
    ownerAccountId: b.ownerAccountId,
    ownerLabel: owner?.label || b.ownerAccountId,
    windowKey: b.windowKey || null,
    agent: b.agent,
    sessionId: b.localSessionId || b.legacyConvId || b.id,
    localSessionId: b.localSessionId || null,
    desktopConversationId: b.agent === 'antigravity' ? (b.localSessionId || null) : null,
    provisional: Boolean(b.provisional),
    workspace: b.workspace,
    model: b.model || null,
    preset: b.preset || null,
    title: b.title || null,
    state: b.state,
    origin: b.origin || 'muse',
    createdAt: b.createdAt,
    lastActivityAt: b.lastActivityAt,
    lastTurn: b.lastTurn || null,
    pendingApprovals: approvals,
  }
}

function countRunningTurnsForAccount(accountId) {
  let n = 0
  for (const b of store.bindings.values()) {
    if (b.ownerAccountId === accountId && b.state === 'running') n += 1
  }
  return n
}

// ---------- Headless DSH jobs (v1 compat) ----------

function resolveDshEntry() {
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

function jobPath(id) {
  return path.join(JOBS_DIR, `${id}.json`)
}

function saveJob(job) {
  try {
    writeFileAtomicSync(jobPath(job.id), JSON.stringify(job, null, 2))
  } catch {}
}

function loadJob(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null
  try {
    return JSON.parse(fs.readFileSync(jobPath(id), 'utf8'))
  } catch {
    return null
  }
}

function listJobsForAccount(account, limit = 20) {
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
      .filter((j) => {
        if (!j) return false
        if (account.role === 'owner') return !j.ownerAccountId || j.ownerAccountId === account.id || store.getAccount(j.ownerAccountId)?.role === 'owner'
        return j.ownerAccountId === account.id
      })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit)
      .map((j) => ({
        id: j.id,
        ownerAccountId: j.ownerAccountId || null,
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

function runHeadlessJob(job) {
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
    try { child.kill() } catch {}
  }, job.timeoutSec * 1000)
  child.stdout.on('data', (d) => (stdout += d.toString()))
  child.stderr.on('data', (d) => (stderr += d.toString()))
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
    job.result = stdout.slice(-JOB_RESULT_TAIL_CHARS)
    if (code !== 0) job.stderrTail = stderr.slice(-2000)
    saveJob(job)
    if (job.ownerAccountId) {
      store.appendEvent(job.ownerAccountId, {
        threadId: null,
        agent: 'dsh',
        type: 'job.state',
        payload: { jobId: job.id, state: job.state, exitCode: code },
      })
    }
  })
}

// ---------- Shared Thread Operations ----------

async function handleCreateThread(account, body) {
  const requestedAgent = body.agent || account.defaultAgent || 'dsh'
  if (requestedAgent !== 'dsh' && requestedAgent !== 'antigravity') {
    const err = new Error(`Unsupported agent: ${requestedAgent}`)
    err.status = 400
    err.code = 'bad_request'
    throw err
  }
  if (!account.allowedAgents.includes(requestedAgent)) {
    const err = new Error(`Account ${account.id} is not permitted to use agent ${requestedAgent}.`)
    err.status = 403
    err.code = 'forbidden_role'
    throw err
  }

  const windowKey = body.windowKey ? String(body.windowKey).trim().slice(0, 128) : null
  if (windowKey) {
    const existing = store.findReusableByWindowKey(account.id, requestedAgent, windowKey)
    if (existing) {
      return { status: 200, reused: true, binding: existing }
    }
  }

  const wsCheck = store.resolveAllowedWorkspace(account, body.workspace)
  if (!wsCheck.ok) {
    const err = new Error(wsCheck.message)
    err.status = wsCheck.status
    err.code = wsCheck.code
    throw err
  }

  const title = formatThreadTitle(account, body.title)
  const effectivePreset =
    account.role === 'collaborator'
      ? (account.forcedPreset || 'workspace-write')
      : (body.preset ? String(body.preset) : account.forcedPreset || null)

  if (requestedAgent === 'antigravity') {
    const agyStatus = agyAdapter.status()
    if (!agyStatus.available) {
      const err = new Error('Antigravity Desktop is not running or hub not ready.')
      err.status = 503
      err.code = 'adapter_offline'
      throw err
    }
    const binding = store.createBinding({
      ownerAccountId: account.id,
      agent: 'antigravity',
      localSessionId: null,
      provisional: true,
      title,
      workspace: wsCheck.workspace,
      windowKey,
      model: body.model ? String(body.model) : null,
      preset: null,
      origin: 'muse',
    })
    store.appendEvent(account.id, {
      threadId: binding.id,
      agent: 'antigravity',
      type: 'thread.state',
      payload: { state: 'active', provisional: true, title: binding.title },
    })
    return { status: 201, reused: false, binding }
  }

  // DSH thread creation via DSH Adapter RPC
  const created = await dshRpc('/rpc/session/create', {
    cwd: wsCheck.workspace,
    title,
    preset: effectivePreset,
    approvalPolicy: account.approvalPolicy,
  })
  const binding = store.createBinding({
    ownerAccountId: account.id,
    agent: 'dsh',
    localSessionId: created.sessionId,
    provisional: false,
    title: created.title || title,
    workspace: wsCheck.workspace,
    windowKey,
    model: body.model ? String(body.model) : null,
    preset: effectivePreset,
    origin: 'muse',
  })
  // Inform DSH adapter of threadId <-> sessionId binding
  await dshRpc('/rpc/binding/sync', {
    threadId: binding.id,
    sessionId: binding.localSessionId,
    ownerAccountId: account.id,
    approvalPolicy: account.approvalPolicy,
    cwd: binding.workspace,
  }).catch(() => {})

  store.appendEvent(account.id, {
    threadId: binding.id,
    agent: 'dsh',
    type: 'thread.state',
    payload: { state: 'active', localSessionId: binding.localSessionId, title: binding.title },
  })
  return { status: 201, reused: false, binding }
}

async function handleSendMessage(account, binding, body) {
  let text = typeof body.text === 'string' ? body.text : ''
  if (!text.trim()) {
    const err = new Error('text is required.')
    err.status = 400
    err.code = 'bad_request'
    throw err
  }
  if (binding.state === 'closed') {
    const err = new Error('Thread is closed.')
    err.status = 400
    err.code = 'bad_request'
    throw err
  }

  let mode = body.mode === 'steer' ? 'steer' : 'queue'
  const trimmed = text.trim()

  // Built-in lightweight slash command handling
  if (trimmed === '/status') {
    const ev = store.appendEvent(account.id, {
      threadId: binding.id,
      agent: binding.agent,
      type: 'turn.finished',
      payload: {
        turnId: `cmd_${Date.now().toString(36)}`,
        status: 'ok',
        resultText: JSON.stringify(threadView(binding), null, 2),
      },
    })
    return { turnId: ev.payload.turnId, cursor: ev.seq, binding }
  }
  if (trimmed === '/stop') {
    await handleStopThread(account, binding)
    return { turnId: `cmd_stop_${Date.now().toString(36)}`, cursor: store._ensureEventLog(account.id).seq, binding }
  }
  if (trimmed === '/close') {
    binding.state = 'closed'
    store.saveBinding(binding)
    if (binding.agent === 'antigravity') agyAdapter.unwatch(binding.id)
    const ev = store.appendEvent(account.id, {
      threadId: binding.id,
      agent: binding.agent,
      type: 'thread.state',
      payload: { state: 'closed' },
    })
    return { turnId: `cmd_close_${Date.now().toString(36)}`, cursor: ev.seq, binding }
  }
  if (trimmed.startsWith('/steer ')) {
    mode = 'steer'
    text = trimmed.slice(7).trim()
    if (!text) {
      const err = new Error('/steer requires message text.')
      err.status = 400
      err.code = 'bad_request'
      throw err
    }
  }

  // Concurrency check (skip if steering same running thread)
  if (binding.state !== 'running') {
    const running = countRunningTurnsForAccount(account.id)
    if (running >= account.maxConcurrentTurns) {
      const err = new Error(`Account ${account.id} reached concurrency limit (${account.maxConcurrentTurns}).`)
      err.status = 429
      err.code = 'concurrency_limit'
      throw err
    }
  }

  const turnId = `turn_${crypto.randomBytes(6).toString('hex')}`
  store.audit('thread.message', {
    threadId: binding.id,
    accountId: account.id,
    agent: binding.agent,
    mode,
    preview: text.slice(0, 120),
  })

  if (binding.agent === 'antigravity') {
    await agyAdapter.sendPrompt(binding, text, { turnId, mode })
    return { turnId, cursor: store._ensureEventLog(account.id).seq, binding }
  }

  // DSH dispatch
  store.recordInboundEcho(binding.id, text)
  await dshRpc('/rpc/session/prompt', {
    threadId: binding.id,
    sessionId: binding.localSessionId,
    ownerAccountId: binding.ownerAccountId,
    approvalPolicy: account.approvalPolicy,
    cwd: binding.workspace,
    text,
    mode,
    turnId,
  })
  binding.state = 'running'
  store.saveBinding(binding)
  return { turnId, cursor: store._ensureEventLog(account.id).seq, binding }
}

async function handleStopThread(account, binding) {
  store.audit('thread.stop', { threadId: binding.id, accountId: account.id, agent: binding.agent })
  if (binding.agent === 'antigravity') {
    agyAdapter.cancelTurn(binding)
    return binding
  }
  await dshRpc('/rpc/session/cancel', { sessionId: binding.localSessionId })
  binding.state = 'active'
  store.saveBinding(binding)
  return binding
}

async function handleApprovalDecision(account, approvalId, decision) {
  if (account.role === 'collaborator' || account.approvalPolicy === 'local_only') {
    const err = new Error('This account is restricted to local desktop approvals only.')
    err.status = 403
    err.code = 'approval_local_only'
    throw err
  }
  const pending = pendingApprovals.get(approvalId)
  if (!pending) {
    const err = new Error('Approval is no longer pending or expired.')
    err.status = 410
    err.code = 'approval_expired'
    throw err
  }
  const binding = store.bindings.get(pending.threadId)
  if (!binding || !store.canAccessBinding(account, binding, { allowCrossOwnerRead: true })) {
    const err = new Error('Approval not found.')
    err.status = 404
    err.code = 'thread_not_found'
    throw err
  }
  const normalized = decision === 'approve_once' ? 'approve_once' : 'deny'
  await dshRpc('/rpc/approval/decide', { id: approvalId, decision: normalized })
  pendingApprovals.delete(approvalId)
  store.audit('approval.decided', {
    approvalId,
    threadId: binding.id,
    accountId: account.id,
    decision: normalized,
    via: 'controller',
  })
  return { ok: true, id: approvalId, decision: normalized }
}

// ---------- Internal DSH Event Ingestion ----------

function handleInternalDshEvent(body) {
  const { type, sessionId, threadId, payload = {} } = body || {}
  const binding =
    (threadId && store.bindings.get(threadId)) ||
    (sessionId && store.findBindingByLocalSession('dsh', sessionId))
  if (!binding || binding.state === 'closed') return { ignored: true }
  const account = store.getAccount(binding.ownerAccountId)
  if (!account || account.status !== 'active') return { ignored: true }

  if (type === 'user.message') {
    const text = String(payload.text || '')
    if (!text.trim()) return { ignored: true }
    if (store.consumeEchoIfMatched(binding.id, text)) {
      return { suppressedEcho: true }
    }
    store.appendEvent(account.id, {
      threadId: binding.id,
      agent: 'dsh',
      type: 'local.user_message',
      payload: { text: text.slice(0, 8000) },
    })
    return { ok: true }
  }

  if (type === 'turn.started') {
    if (binding.state !== 'awaiting_approval') binding.state = 'running'
    store.saveBinding(binding)
    store.appendEvent(account.id, {
      threadId: binding.id,
      agent: 'dsh',
      type: 'turn.started',
      payload: { turnId: payload.turnId || null, source: payload.source || 'dsh' },
    })
    return { ok: true }
  }

  if (type === 'output.progress') {
    store.appendEvent(account.id, {
      threadId: binding.id,
      agent: 'dsh',
      type: 'output.progress',
      payload,
    })
    return { ok: true }
  }

  if (type === 'approval.requested') {
    const approvalId = String(payload.id || payload.approvalId || '')
    if (!approvalId) return { ignored: true }
    const canRemoteApprove = account.role === 'owner' && account.approvalPolicy === 'remote_or_local'
    pendingApprovals.set(approvalId, {
      id: approvalId,
      threadId: binding.id,
      ownerAccountId: account.id,
      agent: 'dsh',
      toolName: payload.toolName || 'tool',
      argsSummary: payload.argsSummary || null,
      reason: payload.reason || null,
      workspace: binding.workspace,
      risk: payload.risk || 'normal',
      expiresAt: payload.expiresAt || null,
      canRemoteApprove,
    })
    binding.state = 'awaiting_approval'
    store.saveBinding(binding)
    store.appendEvent(account.id, {
      threadId: binding.id,
      agent: 'dsh',
      type: 'approval.requested',
      payload: {
        approvalId,
        id: approvalId,
        toolName: payload.toolName || 'tool',
        argsSummary: payload.argsSummary || null,
        reason: payload.reason || null,
        workspace: binding.workspace,
        risk: payload.risk || 'normal',
        expiresAt: payload.expiresAt || null,
        canRemoteApprove,
      },
    })
    return { ok: true }
  }

  if (type === 'approval.resolved') {
    const approvalId = String(payload.id || payload.approvalId || '')
    if (approvalId) pendingApprovals.delete(approvalId)
    if (binding.state === 'awaiting_approval') {
      binding.state = 'running'
      store.saveBinding(binding)
    }
    store.appendEvent(account.id, {
      threadId: binding.id,
      agent: 'dsh',
      type: 'approval.resolved',
      payload: {
        approvalId,
        id: approvalId,
        decision: payload.decision || null,
        via: payload.via || 'local-ui',
      },
    })
    return { ok: true }
  }

  if (type === 'question.asked' || type === 'turn.input_required') {
    binding.state = 'awaiting_input'
    if (payload.resultText) {
      binding.lastTurn = {
        status: 'input-required',
        finishedAt: new Date().toISOString(),
        resultText: String(payload.resultText).slice(-12000),
      }
    }
    store.saveBinding(binding)
    store.appendEvent(account.id, {
      threadId: binding.id,
      agent: 'dsh',
      type: 'question.asked',
      payload: { prompt: payload.resultText || payload.prompt || '', options: payload.options || [] },
    })
    return { ok: true }
  }

  if (type === 'turn.finished') {
    const mediaList = []
    const seenPaths = new Set()
    const rawArtifacts = Array.isArray(payload.artifacts) ? payload.artifacts : []
    for (const art of rawArtifacts) {
      if (mediaList.length >= 10) break
      const p = String(art?.path || '').trim()
      if (!p || seenPaths.has(p)) continue
      seenPaths.add(p)
      try {
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue
        const real = fs.realpathSync(p)
        // Enforce account workspace jail for collaborators (and verify readability)
        if (account.role === 'collaborator') {
          const check = store.resolveAllowedFile(account, binding.workspace, path.relative(binding.workspace, real))
          if (!check.ok) continue
        }
        mediaList.push(
          store.issueFileToken(account.id, real, {
            name: art.name || path.basename(real),
            mime: art.mime || 'application/octet-stream',
          })
        )
      } catch {}
    }

    binding.state = 'active'
    binding.lastTurn = {
      turnId: payload.turnId || null,
      status: payload.status || 'ok',
      finishedAt: new Date().toISOString(),
      resultText: String(payload.resultText || '').slice(-12000),
      ...(payload.error ? { error: payload.error } : {}),
      ...(mediaList.length > 0 ? { media: mediaList } : {}),
    }
    store.saveBinding(binding)
    store.appendEvent(account.id, {
      threadId: binding.id,
      agent: 'dsh',
      type: 'turn.finished',
      payload: {
        turnId: payload.turnId || null,
        status: binding.lastTurn.status,
        resultText: binding.lastTurn.resultText,
        ...(binding.lastTurn.error ? { error: binding.lastTurn.error } : {}),
        ...(mediaList.length > 0 ? { media: mediaList } : {}),
      },
    })
    return { ok: true, mediaCount: mediaList.length }
  }

  return { ignored: true }
}

// ---------- External HTTP Router (/v2/* + /api/muse-agent-link/* v1 compat) ----------

function buildPublicStatus() {
  const agy = agyAdapter.status()
  const activeAccounts = [...store.accounts.values()].filter((a) => a.status === 'active')
  return {
    ok: true,
    plugin: 'muse-agent-link',
    version: HUB_VERSION,
    machine: os.hostname(),
    paired: activeAccounts.length > 0,
    accountCount: activeAccounts.length,
    channel: 'tailscale-direct',
    agents: {
      dsh: {
        available: isDshAvailable(),
        version: dshAdapter?.version || null,
      },
      antigravity: {
        available: agy.available,
        hubPort: agy.hubPort,
        lsVersion: agy.lsVersion,
        runningTurns: agy.runningTurns,
      },
    },
    time: new Date().toISOString(),
  }
}

async function handlePublicApi(req, res, url) {
  const p = url.pathname
  const remoteIp = normalizeIp(req.socket?.remoteAddress || '')

  // ---- Unauthenticated routes ----
  if ((p === '/v2/status' || p === '/api/muse-agent-link/status') && (req.method === 'GET' || req.method === 'HEAD')) {
    sendJson(res, 200, buildPublicStatus())
    return
  }

  if ((p === '/v2/pair' || p === '/api/muse-agent-link/pair') && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req)
    } catch {
      sendError(res, 400, 'bad_request', 'Invalid JSON body.')
      return
    }
    const result = store.redeemPairingTicket(body.code, {
      remoteIp,
      clientName: body.clientName,
    })
    if (!result.ok) {
      sendError(res, result.status, result.code, result.message)
      return
    }
    sendJson(res, 200, {
      ok: true,
      accountId: result.account.id,
      label: result.account.label,
      role: result.account.role,
      token: result.token,
      machine: os.hostname(),
    })
    return
  }

  // ---- Authenticated routes ----
  const auth = store.authenticateToken(extractBearer(req), remoteIp)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message)
    return
  }
  const account = auth.account

  // ---- v2 canonical API ----
  if (p === '/v2/me' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, machine: os.hostname(), account: store.accountPublicView(account) })
    return
  }

  if (p === '/v2/client.py' && req.method === 'GET') {
    const candidates = [
      path.join(STATE_DIR, 'muse_link_client.py'),
      path.join(HERE, '..', 'muse-client', 'muse_link_client.py'), path.join(HERE, '..', '..', 'tools', 'muse_link_client.py'),
    ]
    const found = candidates.find((c) => fs.existsSync(c))
    if (!found) {
      sendError(res, 404, 'file_not_found', 'muse_link_client.py not found on host.')
      return
    }
    res.writeHead(200, { 'content-type': 'text/x-python; charset=utf-8' })
    res.end(fs.readFileSync(found, 'utf8'))
    return
  }

  if (p === '/v2/skill.md' && req.method === 'GET') {
    const candidates = [
      path.join(STATE_DIR, 'MUSE_LINK_SKILL.md'),
      path.join(HERE, '..', 'muse-client', 'MUSE_LINK_SKILL.md'), path.join(HERE, '..', '..', 'tools', 'MUSE_LINK_SKILL.md'),
    ]
    const found = candidates.find((c) => fs.existsSync(c))
    if (!found) {
      sendError(res, 404, 'file_not_found', 'MUSE_LINK_SKILL.md not found on host.')
      return
    }
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
    res.end(fs.readFileSync(found, 'utf8'))
    return
  }

  if (p === '/v2/bundles/office-v2.zip' && req.method === 'GET') {
    if (account.role !== 'owner') {
      sendError(res, 403, 'forbidden_role', 'Owner account required.')
      return
    }
    const candidates = [
      path.join(STATE_DIR, 'office-workstation-v2-bundle.zip'),
      path.join(HERE, '..', 'dist', 'office-workstation-v2-bundle.zip'),
    ]
    const found = candidates.find((c) => fs.existsSync(c))
    if (!found) {
      sendError(res, 404, 'file_not_found', 'office-workstation-v2-bundle.zip not built yet.')
      return
    }
    const st = fs.statSync(found)
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': String(st.size),
      'content-disposition': 'attachment; filename="office-workstation-v2-bundle.zip"',
    })
    fs.createReadStream(found).pipe(res)
    return
  }

  if ((p === '/v2/unpair' || p === '/api/muse-agent-link/unpair') && req.method === 'POST') {
    store.revokeAccount(account.id, 'self-unpair')
    sendJson(res, 200, { ok: true, revoked: true, accountId: account.id })
    return
  }

  if (p === '/v2/events' && req.method === 'GET') {
    const cursor = Math.max(Number(url.searchParams.get('cursor') || 0), 0)
    const waitSec = Math.min(Math.max(Number(url.searchParams.get('wait') || 0), 0), 20)
    const threadId = url.searchParams.get('threadId') || null
    if (threadId) {
      const b = store.bindings.get(threadId)
      if (!b || !store.canAccessBinding(account, b, { allowCrossOwnerRead: false })) {
        sendError(res, 404, 'thread_not_found', 'Thread not found.')
        return
      }
    }
    const result = await store.pollEvents(account.id, { cursor, waitSec, threadId })
    sendJson(res, 200, { ok: true, ...result })
    return
  }

  if ((p === '/v2/threads' || p === '/api/muse-agent-link/threads') && req.method === 'GET') {
    const scope = url.searchParams.get('scope') || 'mine'
    const includeClosed = url.searchParams.get('includeClosed') === '1'
    const list = store.listBindingsForAccount(account, { scope, includeClosed }).map(threadView)
    sendJson(res, 200, { ok: true, threads: list })
    return
  }

  if ((p === '/v2/threads' || p === '/api/muse-agent-link/threads') && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req)
    } catch {
      sendError(res, 400, 'bad_request', 'Invalid JSON body.')
      return
    }
    try {
      const { status, reused, binding } = await handleCreateThread(account, body)
      sendJson(res, status, { ok: true, reused, thread: threadView(binding) })
    } catch (err) {
      sendError(res, err.status || 500, err.code || 'internal', String(err?.message || err))
    }
    return
  }

  // /v2/threads/:id and sub-actions
  const threadMatch = p.match(/^\/v2\/threads\/([^/]+)(?:\/(messages|stop|close|takeover))?$/)
  if (threadMatch) {
    const tid = decodeURIComponent(threadMatch[1])
    const action = threadMatch[2] || null
    const binding = store.bindings.get(tid)

    if (action === 'takeover' && req.method === 'POST') {
      if (account.role !== 'owner') {
        sendError(res, 403, 'forbidden_role', 'Only owner accounts can take over threads.')
        return
      }
      if (!binding || !store.canAccessBinding(account, binding, { allowCrossOwnerRead: true })) {
        sendError(res, 404, 'thread_not_found', 'Thread not found.')
        return
      }
      const updated = store.transferBinding(binding.id, account.id)
      if (updated.agent === 'dsh' && isDshAvailable()) {
        await dshRpc('/rpc/binding/sync', {
          threadId: updated.id,
          sessionId: updated.localSessionId,
          ownerAccountId: account.id,
          approvalPolicy: account.approvalPolicy,
        }).catch(() => {})
      }
      sendJson(res, 200, { ok: true, thread: threadView(updated) })
      return
    }

    if (!binding || !store.canAccessBinding(account, binding, { allowCrossOwnerRead: !action && req.method === 'GET' })) {
      sendError(res, 404, 'thread_not_found', 'Thread not found.')
      return
    }

    if (!action && req.method === 'GET') {
      sendJson(res, 200, { ok: true, thread: threadView(binding) })
      return
    }
    if (action === 'messages' && req.method === 'POST') {
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        sendError(res, 400, 'bad_request', 'Invalid JSON body.')
        return
      }
      try {
        const resObj = await handleSendMessage(account, binding, body)
        sendJson(res, 202, {
          ok: true,
          turnId: resObj.turnId,
          cursor: resObj.cursor,
          thread: threadView(resObj.binding),
        })
      } catch (err) {
        sendError(res, err.status || 500, err.code || 'internal', String(err?.message || err))
      }
      return
    }
    if (action === 'stop' && req.method === 'POST') {
      try {
        const updated = await handleStopThread(account, binding)
        sendJson(res, 200, { ok: true, thread: threadView(updated) })
      } catch (err) {
        sendError(res, err.status || 500, err.code || 'internal', String(err?.message || err))
      }
      return
    }
    if (action === 'close' && req.method === 'POST') {
      binding.state = 'closed'
      store.saveBinding(binding)
      if (binding.agent === 'antigravity') agyAdapter.unwatch(binding.id)
      store.appendEvent(account.id, {
        threadId: binding.id,
        agent: binding.agent,
        type: 'thread.state',
        payload: { state: 'closed' },
      })
      sendJson(res, 200, { ok: true, thread: threadView(binding) })
      return
    }
  }

  // Approvals v2: POST /v2/approvals/:id
  const apprMatch = p.match(/^\/v2\/approvals\/([^/]+)$/)
  if (apprMatch && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req)
    } catch {
      sendError(res, 400, 'bad_request', 'Invalid JSON body.')
      return
    }
    try {
      const r = await handleApprovalDecision(account, decodeURIComponent(apprMatch[1]), body.decision)
      sendJson(res, 200, r)
    } catch (err) {
      sendError(res, err.status || 500, err.code || 'internal', String(err?.message || err))
    }
    return
  }

  // Short-lived media/file tokens: GET /v2/files/:token
  const fileMatch = p.match(/^\/v2\/files\/(ft_[0-9a-f]+)$/)
  if (fileMatch && req.method === 'GET') {
    const entry = store.resolveFileToken(account.id, fileMatch[1])
    if (!entry) {
      sendError(res, 404, 'file_not_found', 'File token invalid, expired, or unauthorized.')
      return
    }
    const st = fs.statSync(entry.filePath)
    if (st.size > MAX_FETCH_FILE_BYTES) {
      sendError(res, 413, 'bad_request', 'File exceeds 10MB transfer cap.')
      return
    }
    res.writeHead(200, {
      'content-type': entry.mime || 'application/octet-stream',
      'content-length': String(st.size),
      'content-disposition': `inline; filename="${encodeURIComponent(entry.name)}"`,
    })
    fs.createReadStream(entry.filePath).pipe(res)
    return
  }

  // Workspace-scoped file fetch: POST /v2/files/fetch
  if (p === '/v2/files/fetch' && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req)
    } catch {
      sendError(res, 400, 'bad_request', 'Invalid JSON body.')
      return
    }
    const check = store.resolveAllowedFile(account, body.workspace, body.path)
    if (!check.ok) {
      sendError(res, check.status, check.code, check.message)
      return
    }
    if (check.size > MAX_FETCH_FILE_BYTES) {
      sendError(res, 413, 'bad_request', 'File exceeds 10MB transfer cap.')
      return
    }
    store.audit('files.fetch', { accountId: account.id, file: path.basename(check.filePath), size: check.size })
    const buf = fs.readFileSync(check.filePath)
    if (body.encoding === 'utf8') {
      sendJson(res, 200, { ok: true, name: path.basename(check.filePath), size: check.size, text: buf.toString('utf8') })
    } else {
      sendJson(res, 200, { ok: true, name: path.basename(check.filePath), size: check.size, base64: buf.toString('base64') })
    }
    return
  }

  // ---- v1 Legacy Compatibility Routes (/api/muse-agent-link/*) ----
  if (p === '/api/muse-agent-link/thread' && req.method === 'GET') {
    const b = store.bindings.get(url.searchParams.get('id') || '')
    if (!b || !store.canAccessBinding(account, b, { allowCrossOwnerRead: true })) {
      sendError(res, 404, 'thread_not_found', 'Thread not found.')
      return
    }
    sendJson(res, 200, { ok: true, thread: threadView(b) })
    return
  }

  if (p === '/api/muse-agent-link/thread-message' && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req)
    } catch {
      sendError(res, 400, 'bad_request', 'Invalid JSON body.')
      return
    }
    const tid = String(body.threadId || url.searchParams.get('id') || '')
    const b = store.bindings.get(tid)
    if (!b || !store.canAccessBinding(account, b, { allowCrossOwnerRead: false })) {
      sendError(res, 404, 'thread_not_found', 'Thread not found.')
      return
    }
    try {
      const resObj = await handleSendMessage(account, b, body)
      sendJson(res, 202, { ok: true, turnId: resObj.turnId, cursor: resObj.cursor, thread: threadView(resObj.binding) })
    } catch (err) {
      sendError(res, err.status || 500, err.code || 'internal', String(err?.message || err))
    }
    return
  }

  if (p === '/api/muse-agent-link/thread-stop' && req.method === 'POST') {
    const b = store.bindings.get(url.searchParams.get('id') || '')
    if (!b || !store.canAccessBinding(account, b, { allowCrossOwnerRead: false })) {
      sendError(res, 404, 'thread_not_found', 'Thread not found.')
      return
    }
    try {
      const updated = await handleStopThread(account, b)
      sendJson(res, 200, { ok: true, thread: threadView(updated) })
    } catch (err) {
      sendError(res, err.status || 500, err.code || 'internal', String(err?.message || err))
    }
    return
  }

  if (p === '/api/muse-agent-link/thread-events' && req.method === 'GET') {
    const tid = url.searchParams.get('id') || ''
    const b = store.bindings.get(tid)
    if (!b || !store.canAccessBinding(account, b, { allowCrossOwnerRead: true })) {
      sendError(res, 404, 'thread_not_found', 'Thread not found.')
      return
    }
    const cursor = Math.max(Number(url.searchParams.get('cursor') || 0), 0)
    const waitSec = Math.min(Math.max(Number(url.searchParams.get('wait') || 0), 0), 20)
    const result = await store.pollEvents(b.ownerAccountId, { cursor, waitSec, threadId: b.id })
    sendJson(res, 200, { ok: true, cursor: result.cursor, events: result.events })
    return
  }

  if (p === '/api/muse-agent-link/approvals' && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req)
    } catch {
      sendError(res, 400, 'bad_request', 'Invalid JSON body.')
      return
    }
    const id = String(body.id || url.searchParams.get('id') || '')
    try {
      const r = await handleApprovalDecision(account, id, body.decision)
      sendJson(res, 200, r)
    } catch (err) {
      sendError(res, err.status || 500, err.code || 'internal', String(err?.message || err))
    }
    return
  }

  if (p === '/api/muse-agent-link/tasks' && req.method === 'POST') {
    if (!account.allowedAgents.includes('dsh')) {
      sendError(res, 403, 'forbidden_role', 'Account not allowed to run DSH jobs.')
      return
    }
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
    const wsCheck = store.resolveAllowedWorkspace(account, body.workspace)
    if (!wsCheck.ok) {
      sendError(res, wsCheck.status, wsCheck.code, wsCheck.message)
      return
    }
    const job = {
      id: crypto.randomUUID(),
      ownerAccountId: account.id,
      prompt: body.prompt,
      workspace: wsCheck.workspace,
      timeoutSec: Math.min(Math.max(Number(body.timeoutSec) || DEFAULT_JOB_TIMEOUT_SEC, 10), 3600),
      state: 'running',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      result: null,
    }
    saveJob(job)
    runHeadlessJob(job)
    sendJson(res, 202, { ok: true, job: { id: job.id, state: job.state, workspace: job.workspace } })
    return
  }

  if (p === '/api/muse-agent-link/tasks' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, jobs: listJobsForAccount(account) })
    return
  }

  if (p === '/api/muse-agent-link/task' && req.method === 'GET') {
    const job = loadJob(url.searchParams.get('id') || '')
    if (!job || (account.role !== 'owner' && job.ownerAccountId !== account.id)) {
      sendError(res, 404, 'job_not_found', 'Job not found.')
      return
    }
    sendJson(res, 200, { ok: true, job })
    return
  }

  if (p === '/api/muse-agent-link/task-cancel' && req.method === 'POST') {
    const id = url.searchParams.get('id') || ''
    const job = loadJob(id)
    if (!job || (account.role !== 'owner' && job.ownerAccountId !== account.id)) {
      sendError(res, 404, 'job_not_found', 'Job not found.')
      return
    }
    const child = runningJobs.get(id)
    if (!child) {
      sendError(res, 404, 'job_not_running', 'Job is not running.')
      return
    }
    try { child.kill() } catch {}
    sendJson(res, 200, { ok: true, cancelling: id })
    return
  }

  sendError(res, 404, 'not_found', `No route for ${req.method} ${p}`)
}

// ---------- Loopback Admin & Internal Router (127.0.0.1:47617) ----------

function checkInternalToken(req) {
  const given = String(req.headers['x-hub-internal-token'] || '')
  if (!given || given.length !== store.internalToken.length) return false
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(store.internalToken))
}

async function handleAdminAndInternal(req, res, url) {
  const p = url.pathname

  // CORS for local DSH & Antigravity UI cards (loopback server only)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Hub-Internal-Token')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // Only accept true loopback sockets
  if (!isLoopbackIp(req.socket?.remoteAddress || '')) {
    sendError(res, 403, 'forbidden_source', 'Loopback only.')
    return
  }

  // ---- Internal Adapter RPC ----
  if (p.startsWith('/internal/')) {
    if (!checkInternalToken(req)) {
      sendError(res, 401, 'unauthorized', 'Invalid internal token.')
      return
    }
    if (p === '/internal/adapters/dsh/register' && req.method === 'POST') {
      const body = await readJsonBody(req)
      if (!body.rpcBaseUrl || !String(body.rpcBaseUrl).startsWith('http://127.0.0.1:')) {
        sendError(res, 400, 'bad_request', 'Valid loopback rpcBaseUrl required.')
        return
      }
      const wasOnline = isDshAvailable()
      dshAdapter = {
        rpcBaseUrl: String(body.rpcBaseUrl).replace(/\/+$/, ''),
        version: String(body.version || '2.0.0'),
        pid: body.pid || null,
        lastSeenMs: Date.now(),
      }
      if (!wasOnline) {
        log(`[hub] DSH adapter registered at ${dshAdapter.rpcBaseUrl} (v${dshAdapter.version}, pid=${dshAdapter.pid})`)
      }
      // Return active DSH bindings so DSH adapter immediately watches them
      const dshBindings = [...store.bindings.values()]
        .filter((b) => b.agent === 'dsh' && b.state !== 'closed' && b.localSessionId)
        .map((b) => {
          const acc = store.getAccount(b.ownerAccountId)
          return {
            threadId: b.id,
            sessionId: b.localSessionId,
            ownerAccountId: b.ownerAccountId,
            approvalPolicy: acc?.approvalPolicy || 'local_only',
            cwd: b.workspace,
          }
        })
      sendJson(res, 200, { ok: true, bindings: dshBindings })
      return
    }

    if (p === '/internal/events' && req.method === 'POST') {
      const body = await readJsonBody(req)
      if (body?.type === 'agy.stop') {
        const outcome = agyAdapter.handleStopHook(String(body.sessionId || ''), body.payload || {})
        sendJson(res, 200, { ok: true, ...outcome })
        return
      }
      if (body?.type === 'agy.tool') {
        const outcome = agyAdapter.handlePostToolHook(String(body.sessionId || ''), body.payload || {})
        sendJson(res, 200, { ok: true, ...outcome })
        return
      }
      const outcome = handleInternalDshEvent(body)
      sendJson(res, 200, { ok: true, ...outcome })
      return
    }

    if (p === '/internal/agy/pre-invocation' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const response = agyAdapter.handlePreInvocationHook(String(body.conversationId || ''), body)
      sendJson(res, 200, response)
      return
    }

    sendError(res, 404, 'not_found', `Unknown internal route ${p}`)
    return
  }

  // ---- Local Admin API ----
  if (p === '/admin/overview' && req.method === 'GET') {
    const accounts = store.listAccounts()
    const tickets = store.listTickets()
    const bindings = [...store.bindings.values()]
      .filter((b) => b.state !== 'closed')
      .sort((a, b) => String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')))
      .map(threadView)
    sendJson(res, 200, {
      ok: true,
      version: HUB_VERSION,
      machine: os.hostname(),
      tailnetIp: tailscaleIpv4(),
      tailnetPort: TAILNET_PORT,
      tailnetListening: Boolean(tailnetServer?.listening),
      agents: buildPublicStatus().agents,
      wakeConfig: wake.getPublicConfig(),
      accounts,
      tickets,
      bindings,
      time: new Date().toISOString(),
    })
    return
  }

  if (p === '/admin/accounts' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      accounts: store.listAccounts(),
      tickets: store.listTickets(),
    })
    return
  }

  if (p === '/admin/pairing-tickets' && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req)
    } catch {
      sendError(res, 400, 'bad_request', 'Invalid JSON body.')
      return
    }
    const ticket = store.createPairingTicket(body)
    sendJson(res, 201, { ok: true, ticket })
    return
  }

  const delTicketMatch = p.match(/^\/admin\/pairing-tickets\/([^/]+)$/)
  if (delTicketMatch && req.method === 'DELETE') {
    const ok = store.deletePairingTicket(decodeURIComponent(delTicketMatch[1]))
    sendJson(res, ok ? 200 : 404, { ok })
    return
  }

  const accActionMatch = p.match(/^\/admin\/accounts\/([^/]+)(?:\/(revoke))?$/)
  if (accActionMatch) {
    const accId = decodeURIComponent(accActionMatch[1])
    const action = accActionMatch[2] || null
    if (!action && req.method === 'PATCH') {
      const body = await readJsonBody(req)
      const updated = store.updateAccount(accId, body)
      if (!updated) {
        sendError(res, 404, 'not_found', 'Account not found.')
        return
      }
      sendJson(res, 200, { ok: true, account: store.accountPublicView(updated) })
      return
    }
    if (action === 'revoke' && req.method === 'POST') {
      const ok = store.revokeAccount(accId, 'local-admin')
      sendJson(res, ok ? 200 : 404, { ok })
      return
    }
  }

  if (p === '/admin/wake/config' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, wakeConfig: wake.getPublicConfig() })
    return
  }

  if (p === '/admin/wake/config' && (req.method === 'POST' || req.method === 'PATCH')) {
    let body
    try {
      body = await readJsonBody(req)
    } catch {
      sendError(res, 400, 'bad_request', 'Invalid JSON body.')
      return
    }
    const updated = wake.saveConfig(body)
    store.audit('wake.config_updated', { smtpConfigured: updated.smtpConfigured, wechatAvailable: updated.wechatAvailable })
    sendJson(res, 200, { ok: true, wakeConfig: updated })
    return
  }

  if (p === '/admin/wake/test' && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req)
    } catch {
      sendError(res, 400, 'bad_request', 'Invalid JSON body.')
      return
    }
    const acc = store.getAccount(String(body.accountId || ''))
    if (!acc) {
      sendError(res, 404, 'not_found', 'Account not found.')
      return
    }
    const results = await wake.dispatchWake(acc, {
      type: 'turn.finished',
      agent: 'system',
      threadId: 'wake-test',
      seq: store._ensureEventLog(acc.id).seq,
    })
    sendJson(res, 200, { ok: true, accountId: acc.id, mode: acc.wake?.mode || 'none', results })
    return
  }

  if (p === '/admin/shutdown' && req.method === 'POST') {
    sendJson(res, 200, { ok: true, shuttingDown: true, pid: process.pid })
    setTimeout(() => shutdown('ADMIN_SHUTDOWN'), 100)
    return
  }

  if (p === '/admin/local-sessions' && req.method === 'GET') {
    const agySessions = agyAdapter.listLocalConversations(25)
    let dshSessions = []
    if (isDshAvailable()) {
      try {
        const resp = await dshRpc('/rpc/session/list', { limit: 25 })
        dshSessions = Array.isArray(resp.sessions) ? resp.sessions : []
      } catch {}
    }
    sendJson(res, 200, { ok: true, antigravity: agySessions, dsh: dshSessions })
    return
  }

  if (p === '/admin/attach' && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req)
    } catch {
      sendError(res, 400, 'bad_request', 'Invalid JSON body.')
      return
    }
    const account = store.getAccount(String(body.accountId || ''))
    if (!account || account.status !== 'active') {
      sendError(res, 404, 'not_found', 'Target account not found or inactive.')
      return
    }
    if (account.role !== 'owner') {
      sendError(res, 403, 'forbidden_role', 'Local sessions can only be attached to owner accounts.')
      return
    }
    const agent = body.agent === 'antigravity' ? 'antigravity' : body.agent === 'dsh' ? 'dsh' : null
    const localSessionId = String(body.localSessionId || '').trim()
    if (!agent || !localSessionId) {
      sendError(res, 400, 'bad_request', 'agent (dsh|antigravity) and localSessionId are required.')
      return
    }
    const existing = store.findBindingByLocalSession(agent, localSessionId)
    if (existing) {
      sendError(res, 409, 'session_already_bound', `Session already bound to ${existing.id} (${existing.ownerAccountId}).`)
      return
    }
    const binding = store.createBinding({
      ownerAccountId: account.id,
      agent,
      localSessionId,
      provisional: false,
      title: formatThreadTitle(account, body.title || `已挂载 ${localSessionId.slice(0, 8)}`),
      workspace: body.workspace || account.defaultWorkspace || DEFAULT_WORKSPACE,
      origin: 'local_attached',
    })
    if (agent === 'antigravity') {
      agyAdapter.ensureWatching(binding, { fromStart: false })
    } else if (isDshAvailable()) {
      await dshRpc('/rpc/binding/sync', {
        threadId: binding.id,
        sessionId: binding.localSessionId,
        ownerAccountId: account.id,
        approvalPolicy: account.approvalPolicy,
      }).catch(() => {})
    }
    store.appendEvent(account.id, {
      threadId: binding.id,
      agent,
      type: 'thread.state',
      payload: { state: 'active', localSessionId, title: binding.title, origin: 'local_attached' },
    })
    sendJson(res, 201, { ok: true, thread: threadView(binding) })
    return
  }

  // Also allow loopback callers/tests to hit /v2/* and /api/muse-agent-link/*
  if (p.startsWith('/v2/') || p.startsWith('/api/muse-agent-link/')) {
    await handlePublicApi(req, res, url)
    return
  }

  sendError(res, 404, 'not_found', `No admin route ${req.method} ${p}`)
}

// ---------- Legacy Loopback Server (127.0.0.1:47615) for AGY Pill + Pre-Restart DSH Compat ----------

function legacyTokenOk(req) {
  const given = extractBearer(req)
  if (!given || given.length !== store.legacyDaemonToken.length) return false
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(store.legacyDaemonToken))
}

async function handleLegacyDaemon(req, res, url) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const p = url.pathname
  if (p === '/status' && req.method === 'GET') {
    const agy = agyAdapter.status()
    const accounts = store.listAccounts().filter((a) => a.status === 'active')
    sendJson(res, 200, {
      ok: true,
      daemon: 'muse-agent-link',
      version: HUB_VERSION,
      backend: 'antigravity-desktop',
      machine: os.hostname(),
      hubPort: agy.hubPort,
      lsVersion: agy.lsVersion,
      conversations: [...store.bindings.values()].filter((b) => b.agent === 'antigravity' && b.state !== 'closed').length,
      accounts: accounts.length,
      onlineAccounts: accounts.filter((a) => a.online).length,
      dshAvailable: isDshAvailable(),
      tailnetListening: Boolean(tailnetServer?.listening),
      time: new Date().toISOString(),
    })
    return
  }
  if (!legacyTokenOk(req)) {
    sendError(res, 401, 'unauthorized', 'bad daemon token')
    return
  }
  if (p === '/permissions' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, permissions: [] })
    return
  }
  sendError(res, 410, 'gone', 'Upgrade DSH plugin to v2.0.0 (uses Muse Hub on :47617).')
}

// ---------- Start Servers + Auto-Bind Tailscale :47616 ----------

const adminServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${ADMIN_PORT}`)
    await handleAdminAndInternal(req, res, url)
  } catch (err) {
    log(`[admin] error: ${err?.message || err}`)
    sendError(res, err.status || 500, err.code || 'internal', String(err?.message || err))
  }
})

adminServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`[hub] single-instance guard: 127.0.0.1:${ADMIN_PORT} already in use, exiting cleanly.`)
    process.exit(0)
  }
  log(`[hub] admin server fatal error: ${err?.message || err}`)
  process.exit(1)
})

adminServer.listen(ADMIN_PORT, '127.0.0.1', () => {
  writePidFile()
  log(`[hub] v${HUB_VERSION} admin/internal listening on http://127.0.0.1:${ADMIN_PORT} (pid=${process.pid}, machine=${os.hostname()})`)
})

const legacyServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${LEGACY_PORT}`)
    await handleLegacyDaemon(req, res, url)
  } catch (err) {
    log(`[legacy] error: ${err?.message || err}`)
    sendError(res, 500, 'internal', String(err?.message || err))
  }
})

legacyServer.on('error', (err) => {
  log(`[legacy] port ${LEGACY_PORT} listen warning: ${err?.message || err}`)
})
legacyServer.listen(LEGACY_PORT, '127.0.0.1', () => {
  log(`[hub] legacy status compat listening on http://127.0.0.1:${LEGACY_PORT}`)
})

let tailnetServer = null
let tailnetBoundIp = null
let tailnetRetryWarned = false

function ensureTailnetListener() {
  const ip = tailscaleIpv4()
  if (!ip) return
  if (tailnetServer && tailnetServer.listening && tailnetBoundIp === ip) return
  if (tailnetServer) {
    try { tailnetServer.close() } catch {}
    tailnetServer = null
    tailnetBoundIp = null
  }
  const srv = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${ip}:${TAILNET_PORT}`)
      if (!url.pathname.startsWith('/v2/') && !url.pathname.startsWith('/api/muse-agent-link/')) {
        sendError(res, 404, 'not_found', 'Not found.')
        return
      }
      await handlePublicApi(req, res, url)
    } catch (err) {
      log(`[tailnet] error: ${err?.message || err}`)
      sendError(res, err.status || 500, err.code || 'internal', String(err?.message || err))
    }
  })
  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      if (!tailnetRetryWarned) {
        log(`[tailnet] ${ip}:${TAILNET_PORT} currently held (likely pre-restart DSH v0.6.0); will auto-claim every 5s once released.`)
        tailnetRetryWarned = true
      }
    } else {
      log(`[tailnet] listen error on ${ip}:${TAILNET_PORT}: ${err?.message || err}`)
    }
    if (tailnetServer === srv) {
      tailnetServer = null
      tailnetBoundIp = null
    }
  })
  srv.listen(TAILNET_PORT, ip, () => {
    tailnetBoundIp = ip
    tailnetRetryWarned = false
    log(`[hub] tailnet API listening on http://${ip}:${TAILNET_PORT} (/v2/* + /api/muse-agent-link/*)`)
  })
  tailnetServer = srv
}

ensureTailnetListener()
const tailnetTimer = setInterval(ensureTailnetListener, 5000)
tailnetTimer.unref?.()

// Graceful shutdown
function shutdown(sig) {
  log(`[hub] received ${sig}, shutting down`)
  clearInterval(tailnetTimer)
  agyAdapter.stop()
  removePidFileIfOurs()
  try { tailnetServer?.close() } catch {}
  try { adminServer.close() } catch {}
  try { legacyServer.close() } catch {}
  process.exit(0)
}
process.on('exit', () => removePidFileIfOurs())
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

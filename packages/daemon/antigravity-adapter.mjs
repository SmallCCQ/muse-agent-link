// Muse Hub v2 — Antigravity Desktop Runtime Adapter (with native AGY Hook acceleration)
// Drives Antigravity Desktop via language_server.exe agentapi + Connect RPC (SendUserCascadeMessage),
// accelerates turn completion / remote /stop / mid-turn steer via Antigravity native hooks
// (PreInvocation, PostToolUse, Stop), and keeps a persistent transcript.jsonl watcher as fallback
// plus local desktop user input sync.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const AGY_HOME = path.join(os.homedir(), '.gemini', 'antigravity')
const HUB_DIR = path.join(AGY_HOME, 'daemon')
const BRAIN_DIR = path.join(AGY_HOME, 'brain')
const LS_EXE = path.join(
  process.env.LOCALAPPDATA || '',
  'Programs',
  'antigravity',
  'resources',
  'bin',
  'language_server.exe'
)

const WATCH_INTERVAL_MS = 1200
const QUIET_SETTLE_MS = 3500
const PROGRESS_THROTTLE_MS = 2500
const STALL_HINT_MS = 90_000
const RESULT_MAX_CHARS = 12_000

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
  }
  return map[ext] || 'application/octet-stream'
}

export class AntigravityAdapter {
  constructor({ store, log = console.log }) {
    this.store = store
    this.log = log
    // bindingId -> watcher state
    this.watchers = new Map()
    // bindingId -> { turnId, startedAt, cancelled, pendingSteers: string[] }
    this.activeTurns = new Map()
    // bindingId -> boolean (whether workspace guidance was injected via PreInvocation)
    this.workspaceInjected = new Set()
    this._timer = null
  }

  start() {
    if (this._timer) return
    for (const b of this.store.bindings.values()) {
      if (b.agent === 'antigravity' && b.state !== 'closed' && b.localSessionId) {
        this.ensureWatching(b, { fromStart: false })
        this.workspaceInjected.add(b.id)
      }
    }
    this._timer = setInterval(() => this._tickWatchers(), WATCH_INTERVAL_MS)
    this._timer.unref?.()
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  listHubCandidates() {
    let files = []
    try {
      files = fs
        .readdirSync(HUB_DIR)
        .filter((f) => /^hub_\d+\.json$/.test(f))
        .map((f) => ({ f, mtime: fs.statSync(path.join(HUB_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
    } catch {}
    const out = []
    for (const { f } of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(HUB_DIR, f), 'utf8'))
        if (j.httpPort && j.csrfToken) out.push(j)
      } catch {}
    }
    return out
  }

  hubInfo() {
    return this.listHubCandidates()[0] || null
  }

  status() {
    const hub = this.hubInfo()
    return {
      available: Boolean(hub && fs.existsSync(LS_EXE)),
      hubPort: hub?.httpPort || null,
      lsVersion: hub?.lsVersion || null,
      runningTurns: this.activeTurns.size,
      watchedConversations: this.watchers.size,
      hooksSupported: true,
    }
  }

  transcriptPath(desktopId) {
    return path.join(BRAIN_DIR, desktopId, '.system_generated', 'logs', 'transcript.jsonl')
  }

  readSteps(desktopId, overridePath = null) {
    try {
      const p = overridePath && fs.existsSync(overridePath) ? overridePath : this.transcriptPath(desktopId)
      if (!fs.existsSync(p)) return []
      const raw = fs.readFileSync(p, 'utf8')
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

  listLocalConversations(limit = 30) {
    const items = []
    try {
      for (const dir of fs.readdirSync(BRAIN_DIR)) {
        const tp = this.transcriptPath(dir)
        if (!fs.existsSync(tp)) continue
        const st = fs.statSync(tp)
        let preview = ''
        try {
          const steps = this.readSteps(dir)
          const firstUser = steps.find((s) => s.type === 'USER_INPUT' && typeof s.content === 'string')
          if (firstUser) preview = firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 80)
        } catch {}
        items.push({
          agent: 'antigravity',
          localSessionId: dir,
          updatedAt: new Date(st.mtimeMs).toISOString(),
          mtimeMs: st.mtimeMs,
          preview,
        })
      }
    } catch {}
    items.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return items.slice(0, limit).map(({ mtimeMs, ...rest }) => rest)
  }

  ensureWatching(binding, { fromStart = false } = {}) {
    if (!binding?.id || !binding.localSessionId) return null
    const existing = this.watchers.get(binding.id)
    if (existing && existing.desktopId === binding.localSessionId) return existing

    let baselineStep = -1
    let fileSize = 0
    const tp = this.transcriptPath(binding.localSessionId)
    if (!fromStart) {
      const steps = this.readSteps(binding.localSessionId)
      baselineStep = steps.reduce((m, s) => Math.max(m, Number(s?.step_index ?? -1)), -1)
      try {
        fileSize = fs.statSync(tp).size
      } catch {}
    }

    const w = {
      bindingId: binding.id,
      desktopId: binding.localSessionId,
      lastStepIndex: baselineStep,
      lastFinalizedStepIndex: baselineStep,
      lastFileSize: fileSize,
      lastChangeAt: Date.now(),
      lastProgressAt: 0,
      turnActive: false,
      currentTurnId: null,
      stallHintSent: false,
      pendingReply: null,
      turnMedia: [],
    }
    this.watchers.set(binding.id, w)
    return w
  }

  unwatch(bindingId) {
    this.watchers.delete(bindingId)
    this.activeTurns.delete(bindingId)
    this.workspaceInjected.delete(bindingId)
  }

  _agentapi(args, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const hub = this.hubInfo()
      if (!hub) {
        reject(new Error('No Antigravity desktop hub found (is Antigravity Desktop running?)'))
        return
      }
      if (!fs.existsSync(LS_EXE)) {
        reject(new Error(`Antigravity language_server.exe not found at ${LS_EXE}`))
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
        try { child.kill() } catch {}
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
          reject(
            new Error(
              `agentapi ${args[0]}: ${
                typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error).slice(0, 300)
              }`
            )
          )
          return
        }
        resolve(parsed.response || {})
      })
    })
  }

  async _lsRpc(method, body) {
    const candidates = this.listHubCandidates()
    if (!candidates.length) {
      throw new Error('No Antigravity desktop hub found (is Antigravity Desktop running?)')
    }
    let lastErr = null
    for (const hub of candidates) {
      try {
        const res = await fetch(
          `http://127.0.0.1:${hub.httpPort}/exa.language_server_pb.LanguageServerService/${method}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-codeium-csrf-token': hub.csrfToken,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
          }
        )
        const text = await res.text()
        if (!res.ok) {
          throw new Error(`LS ${method} HTTP ${res.status}: ${text.slice(0, 300)}`)
        }
        try {
          return JSON.parse(text)
        } catch {
          return {}
        }
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr || new Error(`LS ${method} failed`)
  }

  async sendPrompt(binding, text, { turnId, mode = 'queue' }) {
    const existingTurn = this.activeTurns.get(binding.id)
    if (existingTurn) {
      if (mode === 'steer') {
        // Queue mid-turn steer for the next PreInvocation hook!
        existingTurn.pendingSteers.push(text)
        this.store.recordInboundEcho(binding.id, text)
        this.store.appendEvent(binding.ownerAccountId, {
          threadId: binding.id,
          agent: 'antigravity',
          type: 'output.progress',
          payload: {
            turnId: existingTurn.turnId,
            summary: 'Steer message queued for next model step',
          },
        })
        return { steered: true }
      }
      const err = new Error('A turn is already running on this Antigravity thread (use mode="steer" to interject).')
      err.code = 'busy'
      err.status = 409
      throw err
    }

    this.store.recordInboundEcho(binding.id, text)
    this.activeTurns.set(binding.id, {
      turnId,
      startedAt: Date.now(),
      cancelled: false,
      pendingSteers: [],
    })
    binding.state = 'running'
    this.store.saveBinding(binding)

    try {
      let watcher
      if (!binding.localSessionId) {
        const args = ['new-conversation']
        if (binding.title) args.push(`--title=${binding.title}`)
        if (binding.model) args.push(`--model=${binding.model}`)
        args.push(text)
        const resp = await this._agentapi(args)
        const newId = resp?.newConversation?.conversationId
        if (!newId) throw new Error('agentapi new-conversation returned no conversationId')
        binding.localSessionId = newId
        binding.provisional = false
        this.store.saveBinding(binding)
        this.log(`[agy-adapter] created desktop conversation ${newId} for thread ${binding.id}`)
        watcher = this.ensureWatching(binding, { fromStart: true })
        this.store.appendEvent(binding.ownerAccountId, {
          threadId: binding.id,
          agent: 'antigravity',
          type: 'thread.state',
          payload: { state: 'running', localSessionId: newId, title: binding.title },
        })
      } else {
        watcher = this.ensureWatching(binding, { fromStart: false })
        await this._lsRpc('SendUserCascadeMessage', {
          cascadeId: binding.localSessionId,
          items: [{ text }],
        })
      }

      if (watcher) {
        watcher.turnActive = true
        watcher.currentTurnId = turnId
        watcher.lastChangeAt = Date.now()
        watcher.stallHintSent = false
        watcher.pendingReply = null
        watcher.turnMedia = []
      }
      this.store.appendEvent(binding.ownerAccountId, {
        threadId: binding.id,
        agent: 'antigravity',
        type: 'turn.started',
        payload: { turnId, source: 'muse' },
      })
      return { steered: false }
    } catch (err) {
      this.activeTurns.delete(binding.id)
      binding.state = 'active'
      binding.lastTurn = {
        turnId,
        status: 'failed',
        finishedAt: new Date().toISOString(),
        resultText: '',
        error: String(err?.message || err),
      }
      this.store.saveBinding(binding)
      this.store.appendEvent(binding.ownerAccountId, {
        threadId: binding.id,
        agent: 'antigravity',
        type: 'turn.finished',
        payload: { turnId, status: 'failed', resultText: '', error: binding.lastTurn.error },
      })
      throw err
    }
  }

  cancelTurn(binding) {
    const active = this.activeTurns.get(binding.id)
    if (active) {
      // Keep cancel flag alive briefly so PreInvocation hook can hard-terminate the loop!
      active.cancelled = true
    } else {
      this.activeTurns.set(binding.id, {
        turnId: null,
        startedAt: Date.now(),
        cancelled: true,
        pendingSteers: [],
      })
    }
    const w = this.watchers.get(binding.id)
    if (w) {
      w.turnActive = false
      w.pendingReply = null
    }
    binding.state = 'active'
    this.store.saveBinding(binding)
    this.store.appendEvent(binding.ownerAccountId, {
      threadId: binding.id,
      agent: 'antigravity',
      type: 'turn.finished',
      payload: {
        turnId: active?.turnId || null,
        status: 'cancelled',
        resultText: '',
        error: 'Cancel signal sent (PreInvocation hook will terminate the next step).',
      },
    })
  }

  // ---------- Native AGY Hook Handlers ----------

  handlePreInvocationHook(conversationId, payload = {}) {
    const binding = this.store.findBindingByLocalSession('antigravity', conversationId)
    if (!binding || binding.state === 'closed') return {}

    const active = this.activeTurns.get(binding.id)
    if (active?.cancelled) {
      this.activeTurns.delete(binding.id)
      return {
        terminationBehavior: 'terminate',
        injectSteps: [
          {
            errorMessage: {
              userMessage: '当前回合已被 Muse 远程 /stop 中断。',
            },
          },
        ],
      }
    }

    const injectSteps = []

    // Soft workspace guidance on first Muse-initiated invocation when a custom workspace is set
    if (!this.workspaceInjected.has(binding.id) && binding.origin === 'muse' && binding.workspace) {
      this.workspaceInjected.add(binding.id)
      const owner = this.store.getAccount(binding.ownerAccountId)
      injectSteps.push({
        systemMessage: {
          systemMessage: `[Muse Link] 本会话由 Muse 账号「${owner?.label || binding.ownerAccountId}」发起，约定默认工作目录为：${binding.workspace}。除非指令明确指明其他路径，请优先在该目录内读写文件与执行命令。`,
        },
      })
    }

    // Drain any mid-turn steer messages queued from Muse
    if (active && Array.isArray(active.pendingSteers) && active.pendingSteers.length > 0) {
      const steers = active.pendingSteers.splice(0, active.pendingSteers.length)
      for (const s of steers) {
        injectSteps.push({ userMessage: s })
      }
    }

    return injectSteps.length > 0 ? { injectSteps } : {}
  }

  handlePostToolHook(conversationId, payload = {}) {
    const binding = this.store.findBindingByLocalSession('antigravity', conversationId)
    if (!binding || binding.state === 'closed') return { ignored: true }
    const w = this.ensureWatching(binding, { fromStart: false })
    const now = Date.now()
    if (w) {
      w.lastChangeAt = now
      w.stallHintSent = false
    }
    const toolName = payload.toolName || 'tool'
    if (w && now - w.lastProgressAt >= 1200) {
      w.lastProgressAt = now
      this.store.appendEvent(binding.ownerAccountId, {
        threadId: binding.id,
        agent: 'antigravity',
        type: 'output.progress',
        payload: {
          turnId: w.currentTurnId,
          activeTools: [toolName],
          summary: payload.error ? `${toolName} failed: ${String(payload.error).slice(0, 120)}` : `Completed ${toolName}`,
          via: 'hook',
        },
      })
    }
    return { ok: true }
  }

  handleStopHook(conversationId, payload = {}) {
    const binding = this.store.findBindingByLocalSession('antigravity', conversationId)
    if (!binding || binding.state === 'closed') return { ignored: true }

    const w = this.ensureWatching(binding, { fromStart: false })
    if (!w) return { ignored: true }

    // Immediately ingest any unread transcript steps up to now (eliminates 3.5s quiet wait!)
    const steps = this.readSteps(w.desktopId, payload.transcriptPath || null)
    const fresh = steps.filter((s) => Number(s?.step_index ?? -1) > w.lastStepIndex)
    const now = Date.now()
    for (const step of fresh) {
      const idx = Number(step.step_index ?? w.lastStepIndex + 1)
      if (idx > w.lastStepIndex) w.lastStepIndex = idx
      this._processStep(binding, w, step, now, { fromStopHook: true })
    }
    try {
      const tp = payload.transcriptPath && fs.existsSync(payload.transcriptPath)
        ? payload.transcriptPath
        : this.transcriptPath(w.desktopId)
      w.lastFileSize = fs.statSync(tp).size
    } catch {}

    const reason = String(payload.terminationReason || 'NO_TOOL_CALL')
    if (reason === 'USER_CANCELED') {
      if (w.turnActive || this.activeTurns.has(binding.id)) {
        this._finalizeTurn(binding, w, 'cancelled', '', 'Canceled in Antigravity Desktop', w.lastStepIndex)
      }
      return { ok: true, finalized: 'cancelled' }
    }
    if (reason === 'ERROR' || payload.error) {
      const errText = String(payload.error || 'Antigravity execution error').slice(0, 800)
      if (w.turnActive || this.activeTurns.has(binding.id)) {
        this._finalizeTurn(binding, w, 'failed', '', errText, w.lastStepIndex)
      }
      return { ok: true, finalized: 'failed' }
    }

    // Normal completion: pick pendingReply or latest PLANNER_RESPONSE past lastFinalizedStepIndex
    let replyContent = w.pendingReply?.content || ''
    let replyStepIdx = w.pendingReply?.stepIndex ?? w.lastStepIndex
    if (!replyContent) {
      const candidates = steps.filter(
        (s) =>
          Number(s?.step_index ?? -1) > w.lastFinalizedStepIndex &&
          s.type === 'PLANNER_RESPONSE' &&
          typeof s.content === 'string' &&
          s.content.trim()
      )
      if (candidates.length > 0) {
        const last = candidates[candidates.length - 1]
        replyContent = last.content.trim()
        replyStepIdx = Number(last.step_index ?? w.lastStepIndex)
      }
    }

    if (replyContent && replyStepIdx > w.lastFinalizedStepIndex) {
      this._finalizeTurn(binding, w, 'ok', replyContent, null, replyStepIdx)
      return { ok: true, finalized: 'ok', via: 'stop-hook' }
    }

    // Clear active turn lock even if no text reply existed (e.g. terminated by PreInvocation /stop)
    if (reason === 'TERMINAL_CUSTOM_HOOK') {
      this.activeTurns.delete(binding.id)
      w.turnActive = false
      binding.state = 'active'
      this.store.saveBinding(binding)
      return { ok: true, finalized: 'hook-terminated' }
    }

    return { ok: true, finalized: false }
  }

  // ---------- Persistent Transcript Watcher (Fallback + Local Desktop Sync) ----------

  _tickWatchers() {
    const now = Date.now()
    for (const [bindingId, w] of this.watchers.entries()) {
      const binding = this.store.bindings.get(bindingId)
      if (!binding || binding.state === 'closed' || !binding.localSessionId) {
        this.watchers.delete(bindingId)
        continue
      }
      const tp = this.transcriptPath(w.desktopId)
      let fileSize = -1
      try {
        fileSize = fs.statSync(tp).size
      } catch {
        continue
      }

      if (fileSize !== w.lastFileSize) {
        w.lastFileSize = fileSize
        w.lastChangeAt = now
        w.stallHintSent = false
        const steps = this.readSteps(w.desktopId)
        const fresh = steps.filter((s) => Number(s?.step_index ?? -1) > w.lastStepIndex)
        for (const step of fresh) {
          const idx = Number(step.step_index ?? w.lastStepIndex + 1)
          if (idx > w.lastStepIndex) w.lastStepIndex = idx
          this._processStep(binding, w, step, now)
        }
      }

      // Fallback finalizer in case Stop hook did not fire
      if (w.pendingReply && now - w.lastChangeAt >= QUIET_SETTLE_MS) {
        if (w.pendingReply.stepIndex > w.lastFinalizedStepIndex) {
          this._finalizeTurn(binding, w, 'ok', w.pendingReply.content, null, w.pendingReply.stepIndex)
        } else {
          w.pendingReply = null
        }
      } else if (w.turnActive && !w.stallHintSent && now - w.lastChangeAt >= STALL_HINT_MS) {
        w.stallHintSent = true
        this.store.appendEvent(binding.ownerAccountId, {
          threadId: binding.id,
          agent: 'antigravity',
          type: 'approval.hint_local_ui',
          payload: {
            stallSec: Math.round((now - w.lastChangeAt) / 1000),
            message: 'Antigravity transcript paused — may be awaiting local desktop approval.',
          },
        })
      }
    }
  }

  _processStep(binding, w, step, now, { fromStopHook = false } = {}) {
    if (Array.isArray(step.media)) {
      for (const m of step.media) {
        if (m?.uri && typeof m.uri === 'string') {
          w.turnMedia.push({ uri: m.uri, mime: m.mime_type || mimeFromExt(m.uri) })
        }
      }
    }

    if (step.type === 'USER_INPUT' && typeof step.content === 'string') {
      const isEcho = this.store.consumeEchoIfMatched(binding.id, step.content)
      if (!isEcho) {
        const localTurnId = `local_${Date.now().toString(36)}`
        w.turnActive = true
        w.currentTurnId = localTurnId
        w.pendingReply = null
        w.turnMedia = []
        w.stallHintSent = false
        binding.state = 'running'
        this.store.saveBinding(binding)
        this.store.appendEvent(binding.ownerAccountId, {
          threadId: binding.id,
          agent: 'antigravity',
          type: 'local.user_message',
          payload: { text: step.content.slice(0, 8000) },
        })
        this.store.appendEvent(binding.ownerAccountId, {
          threadId: binding.id,
          agent: 'antigravity',
          type: 'turn.started',
          payload: { turnId: localTurnId, source: 'local_ui' },
        })
      }
      return
    }

    if (step.status === 'ERROR' && !fromStopHook) {
      const errMsg = String(step.error_details || step.content || 'Antigravity step error').slice(0, 800)
      this._finalizeTurn(binding, w, 'failed', '', errMsg, Number(step.step_index ?? w.lastStepIndex))
      return
    }

    if (step.type === 'PLANNER_RESPONSE') {
      const toolNames = Array.isArray(step.tool_calls)
        ? step.tool_calls.map((tc) => tc?.name || tc?.function?.name || 'tool').filter(Boolean)
        : []
      if (!fromStopHook && toolNames.length > 0 && now - w.lastProgressAt >= PROGRESS_THROTTLE_MS) {
        w.lastProgressAt = now
        this.store.appendEvent(binding.ownerAccountId, {
          threadId: binding.id,
          agent: 'antigravity',
          type: 'output.progress',
          payload: {
            turnId: w.currentTurnId,
            activeTools: toolNames,
            summary: `Calling ${toolNames.join(', ')}`,
          },
        })
      }

      if (step.status === 'DONE' && typeof step.content === 'string' && step.content.trim()) {
        w.pendingReply = { content: step.content.trim(), stepIndex: Number(step.step_index ?? w.lastStepIndex) }
      }
    }
  }

  _finalizeTurn(binding, w, status, resultText, error, stepIndex = w.lastStepIndex) {
    if (stepIndex > w.lastFinalizedStepIndex) {
      w.lastFinalizedStepIndex = stepIndex
    }
    const turnId = w.currentTurnId
    const clipped = String(resultText || '').slice(-RESULT_MAX_CHARS)
    const mediaList = []
    const seenUris = new Set()
    for (const m of w.turnMedia || []) {
      if (!m.uri || seenUris.has(m.uri)) continue
      seenUris.add(m.uri)
      if (fs.existsSync(m.uri)) {
        mediaList.push(this.store.issueFileToken(binding.ownerAccountId, m.uri, { mime: m.mime }))
      }
    }

    w.turnActive = false
    w.currentTurnId = null
    w.pendingReply = null
    w.turnMedia = []
    w.stallHintSent = false
    this.activeTurns.delete(binding.id)

    binding.state = 'active'
    binding.lastTurn = {
      turnId,
      status,
      stopReason: status === 'ok' ? 'end_turn' : null,
      finishedAt: new Date().toISOString(),
      resultText: clipped,
      ...(error ? { error } : {}),
    }
    this.store.saveBinding(binding)

    this.store.appendEvent(binding.ownerAccountId, {
      threadId: binding.id,
      agent: 'antigravity',
      type: 'turn.finished',
      payload: {
        turnId,
        status,
        resultText: clipped,
        ...(error ? { error } : {}),
        ...(mediaList.length > 0 ? { media: mediaList } : {}),
      },
    })
  }
}

// Muse Hub v2 — Atomic Storage, Multi-Account Registry, Bindings, Event Log & Echo Guard
// UTF-8 without BOM. Zero external npm dependencies (pure Node.js built-ins).
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HUB_VERSION = '2.0.0'
export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
export const STATE_DIR = process.env.MUSE_LINK_STATE_DIR || path.join(DSH_HOME, 'muse-agent-link')
export const DEFAULT_WORKSPACE = path.join(STATE_DIR, 'workspace')

export const ACCOUNTS_PATH = path.join(STATE_DIR, 'accounts.json')
export const TICKETS_PATH = path.join(STATE_DIR, 'pairing-tickets.json')
export const BINDINGS_PATH = path.join(STATE_DIR, 'bindings.json')
export const EVENTS_DIR = path.join(STATE_DIR, 'events')
export const JOBS_DIR = path.join(STATE_DIR, 'jobs')
export const AUDIT_PATH = path.join(STATE_DIR, 'audit.jsonl')
export const INTERNAL_TOKEN_PATH = path.join(STATE_DIR, 'hub-internal-token.txt')
export const LEGACY_STATE_PATH = path.join(STATE_DIR, 'state.json')
export const LEGACY_THREADS_PATH = path.join(STATE_DIR, 'threads.json')
export const LEGACY_CONVS_PATH = path.join(STATE_DIR, 'desktop-conversations.json')
export const LEGACY_DAEMON_TOKEN_PATH = path.join(STATE_DIR, 'daemon-token.txt')

const RING_CAP = 1000
const MAX_ACTIVE_TICKETS = 5
const ECHO_TTL_MS = 30_000
const FILE_TOKEN_TTL_MS = 15 * 60_000
const PAIR_FAIL_WINDOW_MS = 60_000
const PAIR_FAIL_LIMIT = 5
const PAIR_COOLDOWN_MS = 5 * 60_000
const EVENT_FILE_ROTATE_BYTES = 5 * 1024 * 1024

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex')
}

export function normalizeIp(raw) {
  const s = String(raw || '').trim()
  if (s.startsWith('::ffff:')) return s.slice(7)
  return s
}

export function isLoopbackIp(ip) {
  const n = normalizeIp(ip)
  return n === '127.0.0.1' || n === '::1' || n === 'localhost'
}

export function normalizeTextForEcho(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim()
}

export function writeFileAtomicSync(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, content, 'utf8')
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, filePath)
      return
    } catch (err) {
      if (attempt === 4) {
        try {
          fs.writeFileSync(filePath, content, 'utf8')
        } finally {
          try { fs.unlinkSync(tmp) } catch {}
        }
        return
      }
      // Brief busy-wait fallback for Windows transient EPERM/EBUSY
      const until = Date.now() + 25 * (attempt + 1)
      while (Date.now() < until) {}
    }
  }
}

export function readJsonSafe(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function ensureRandomTokenFile(filePath) {
  try {
    const existing = fs.readFileSync(filePath, 'utf8').trim()
    if (existing.length >= 32) return existing
  } catch {}
  const fresh = crypto.randomBytes(32).toString('hex')
  writeFileAtomicSync(filePath, fresh)
  return fresh
}

function normPathForCompare(p) {
  const resolved = path.resolve(p)
  let real = resolved
  try {
    real = fs.realpathSync(resolved)
  } catch {}
  const slash = real.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? slash.toLowerCase() : slash
}

export class HubStore {
  constructor({ onEvent } = {}) {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.mkdirSync(DEFAULT_WORKSPACE, { recursive: true })
    fs.mkdirSync(EVENTS_DIR, { recursive: true })
    fs.mkdirSync(JOBS_DIR, { recursive: true })

    this.onEvent = typeof onEvent === 'function' ? onEvent : null
    this.internalToken = ensureRandomTokenFile(INTERNAL_TOKEN_PATH)
    this.legacyDaemonToken = ensureRandomTokenFile(LEGACY_DAEMON_TOKEN_PATH)

    this.accounts = new Map()
    this.tickets = new Map()
    this.bindings = new Map()
    this.eventLogs = new Map() // accountId -> { seq, events: [] }
    this.waiters = new Map()   // accountId -> Set<{ cursor, threadId, resolve, timer }>
    this.echoFingerprints = [] // { bindingId, hash, expiresAt }
    this.fileTokens = new Map() // token -> { accountId, filePath, name, mime, expiresAt }
    this.pairFailures = new Map() // ip -> { count, windowStart, cooldownUntil }
    this._lastSeenFlushMs = new Map() // accountId -> last disk persist ms

    this._loadAll()
    this._migrateFromV1IfNeeded()
  }

  _loadAll() {
    const accDoc = readJsonSafe(ACCOUNTS_PATH, null)
    if (accDoc && accDoc.accounts && typeof accDoc.accounts === 'object') {
      for (const [id, acc] of Object.entries(accDoc.accounts)) {
        if (acc && id) this.accounts.set(id, acc)
      }
    }
    const tktDoc = readJsonSafe(TICKETS_PATH, null)
    if (tktDoc && Array.isArray(tktDoc.tickets)) {
      const now = Date.now()
      for (const t of tktDoc.tickets) {
        if (t?.ticketId && !t.used && new Date(t.expiresAt).getTime() > now) {
          this.tickets.set(t.ticketId, t)
        }
      }
    }
    const bndDoc = readJsonSafe(BINDINGS_PATH, null)
    if (bndDoc && Array.isArray(bndDoc.bindings)) {
      for (const b of bndDoc.bindings) {
        if (b?.id) this.bindings.set(b.id, b)
      }
    }
    for (const accId of this.accounts.keys()) {
      this._loadEventLog(accId)
    }
  }

  _migrateFromV1IfNeeded() {
    let migrated = false
    if (this.accounts.size === 0 && fs.existsSync(LEGACY_STATE_PATH)) {
      const legacy = readJsonSafe(LEGACY_STATE_PATH, null)
      if (legacy && legacy.paired && legacy.tokenHash) {
        const now = new Date().toISOString()
        const acc = {
          id: 'acc_owner_victor',
          label: 'Victor·主号',
          role: 'owner',
          status: 'active',
          tokenHash: legacy.tokenHash,
          pinnedTailnetIps: [],
          enforceIpPin: false,
          allowedAgents: ['dsh', 'antigravity'],
          defaultAgent: 'antigravity',
          workspaceRoots: ['*'],
          defaultWorkspace: DEFAULT_WORKSPACE,
          forcedPreset: null,
          approvalPolicy: 'remote_or_local',
          maxConcurrentTurns: 4,
          wake: {
            enabled: false,
            mode: 'none',
            email: null,
            minIdleSec: 30,
            cooldownSec: 60,
          },
          lastPollAt: null,
          lastSeenIp: null,
          createdAt: legacy.pairedAt || legacy.createdAt || now,
          revokedAt: null,
          migratedFromV1: true,
        }
        this.accounts.set(acc.id, acc)
        this._saveAccounts()
        this._loadEventLog(acc.id)
        this.audit('account.migrated_v1', { accountId: acc.id, label: acc.label })
        migrated = true
      }
    }

    if (this.bindings.size === 0 && fs.existsSync(LEGACY_THREADS_PATH)) {
      const legacyThreads = readJsonSafe(LEGACY_THREADS_PATH, [])
      const defaultOwner = this.accounts.has('acc_owner_victor')
        ? 'acc_owner_victor'
        : ([...this.accounts.keys()][0] || 'acc_owner_victor')
      if (Array.isArray(legacyThreads) && legacyThreads.length > 0) {
        for (const t of legacyThreads) {
          if (!t?.id) continue
          const agent = t.agent === 'antigravity' ? 'antigravity' : 'dsh'
          const localSessionId =
            agent === 'antigravity'
              ? (t.desktopConversationId || null)
              : (t.sessionId || null)
          const binding = {
            id: t.id,
            ownerAccountId: defaultOwner,
            windowKey: null,
            agent,
            localSessionId,
            legacyConvId: agent === 'antigravity' ? (t.sessionId || null) : null,
            provisional: agent === 'antigravity' && !localSessionId,
            title: t.title || null,
            workspace: t.workspace || DEFAULT_WORKSPACE,
            model: null,
            preset: t.preset || null,
            state: t.state || 'active',
            origin: 'muse',
            createdAt: t.createdAt || new Date().toISOString(),
            lastActivityAt: t.lastActivityAt || t.createdAt || new Date().toISOString(),
            lastTurn: t.lastTurn || null,
          }
          this.bindings.set(binding.id, binding)
        }
        this._saveBindings()
        this.audit('bindings.migrated_v1', { count: this.bindings.size })
        migrated = true
      }
    }
    return migrated
  }

  _saveAccounts() {
    const obj = {}
    for (const [id, acc] of this.accounts.entries()) obj[id] = acc
    writeFileAtomicSync(ACCOUNTS_PATH, JSON.stringify({ version: 2, accounts: obj }, null, 2))
  }

  _saveTickets() {
    writeFileAtomicSync(
      TICKETS_PATH,
      JSON.stringify({ version: 2, tickets: [...this.tickets.values()] }, null, 2)
    )
  }

  _saveBindings() {
    writeFileAtomicSync(
      BINDINGS_PATH,
      JSON.stringify({ version: 2, bindings: [...this.bindings.values()] }, null, 2)
    )
  }

  audit(action, details = {}) {
    try {
      const entry = {
        at: new Date().toISOString(),
        action,
        ...details,
      }
      fs.appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n', 'utf8')
    } catch {}
  }

  // ---------- Accounts & Auth ----------

  accountPublicView(acc) {
    if (!acc) return null
    const now = Date.now()
    const onlineWindowMs = Math.max(Number(process.env.MUSE_ONLINE_WINDOW_SEC) || 900, 60) * 1000
    const lastPollMs = acc.lastPollAt ? new Date(acc.lastPollAt).getTime() : 0
    const lastSeenMs = acc.lastSeenAt ? new Date(acc.lastSeenAt).getTime() : 0
    const lastContactMs = Math.max(lastPollMs, lastSeenMs)
    const pollingActive = lastPollMs > 0 && now - lastPollMs <= 35_000
    const withinWindow = lastContactMs > 0 && now - lastContactMs <= onlineWindowMs

    let presence = 'never'
    let online = false
    if (acc.status !== 'active') {
      presence = 'offline'
      online = false
    } else if (pollingActive) {
      presence = 'active'
      online = true
    } else if (withinWindow) {
      presence = 'online'
      online = true
    } else if (lastContactMs > 0) {
      presence = 'offline'
      online = false
    } else {
      presence = 'never'
      online = false
    }

    const logState = this._ensureEventLog(acc.id)
    const threadCount = [...this.bindings.values()].filter(
      (b) => b.ownerAccountId === acc.id && b.state !== 'closed'
    ).length
    return {
      id: acc.id,
      label: acc.label,
      role: acc.role,
      status: acc.status,
      online,
      presence,
      lastContactAt: lastContactMs > 0 ? new Date(lastContactMs).toISOString() : null,
      allowedAgents: acc.allowedAgents || ['dsh', 'antigravity'],
      defaultAgent: acc.defaultAgent || 'antigravity',
      workspaceRoots: acc.workspaceRoots || [DEFAULT_WORKSPACE],
      defaultWorkspace: acc.defaultWorkspace || DEFAULT_WORKSPACE,
      forcedPreset: acc.forcedPreset || null,
      approvalPolicy: acc.approvalPolicy || (acc.role === 'owner' ? 'remote_or_local' : 'local_only'),
      maxConcurrentTurns: acc.maxConcurrentTurns || (acc.role === 'owner' ? 4 : 1),
      pinnedTailnetIps: acc.pinnedTailnetIps || [],
      enforceIpPin: Boolean(acc.enforceIpPin),
      wake: acc.wake || { enabled: false, mode: 'none', email: null, minIdleSec: 30, cooldownSec: 60 },
      lastPollAt: acc.lastPollAt || null,
      lastSeenAt: acc.lastSeenAt || null,
      lastSeenIp: acc.lastSeenIp || null,
      createdAt: acc.createdAt,
      revokedAt: acc.revokedAt || null,
      cursor: logState.seq,
      activeThreads: threadCount,
    }
  }

  listAccounts() {
    return [...this.accounts.values()].map((a) => this.accountPublicView(a))
  }

  getAccount(id) {
    return this.accounts.get(id) || null
  }

  authenticateToken(rawToken, remoteIp) {
    if (!rawToken || typeof rawToken !== 'string') {
      return { ok: false, status: 401, code: 'unauthorized', message: 'Missing Bearer token.' }
    }
    const givenHashBuf = Buffer.from(sha256Hex(rawToken), 'hex')
    let matched = null
    for (const acc of this.accounts.values()) {
      if (!acc.tokenHash || acc.tokenHash.length !== 64) continue
      const candidateBuf = Buffer.from(acc.tokenHash, 'hex')
      if (candidateBuf.length === givenHashBuf.length && crypto.timingSafeEqual(candidateBuf, givenHashBuf)) {
        matched = acc
        break
      }
    }
    if (!matched || matched.status !== 'active') {
      return { ok: false, status: 401, code: 'unauthorized', message: 'Invalid or revoked account token.' }
    }
    const ip = normalizeIp(remoteIp)
    if (matched.enforceIpPin && Array.isArray(matched.pinnedTailnetIps) && matched.pinnedTailnetIps.length > 0) {
      if (ip && !isLoopbackIp(ip) && !matched.pinnedTailnetIps.includes(ip)) {
        this.audit('auth.forbidden_source', { accountId: matched.id, remoteIp: ip })
        return {
          ok: false,
          status: 403,
          code: 'forbidden_source',
          message: `Source IP ${ip} is not allowed for account ${matched.id}.`,
        }
      }
    }
    const nowMs = Date.now()
    matched.lastSeenAt = new Date(nowMs).toISOString()
    let shouldSave = false
    if (ip && !isLoopbackIp(ip) && ip !== matched.lastSeenIp) {
      matched.lastSeenIp = ip
      shouldSave = true
    }
    const prevFlush = this._lastSeenFlushMs.get(matched.id) || 0
    if (shouldSave || nowMs - prevFlush >= 60_000) {
      this._lastSeenFlushMs.set(matched.id, nowMs)
      this._saveAccounts()
    }
    return { ok: true, account: matched }
  }

  updateAccount(accountId, patch = {}) {
    const acc = this.accounts.get(accountId)
    if (!acc) return null
    if (typeof patch.label === 'string' && patch.label.trim()) acc.label = patch.label.trim().slice(0, 48)
    if (Array.isArray(patch.allowedAgents)) {
      const valid = patch.allowedAgents.filter((a) => a === 'dsh' || a === 'antigravity')
      if (valid.length > 0) acc.allowedAgents = valid
    }
    if (patch.defaultAgent === 'dsh' || patch.defaultAgent === 'antigravity') {
      acc.defaultAgent = patch.defaultAgent
    }
    if (Array.isArray(patch.workspaceRoots)) {
      const clean = patch.workspaceRoots.map((s) => String(s).trim()).filter(Boolean)
      if (acc.role === 'collaborator') {
        const safe = clean.filter((r) => r !== '*')
        if (safe.length > 0) acc.workspaceRoots = safe
      } else if (clean.length > 0) {
        acc.workspaceRoots = clean
      }
    }
    if (typeof patch.defaultWorkspace === 'string' && patch.defaultWorkspace.trim()) {
      acc.defaultWorkspace = path.resolve(patch.defaultWorkspace.trim())
    }
    if (typeof patch.maxConcurrentTurns === 'number' && Number.isFinite(patch.maxConcurrentTurns)) {
      acc.maxConcurrentTurns = Math.min(Math.max(Math.floor(patch.maxConcurrentTurns), 1), 16)
    }
    if (patch.approvalPolicy === 'remote_or_local' || patch.approvalPolicy === 'local_only') {
      acc.approvalPolicy = acc.role === 'collaborator' ? 'local_only' : patch.approvalPolicy
    }
    if (typeof patch.enforceIpPin === 'boolean') {
      acc.enforceIpPin = acc.role === 'collaborator' ? true : patch.enforceIpPin
    }
    if (Array.isArray(patch.pinnedTailnetIps)) {
      acc.pinnedTailnetIps = patch.pinnedTailnetIps.map((x) => normalizeIp(x)).filter(Boolean)
    }
    if (patch.forcedPreset !== undefined) {
      acc.forcedPreset = patch.forcedPreset ? String(patch.forcedPreset) : null
    }
    if (patch.wake && typeof patch.wake === 'object') {
      acc.wake = {
        enabled: Boolean(patch.wake.enabled),
        mode: ['none', 'muse_mail', 'wechat', 'both'].includes(patch.wake.mode) ? patch.wake.mode : 'none',
        email: patch.wake.email ? String(patch.wake.email).trim() : null,
        minIdleSec: Math.max(Number(patch.wake.minIdleSec) || 30, 10),
        cooldownSec: Math.max(Number(patch.wake.cooldownSec) || 60, 15),
      }
    }
    this._saveAccounts()
    this.audit('account.updated', { accountId: acc.id })
    return acc
  }

  revokeAccount(accountId, reason = 'admin') {
    const acc = this.accounts.get(accountId)
    if (!acc) return false
    acc.status = 'revoked'
    acc.revokedAt = new Date().toISOString()
    this._saveAccounts()
    // Wake any hanging pollers so they immediately exit
    const set = this.waiters.get(accountId)
    if (set) {
      for (const w of set) {
        clearTimeout(w.timer)
        w.resolve({ revoked: true })
      }
      set.clear()
    }
    this.audit('account.revoked', { accountId, reason })
    return true
  }

  // ---------- Pairing Tickets ----------

  pruneExpiredTickets() {
    const now = Date.now()
    let changed = false
    for (const [id, t] of this.tickets.entries()) {
      if (t.used || new Date(t.expiresAt).getTime() <= now) {
        this.tickets.delete(id)
        changed = true
      }
    }
    if (changed) this._saveTickets()
  }

  listTickets() {
    this.pruneExpiredTickets()
    return [...this.tickets.values()]
  }

  createPairingTicket(opts = {}) {
    this.pruneExpiredTickets()
    if (this.tickets.size >= MAX_ACTIVE_TICKETS) {
      // Drop the oldest unused ticket to keep UX smooth
      const oldest = [...this.tickets.values()].sort((a, b) =>
        String(a.createdAt).localeCompare(String(b.createdAt))
      )[0]
      if (oldest) this.tickets.delete(oldest.ticketId)
    }
    const role = opts.role === 'collaborator' ? 'collaborator' : 'owner'
    const label =
      (typeof opts.label === 'string' && opts.label.trim().slice(0, 48)) ||
      (role === 'collaborator' ? '协作账户' : `Muse·账号${this.accounts.size + 1}`)
    const allowedAgents = Array.isArray(opts.allowedAgents)
      ? opts.allowedAgents.filter((a) => a === 'dsh' || a === 'antigravity')
      : ['dsh', 'antigravity']
    const finalAgents = allowedAgents.length > 0 ? allowedAgents : ['dsh', 'antigravity']

    let workspaceRoots
    if (role === 'collaborator') {
      const provided = Array.isArray(opts.workspaceRoots)
        ? opts.workspaceRoots.map((s) => String(s).trim()).filter((s) => s && s !== '*')
        : []
      const defaultCollabWs = path.join(STATE_DIR, 'collab-workspace')
      fs.mkdirSync(defaultCollabWs, { recursive: true })
      workspaceRoots = provided.length > 0 ? provided : [defaultCollabWs]
    } else {
      const provided = Array.isArray(opts.workspaceRoots)
        ? opts.workspaceRoots.map((s) => String(s).trim()).filter(Boolean)
        : []
      workspaceRoots = provided.length > 0 ? provided : ['*']
    }

    const defaultWorkspace =
      (typeof opts.defaultWorkspace === 'string' && opts.defaultWorkspace.trim()) ||
      (workspaceRoots[0] && workspaceRoots[0] !== '*' ? workspaceRoots[0] : DEFAULT_WORKSPACE)
    const ttlSec = Math.min(Math.max(Number(opts.ttlSec) || 600, 60), 3600)
    const now = Date.now()
    const ticket = {
      ticketId: `tkt_${crypto.randomBytes(6).toString('hex')}`,
      code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
      label,
      role,
      allowedAgents: finalAgents,
      defaultAgent:
        opts.defaultAgent && finalAgents.includes(opts.defaultAgent) ? opts.defaultAgent : finalAgents[0],
      workspaceRoots,
      defaultWorkspace,
      forcedPreset:
        role === 'collaborator'
          ? (opts.forcedPreset ? String(opts.forcedPreset) : 'workspace-write')
          : (opts.forcedPreset ? String(opts.forcedPreset) : null),
      approvalPolicy: role === 'collaborator' ? 'local_only' : (opts.approvalPolicy === 'local_only' ? 'local_only' : 'remote_or_local'),
      maxConcurrentTurns:
        Number(opts.maxConcurrentTurns) || (role === 'collaborator' ? 1 : 4),
      enforceIpPin: role === 'collaborator' ? true : Boolean(opts.enforceIpPin),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlSec * 1000).toISOString(),
      used: false,
    }
    this.tickets.set(ticket.ticketId, ticket)
    this._saveTickets()
    this.audit('pairing_ticket.created', { ticketId: ticket.ticketId, label: ticket.label, role: ticket.role })
    return ticket
  }

  deletePairingTicket(ticketId) {
    const existed = this.tickets.delete(ticketId)
    if (existed) this._saveTickets()
    return existed
  }

  redeemPairingTicket(code, { remoteIp, clientName } = {}) {
    this.pruneExpiredTickets()
    const ip = normalizeIp(remoteIp || 'unknown')
    const now = Date.now()

    const failState = this.pairFailures.get(ip)
    if (failState && failState.cooldownUntil > now) {
      return {
        ok: false,
        status: 429,
        code: 'rate_limited',
        message: 'Too many invalid pairing attempts; try again later.',
      }
    }

    const given = String(code || '').trim()
    let matched = null
    for (const t of this.tickets.values()) {
      if (!t.used && t.code === given && new Date(t.expiresAt).getTime() > now) {
        matched = t
        break
      }
    }
    if (!matched) {
      const entry =
        failState && now - failState.windowStart <= PAIR_FAIL_WINDOW_MS
          ? failState
          : { count: 0, windowStart: now, cooldownUntil: 0 }
      entry.count += 1
      if (entry.count >= PAIR_FAIL_LIMIT) {
        entry.cooldownUntil = now + PAIR_COOLDOWN_MS
      }
      this.pairFailures.set(ip, entry)
      this.audit('pairing.failed', { remoteIp: ip })
      return {
        ok: false,
        status: 400,
        code: 'pairing_code_invalid',
        message: 'Pairing code is invalid, used, or expired.',
      }
    }

    this.pairFailures.delete(ip)
    matched.used = true
    this.tickets.delete(matched.ticketId)
    this._saveTickets()

    const token = crypto.randomBytes(32).toString('hex')
    const accountId = `acc_${matched.role === 'collaborator' ? 'collab' : 'owner'}_${crypto.randomBytes(4).toString('hex')}`
    const pinnedTailnetIps = ip && !isLoopbackIp(ip) && ip !== 'unknown' ? [ip] : []
    const acc = {
      id: accountId,
      label: matched.label,
      role: matched.role,
      status: 'active',
      tokenHash: sha256Hex(token),
      pinnedTailnetIps,
      enforceIpPin: matched.role === 'collaborator' ? pinnedTailnetIps.length > 0 : Boolean(matched.enforceIpPin),
      allowedAgents: matched.allowedAgents,
      defaultAgent: matched.defaultAgent,
      workspaceRoots: matched.workspaceRoots,
      defaultWorkspace: matched.defaultWorkspace,
      forcedPreset: matched.forcedPreset,
      approvalPolicy: matched.approvalPolicy,
      maxConcurrentTurns: matched.maxConcurrentTurns,
      wake: {
        enabled: false,
        mode: 'none',
        email: null,
        minIdleSec: 30,
        cooldownSec: 60,
      },
      clientName: clientName ? String(clientName).slice(0, 64) : null,
      lastPollAt: null,
      lastSeenIp: ip !== 'unknown' ? ip : null,
      createdAt: new Date(now).toISOString(),
      revokedAt: null,
    }
    this.accounts.set(acc.id, acc)
    this._saveAccounts()
    this._ensureEventLog(acc.id)
    this.audit('pairing.succeeded', { accountId: acc.id, label: acc.label, role: acc.role, remoteIp: ip })
    return { ok: true, account: acc, token }
  }

  // ---------- Workspace ACL ----------

  resolveAllowedWorkspace(account, requestedWorkspace) {
    const raw = requestedWorkspace
      ? String(requestedWorkspace).trim()
      : (account.defaultWorkspace || DEFAULT_WORKSPACE)
    const resolved = path.resolve(raw)
    if (!fs.existsSync(resolved)) {
      if (!requestedWorkspace) {
        fs.mkdirSync(resolved, { recursive: true })
      } else {
        return {
          ok: false,
          status: 400,
          code: 'workspace_not_allowed',
          message: `Workspace does not exist: ${resolved}`,
        }
      }
    }
    let st
    try {
      st = fs.statSync(resolved)
    } catch {
      return { ok: false, status: 400, code: 'workspace_not_allowed', message: `Cannot stat workspace: ${resolved}` }
    }
    if (!st.isDirectory()) {
      return { ok: false, status: 400, code: 'workspace_not_allowed', message: `Workspace is not a directory: ${resolved}` }
    }
    const canonical = fs.realpathSync(resolved)
    const roots = Array.isArray(account.workspaceRoots) ? account.workspaceRoots : [DEFAULT_WORKSPACE]
    if (account.role === 'owner' && roots.includes('*')) {
      return { ok: true, workspace: canonical }
    }
    const targetNorm = normPathForCompare(canonical)
    for (const r of roots) {
      if (!r || r === '*') continue
      const rootNorm = normPathForCompare(r)
      if (targetNorm === rootNorm || targetNorm.startsWith(rootNorm + '/')) {
        return { ok: true, workspace: canonical }
      }
    }
    this.audit('workspace.denied', { accountId: account.id, requested: canonical })
    return {
      ok: false,
      status: 400,
      code: 'workspace_not_allowed',
      message: `Workspace is outside allowed roots for account ${account.id}.`,
    }
  }

  resolveAllowedFile(account, workspace, relPath) {
    const wsCheck = this.resolveAllowedWorkspace(account, workspace)
    if (!wsCheck.ok) return wsCheck
    const candidate = path.resolve(wsCheck.workspace, String(relPath || ''))
    if (!fs.existsSync(candidate)) {
      return { ok: false, status: 404, code: 'file_not_found', message: 'File not found.' }
    }
    const st = fs.statSync(candidate)
    if (!st.isFile()) {
      return { ok: false, status: 400, code: 'bad_request', message: 'Path is not a regular file.' }
    }
    const realFile = fs.realpathSync(candidate)
    const wsNorm = normPathForCompare(wsCheck.workspace)
    const fileNorm = normPathForCompare(realFile)
    if (fileNorm !== wsNorm && !fileNorm.startsWith(wsNorm + '/')) {
      return { ok: false, status: 400, code: 'workspace_not_allowed', message: 'File escapes workspace root.' }
    }
    return { ok: true, filePath: realFile, size: st.size }
  }

  // ---------- Bindings (Threads) ----------

  canAccessBinding(account, binding, { allowCrossOwnerRead = false } = {}) {
    if (!account || !binding) return false
    if (binding.ownerAccountId === account.id) return true
    if (allowCrossOwnerRead && account.role === 'owner') {
      const ownerAcc = this.accounts.get(binding.ownerAccountId)
      if (!ownerAcc || ownerAcc.role === 'owner') return true
    }
    return false
  }

  findBinding(idOrLocal) {
    if (!idOrLocal) return null
    if (this.bindings.has(idOrLocal)) return this.bindings.get(idOrLocal)
    for (const b of this.bindings.values()) {
      if (b.localSessionId === idOrLocal || b.legacyConvId === idOrLocal) return b
    }
    return null
  }

  findBindingByLocalSession(agent, localSessionId) {
    if (!localSessionId) return null
    for (const b of this.bindings.values()) {
      if (b.agent === agent && b.localSessionId === localSessionId && b.state !== 'closed') {
        return b
      }
    }
    return null
  }

  findReusableByWindowKey(accountId, agent, windowKey) {
    if (!windowKey) return null
    for (const b of this.bindings.values()) {
      if (
        b.ownerAccountId === accountId &&
        b.agent === agent &&
        b.windowKey === windowKey &&
        b.state !== 'closed'
      ) {
        return b
      }
    }
    return null
  }

  listBindingsForAccount(account, { scope = 'mine', includeClosed = false } = {}) {
    const effectiveScope = account.role === 'owner' && scope === 'owner' ? 'owner' : 'mine'
    return [...this.bindings.values()]
      .filter((b) => {
        if (!includeClosed && b.state === 'closed') return false
        if (effectiveScope === 'mine') return b.ownerAccountId === account.id
        const ownerAcc = this.accounts.get(b.ownerAccountId)
        return b.ownerAccountId === account.id || !ownerAcc || ownerAcc.role === 'owner'
      })
      .sort((a, b) => String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')))
  }

  createBinding({
    ownerAccountId,
    agent,
    localSessionId = null,
    provisional = false,
    title = null,
    workspace = DEFAULT_WORKSPACE,
    windowKey = null,
    model = null,
    preset = null,
    origin = 'muse',
  }) {
    const now = new Date().toISOString()
    const b = {
      id: `thr_${crypto.randomBytes(8).toString('hex')}`,
      ownerAccountId,
      windowKey: windowKey ? String(windowKey).trim().slice(0, 128) : null,
      agent,
      localSessionId,
      legacyConvId: null,
      provisional: Boolean(provisional),
      title: title || null,
      workspace,
      model: model || null,
      preset: preset || null,
      state: 'active',
      origin,
      createdAt: now,
      lastActivityAt: now,
      lastTurn: null,
    }
    this.bindings.set(b.id, b)
    this._saveBindings()
    this.audit('thread.created', {
      threadId: b.id,
      accountId: ownerAccountId,
      agent,
      origin,
      windowKey: b.windowKey,
    })
    return b
  }

  saveBinding(binding) {
    if (!binding?.id) return
    binding.lastActivityAt = new Date().toISOString()
    this.bindings.set(binding.id, binding)
    this._saveBindings()
  }

  transferBinding(bindingId, newOwnerAccountId) {
    const b = this.bindings.get(bindingId)
    if (!b) return null
    const fromAccountId = b.ownerAccountId
    b.ownerAccountId = newOwnerAccountId
    this.saveBinding(b)
    this.audit('thread.transferred', { threadId: b.id, fromAccountId, toAccountId: newOwnerAccountId })
    if (fromAccountId && fromAccountId !== newOwnerAccountId) {
      this.appendEvent(fromAccountId, {
        threadId: b.id,
        agent: b.agent,
        type: 'thread.transferred',
        payload: { fromAccountId, toAccountId: newOwnerAccountId },
      })
    }
    this.appendEvent(newOwnerAccountId, {
      threadId: b.id,
      agent: b.agent,
      type: 'thread.transferred',
      payload: { fromAccountId, toAccountId: newOwnerAccountId },
    })
    return b
  }

  // ---------- Per-Account Multiplexed Events ----------

  _eventFilePath(accountId) {
    const safe = String(accountId).replace(/[^a-zA-Z0-9_-]/g, '_')
    return path.join(EVENTS_DIR, `${safe}.jsonl`)
  }

  _loadEventLog(accountId) {
    const file = this._eventFilePath(accountId)
    const state = { seq: 0, events: [] }
    try {
      if (fs.existsSync(file)) {
        const lines = fs.readFileSync(file, 'utf8').split('\n')
        for (const line of lines) {
          const t = line.trim()
          if (!t) continue
          try {
            const ev = JSON.parse(t)
            if (Number.isSafeInteger(ev?.seq)) {
              if (ev.seq > state.seq) state.seq = ev.seq
              state.events.push(ev)
            }
          } catch {}
        }
        if (state.events.length > RING_CAP) {
          state.events.splice(0, state.events.length - RING_CAP)
        }
      }
    } catch {}
    this.eventLogs.set(accountId, state)
    return state
  }

  _ensureEventLog(accountId) {
    let state = this.eventLogs.get(accountId)
    if (!state) state = this._loadEventLog(accountId)
    return state
  }

  appendEvent(accountId, { threadId, agent, type, payload = {} }) {
    if (!accountId) return null
    const logState = this._ensureEventLog(accountId)
    logState.seq += 1
    const ev = {
      seq: logState.seq,
      accountId,
      threadId: threadId || null,
      agent: agent || null,
      type,
      at: new Date().toISOString(),
      payload,
    }
    logState.events.push(ev)
    if (logState.events.length > RING_CAP) {
      logState.events.splice(0, logState.events.length - RING_CAP)
    }

    const file = this._eventFilePath(accountId)
    try {
      fs.appendFileSync(file, JSON.stringify(ev) + '\n', 'utf8')
      const st = fs.statSync(file)
      if (st.size > EVENT_FILE_ROTATE_BYTES) {
        const tail = logState.events.map((e) => JSON.stringify(e)).join('\n') + '\n'
        writeFileAtomicSync(file, tail)
      }
    } catch {}

    // Notify pending long-poll waiters for this account
    const wset = this.waiters.get(accountId)
    if (wset && wset.size > 0) {
      for (const w of [...wset]) {
        if (ev.seq > w.cursor && (!w.threadId || w.threadId === ev.threadId)) {
          wset.delete(w)
          clearTimeout(w.timer)
          w.resolve({ woke: true })
        }
      }
    }

    if (this.onEvent) {
      try {
        this.onEvent(ev, this.accounts.get(accountId))
      } catch {}
    }
    return ev
  }

  readEventsSince(accountId, cursor = 0, { threadId = null, limit = 100 } = {}) {
    const logState = this._ensureEventLog(accountId)
    const filtered = logState.events.filter(
      (e) => e.seq > cursor && (!threadId || e.threadId === threadId)
    )
    const hasMore = filtered.length > limit
    const slice = hasMore ? filtered.slice(0, limit) : filtered
    const nextCursor = slice.length > 0 ? slice[slice.length - 1].seq : Math.max(cursor, logState.seq)
    return { cursor: nextCursor, latestSeq: logState.seq, hasMore, events: slice }
  }

  async pollEvents(accountId, { cursor = 0, waitSec = 0, threadId = null, limit = 100 } = {}) {
    const acc = this.accounts.get(accountId)
    if (acc) {
      acc.lastPollAt = new Date().toISOString()
    }
    const immediate = this.readEventsSince(accountId, cursor, { threadId, limit })
    const clampedWait = Math.min(Math.max(Number(waitSec) || 0, 0), 20)
    if (immediate.events.length > 0 || clampedWait <= 0) {
      return immediate
    }

    await new Promise((resolve) => {
      let wset = this.waiters.get(accountId)
      if (!wset) {
        wset = new Set()
        this.waiters.set(accountId, wset)
      }
      const entry = {
        cursor,
        threadId,
        resolve,
        timer: setTimeout(() => {
          wset.delete(entry)
          resolve({ timeout: true })
        }, clampedWait * 1000),
      }
      wset.add(entry)
    })

    if (acc) {
      acc.lastPollAt = new Date().toISOString()
    }
    return this.readEventsSince(accountId, cursor, { threadId, limit })
  }

  // ---------- Echo Suppression ----------

  recordInboundEcho(bindingId, text) {
    const norm = normalizeTextForEcho(text)
    if (!norm) return
    const now = Date.now()
    this._pruneEcho(now)
    this.echoFingerprints.push({
      bindingId,
      hash: sha256Hex(norm),
      expiresAt: now + ECHO_TTL_MS,
    })
  }

  consumeEchoIfMatched(bindingId, text) {
    const norm = normalizeTextForEcho(text)
    if (!norm) return true
    const now = Date.now()
    this._pruneEcho(now)
    const hash = sha256Hex(norm)
    const idx = this.echoFingerprints.findIndex(
      (f) => f.bindingId === bindingId && f.hash === hash && f.expiresAt > now
    )
    if (idx >= 0) {
      this.echoFingerprints.splice(idx, 1)
      return true
    }
    return false
  }

  _pruneEcho(now = Date.now()) {
    this.echoFingerprints = this.echoFingerprints.filter((f) => f.expiresAt > now)
  }

  // ---------- Short-lived File Tokens ----------

  issueFileToken(accountId, filePath, { name = null, mime = 'application/octet-stream' } = {}) {
    const now = Date.now()
    for (const [k, v] of this.fileTokens.entries()) {
      if (v.expiresAt <= now) this.fileTokens.delete(k)
    }
    const token = `ft_${crypto.randomBytes(16).toString('hex')}`
    const resolved = path.resolve(filePath)
    this.fileTokens.set(token, {
      accountId,
      filePath: resolved,
      name: name || path.basename(resolved),
      mime,
      expiresAt: now + FILE_TOKEN_TTL_MS,
    })
    return {
      token,
      url: `/v2/files/${token}`,
      name: name || path.basename(resolved),
      mime,
      expiresAt: new Date(now + FILE_TOKEN_TTL_MS).toISOString(),
    }
  }

  resolveFileToken(accountId, token) {
    const entry = this.fileTokens.get(token)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      this.fileTokens.delete(token)
      return null
    }
    if (entry.accountId !== accountId) return null
    if (!fs.existsSync(entry.filePath)) return null
    return entry
  }
}

// Muse Hub v2 — Automated End-to-End Verification Suite
// Spawns an isolated Muse Hub instance on temp ports + temp state dir, verifies:
//   1. v1 -> v2 auto-migration & backward-compatible /api/muse-agent-link/* routes
//   2. Multi-account pairing tickets (owner + collaborator) via real muse_link_client.py
//   3. Strict collaborator isolation (404 owner threads, 403 takeover/agent/approval, 400 path escape)
//   4. Idempotent windowKey reuse & cross-owner takeover
//   5. Echo suppression + local.user_message bidirectional sync
//   6. Account-level multiplexed long-poll immediate wake + Python client `send --wait`
//   7. Account revocation (401 immediately)
//   8. Live production Hub (:47615 / :47617) non-destructive smoke check
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const HUB_ENTRY = path.join(ROOT, 'packages', 'daemon', 'muse-hub.mjs')
const PY_CLIENT = path.join(ROOT, 'tools', 'muse_link_client.py')

const TEST_ADMIN_PORT = 47717
const TEST_LEGACY_PORT = 47715
const TEST_TAILNET_PORT = 47716
const TEST_COLLAB_PORT = 47719
const BASE = `http://127.0.0.1:${TEST_ADMIN_PORT}`

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-hub-e2e-'))
const museHome = path.join(tmpDir, 'muse-home')
const collabSandbox = path.join(tmpDir, 'collab-sandbox')
fs.mkdirSync(collabSandbox, { recursive: true })
fs.writeFileSync(path.join(collabSandbox, 'allowed.txt'), 'SAFE_DATA', 'utf8')
fs.writeFileSync(path.join(tmpDir, 'secret-outside.txt'), 'TOP_SECRET', 'utf8')

// Pre-seed legacy v1 state.json & threads.json to test zero-downtime migration
const legacyToken = crypto.randomBytes(32).toString('hex')
const legacyTokenHash = crypto.createHash('sha256').update(legacyToken).digest('hex')
fs.writeFileSync(
  path.join(tmpDir, 'state.json'),
  JSON.stringify({
    plugin: 'muse-agent-link',
    version: '0.6.0',
    machine: 'TEST-PC',
    paired: true,
    tokenHash: legacyTokenHash,
    pairedAt: '2026-11-22T04:11:27.804Z',
  }),
  'utf8'
)
fs.writeFileSync(
  path.join(tmpDir, 'threads.json'),
  JSON.stringify([
    {
      id: 'legacy-thr-001',
      agent: 'dsh',
      sessionId: 'session-legacy-001',
      workspace: tmpDir,
      title: 'Muse 直连 · legacy',
      state: 'active',
      createdAt: '2026-11-22T04:12:00.000Z',
      lastActivityAt: '2026-11-22T04:12:00.000Z',
    },
  ]),
  'utf8'
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, pathname, { body, token, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = text
  try { data = JSON.parse(text) } catch {}
  return { status: res.status, data }
}

function runPy(args, envExtra = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'python',
      [PY_CLIENT, '--machine', 'test-pc', '--host', '127.0.0.1', '--port', String(TEST_ADMIN_PORT), '--direct', ...args],
      {
        env: { ...process.env, MUSE_LINK_HOME: museHome, ...envExtra },
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`runPy failed: ${err.message}\nSTDERR: ${stderr}\nSTDOUT: ${stdout}`))
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch (e) {
          reject(new Error(`runPy bad JSON: ${e.message}\nSTDOUT: ${stdout}`))
        }
      }
    )
  })
}

// Start isolated Muse Hub process
const hubProc = spawn(process.execPath, [HUB_ENTRY], {
  env: {
    ...process.env,
    MUSE_LINK_STATE_DIR: tmpDir,
    MUSE_HUB_ADMIN_PORT: String(TEST_ADMIN_PORT),
    MUSE_HUB_LEGACY_PORT: String(TEST_LEGACY_PORT),
    MUSE_HUB_TAILNET_PORT: String(TEST_TAILNET_PORT),
    MUSE_HUB_COLLAB_PORT: String(TEST_COLLAB_PORT),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let mockDshServer = null

async function cleanup() {
  try { mockDshServer?.close() } catch {}
  try { hubProc.kill() } catch {}
  await sleep(300)
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
}

try {
  // Wait for Hub to come up
  let ready = false
  for (let i = 0; i < 30; i++) {
    try {
      const r = await api('GET', '/v2/status')
      if (r.status === 200 && r.data.ok) {
        ready = true
        break
      }
    } catch {}
    await sleep(150)
  }
  assert.equal(ready, true, 'Isolated Muse Hub did not become ready')
  console.log('[PASS] 1. Isolated Muse Hub booted cleanly')

  // Verify v1 -> v2 migration & legacy token compat
  const meLegacy = await api('GET', '/v2/me', { token: legacyToken })
  assert.equal(meLegacy.status, 200)
  assert.equal(meLegacy.data.account.id, 'acc_owner_victor')
  assert.equal(meLegacy.data.account.role, 'owner')

  const v1Threads = await api('GET', '/api/muse-agent-link/threads', { token: legacyToken })
  assert.equal(v1Threads.status, 200)
  assert.equal(v1Threads.data.threads.some((t) => t.id === 'legacy-thr-001'), true)
  console.log('[PASS] 2. v1 -> v2 zero-downtime migration & /api/muse-agent-link/* compatibility')

  // Register mock DSH Adapter
  const internalToken = fs.readFileSync(path.join(tmpDir, 'hub-internal-token.txt'), 'utf8').trim()
  const mockCalls = []
  let mockSessionCounter = 0

  mockDshServer = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    mockCalls.push({ path: req.url, body })

    if (req.url === '/rpc/session/create') {
      mockSessionCounter += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, sessionId: `session-mock-${mockSessionCounter}`, title: body.title }))
      return
    }
    if (req.url === '/rpc/binding/sync' || req.url === '/rpc/session/cancel' || req.url === '/rpc/approval/decide') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.url === '/rpc/session/prompt') {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      // Simulate async DSH echo + reply
      setTimeout(async () => {
        await api('POST', '/internal/events', {
          headers: { 'x-hub-internal-token': internalToken },
          body: { type: 'user.message', sessionId: body.sessionId, threadId: body.threadId, payload: { text: body.text } },
        })
        await api('POST', '/internal/events', {
          headers: { 'x-hub-internal-token': internalToken },
          body: {
            type: 'turn.finished',
            sessionId: body.sessionId,
            threadId: body.threadId,
            payload: { turnId: body.turnId, status: 'ok', resultText: `ECHO_REPLY:${body.text}` },
          },
        })
      }, 200)
      return
    }
    res.writeHead(404)
    res.end('{}')
  })

  await new Promise((r) => mockDshServer.listen(0, '127.0.0.1', r))
  const mockPort = mockDshServer.address().port
  const regRes = await api('POST', '/internal/adapters/dsh/register', {
    headers: { 'x-hub-internal-token': internalToken },
    body: { rpcBaseUrl: `http://127.0.0.1:${mockPort}`, version: '2.0.0-mock', pid: process.pid },
  })
  assert.equal(regRes.status, 200)
  const stAfterReg = await api('GET', '/v2/status')
  assert.equal(stAfterReg.data.agents.dsh.available, true)
  console.log('[PASS] 3. Mock DSH adapter registration & heartbeat')

  // Pair Owner #2 via real Python client
  const owner2Ticket = await api('POST', '/admin/pairing-tickets', {
    body: { label: 'Victor·二号', role: 'owner' },
  })
  assert.equal(owner2Ticket.status, 201)
  const pairOut = await runPy(['pair', '--code', owner2Ticket.data.ticket.code, '--client-name', 'muse-vm-2'])
  assert.equal(pairOut.http, 200)
  assert.equal(pairOut.role, 'owner')
  const owner2AccountId = pairOut.accountId
  const owner2Cred = JSON.parse(fs.readFileSync(path.join(museHome, 'credentials', 'test-pc.json'), 'utf8'))
  const owner2Token = owner2Cred.token

  // Single-use ticket verification
  const reuseTkt = await api('POST', '/v2/pair', { body: { code: owner2Ticket.data.ticket.code } })
  assert.equal(reuseTkt.status, 400)
  assert.equal(reuseTkt.data.error.code, 'pairing_code_invalid')
  console.log('[PASS] 4. Multi-owner pairing via Python muse_link_client.py + single-use ticket check')

  // Pair Collaborator account (sandboxed to collabSandbox, dsh only)
  const collabTicket = await api('POST', '/admin/pairing-tickets', {
    body: {
      label: '协作号',
      role: 'collaborator',
      allowedAgents: ['dsh'],
      workspaceRoots: [collabSandbox],
      forcedPreset: 'read-only',
    },
  })
  assert.equal(collabTicket.status, 201)
  const collabPair = await api('POST', '/v2/pair', { body: { code: collabTicket.data.ticket.code } })
  assert.equal(collabPair.status, 200)
  const collabToken = collabPair.data.token
  const collabId = collabPair.data.accountId

  // Idempotent windowKey reuse on Owner #1
  const open1 = await api('POST', '/v2/threads', {
    token: legacyToken,
    body: { agent: 'dsh', windowKey: 'topic:netops', title: '防火墙巡检' },
  })
  assert.equal(open1.status, 201)
  assert.equal(open1.data.reused, false)
  assert.equal(open1.data.thread.title, '[Muse·Victor·主号] 防火墙巡检')

  const open1Again = await api('POST', '/v2/threads', {
    token: legacyToken,
    body: { agent: 'dsh', windowKey: 'topic:netops' },
  })
  assert.equal(open1Again.status, 200)
  assert.equal(open1Again.data.reused, true)
  assert.equal(open1Again.data.thread.id, open1.data.thread.id)
  console.log('[PASS] 5. Idempotent windowKey reuse & labeled window title')

  // Owner #2 scope=mine vs scope=owner + takeover
  const o2Mine = await api('GET', '/v2/threads?scope=mine', { token: owner2Token })
  assert.equal(o2Mine.data.threads.some((t) => t.id === open1.data.thread.id), false)
  const o2All = await api('GET', '/v2/threads?scope=owner', { token: owner2Token })
  assert.equal(o2All.data.threads.some((t) => t.id === open1.data.thread.id), true)

  const takeover = await api('POST', `/v2/threads/${open1.data.thread.id}/takeover`, { token: owner2Token })
  assert.equal(takeover.status, 200)
  assert.equal(takeover.data.thread.ownerAccountId, owner2AccountId)
  console.log('[PASS] 6. Multi-owner isolation by default + explicit cross-owner takeover')

  // Collaborator strict isolation checks
  const colListOwner = await api('GET', '/v2/threads?scope=owner', { token: collabToken })
  assert.equal(colListOwner.data.threads.length, 0)
  const colPeek = await api('GET', `/v2/threads/${open1.data.thread.id}`, { token: collabToken })
  assert.equal(colPeek.status, 404)
  const colTakeover = await api('POST', `/v2/threads/${open1.data.thread.id}/takeover`, { token: collabToken })
  assert.equal(colTakeover.status, 403)
  const colAgy = await api('POST', '/v2/threads', { token: collabToken, body: { agent: 'antigravity' } })
  assert.equal(colAgy.status, 403)
  const colEscapeWs = await api('POST', '/v2/threads', { token: collabToken, body: { agent: 'dsh', workspace: tmpDir } })
  assert.equal(colEscapeWs.status, 400)
  assert.equal(colEscapeWs.data.error.code, 'workspace_not_allowed')

  const colValid = await api('POST', '/v2/threads', {
    token: collabToken,
    body: { agent: 'dsh', workspace: collabSandbox, preset: 'danger-full-access' },
  })
  assert.equal(colValid.status, 201)
  assert.equal(colValid.data.thread.preset, 'read-only', 'Collaborator preset must be forced!')

  const colEscapeFile = await api('POST', '/v2/files/fetch', {
    token: collabToken,
    body: { workspace: collabSandbox, path: '../secret-outside.txt', encoding: 'utf8' },
  })
  assert.equal(colEscapeFile.status, 400)
  const colOkFile = await api('POST', '/v2/files/fetch', {
    token: collabToken,
    body: { workspace: collabSandbox, path: 'allowed.txt', encoding: 'utf8' },
  })
  assert.equal(colOkFile.status, 200)
  assert.equal(colOkFile.data.text, 'SAFE_DATA')

  const colApprove = await api('POST', '/v2/approvals/fake-appr', {
    token: collabToken,
    body: { decision: 'approve_once' },
  })
  assert.equal(colApprove.status, 403)
  assert.equal(colApprove.data.error.code, 'approval_local_only')
  console.log('[PASS] 7. Collaborator hard isolation (404 threads, 403 agent/takeover/approval, workspace & path jail, forced preset)')

  // Python client `send --wait` + echo suppression + local.user_message
  const sendResult = await runPy(['send', open1.data.thread.id, 'hello-v2-world', '--wait', '8'])
  assert.equal(sendResult.status, 'ok')
  assert.equal(sendResult.resultText, 'ECHO_REPLY:hello-v2-world')
  assert.equal(sendResult.localUserMessages.length, 0, 'Inbound message echo must be suppressed!')

  // Now simulate local desktop user typing in the same DSH session + verify immediate long-poll wake
  const pollStart = Date.now()
  const pollPromise = api('GET', `/v2/events?cursor=${sendResult.cursor}&wait=6`, { token: owner2Token })
  await sleep(150)
  await api('POST', '/internal/events', {
    headers: { 'x-hub-internal-token': internalToken },
    body: {
      type: 'user.message',
      sessionId: open1.data.thread.localSessionId,
      threadId: open1.data.thread.id,
      payload: { text: '本地桌面补发的消息' },
    },
  })
  const pollRes = await pollPromise
  const pollElapsed = Date.now() - pollStart
  assert.equal(pollRes.status, 200)
  assert.ok(pollElapsed < 3000, `Expected immediate long-poll wake, got ${pollElapsed}ms`)
  assert.equal(pollRes.data.events.some((e) => e.type === 'local.user_message' && e.payload.text === '本地桌面补发的消息'), true)
  console.log(`[PASS] 8. Python client send --wait, echo suppression & local.user_message immediate wake (${pollElapsed}ms)`)

  // Account revocation
  const rev = await api('POST', `/admin/accounts/${collabId}/revoke`)
  assert.equal(rev.status, 200)
  const afterRev = await api('GET', '/v2/me', { token: collabToken })
  assert.equal(afterRev.status, 401)
  console.log('[PASS] 9. Single-account revocation takes effect immediately (401)')

  // Live production Hub smoke test (read-only)
  const liveLegacy = await fetch('http://127.0.0.1:47615/status').then((r) => r.json())
  assert.equal(liveLegacy.ok, true)
  assert.match(String(liveLegacy.version), /^2\./)
  const liveOverview = await fetch('http://127.0.0.1:47617/admin/overview').then((r) => r.json())
  assert.equal(liveOverview.ok, true)
  assert.equal(liveOverview.agents.antigravity.available, true)
  assert.ok(liveOverview.accounts.some((a) => a.id === 'acc_owner_victor' && a.status === 'active'))
  console.log('[PASS] 10. Live production Muse Hub (:47615 & :47617) healthy, AGY ready, legacy owner preserved')

  console.log('\nALL 10 E2E VERIFICATION SUITES PASSED!')
} finally {
  await cleanup()
}

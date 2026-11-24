// Collaborator-Only Funnel Gateway (:47619) & HTTPS Client End-to-End Verification Suite
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const HUB_ENTRY = path.join(ROOT, 'packages', 'daemon', 'muse-hub.mjs')
const PY_CLIENT = path.join(ROOT, 'tools', 'muse_link_client.py')

const TEST_ADMIN_PORT = 47817
const TEST_LEGACY_PORT = 47815
const TEST_TAILNET_PORT = 47816
const TEST_COLLAB_PORT = 47819
const ADMIN_BASE = `http://127.0.0.1:${TEST_ADMIN_PORT}`
const COLLAB_BASE = `http://127.0.0.1:${TEST_COLLAB_PORT}`

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-collab-gw-'))
const museHome = path.join(tmpDir, 'muse-home')
const collabSandbox = path.join(tmpDir, 'collab-sandbox')
fs.mkdirSync(collabSandbox, { recursive: true })
fs.writeFileSync(path.join(collabSandbox, 'ok.txt'), 'COLLAB_FUNNEL_OK', 'utf8')
fs.writeFileSync(path.join(tmpDir, 'outside.txt'), 'SECRET_OUTSIDE', 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(base, method, pathname, { body, token, headers = {} } = {}) {
  const res = await fetch(`${base}${pathname}`, {
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
  try {
    data = JSON.parse(text)
  } catch {}
  return { status: res.status, data }
}

function runPy(args, envExtra = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'python',
      [PY_CLIENT, ...args],
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

function findOpenssl() {
  const candidates = [
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'openssl',
  ]
  for (const c of candidates) {
    if (c === 'openssl' || fs.existsSync(c)) return c
  }
  return null
}

function generateTestCert(dir) {
  const opensslBin = findOpenssl()
  if (!opensslBin) return null
  const keyPath = path.join(dir, 'tls.key')
  const certPath = path.join(dir, 'tls.crt')
  const cnfPath = path.join(dir, 'tls.cnf')
  fs.writeFileSync(
    cnfPath,
    [
      '[req]',
      'default_bits = 2048',
      'prompt = no',
      'default_md = sha256',
      'distinguished_name = dn',
      'x509_extensions = v3_ext',
      '[dn]',
      'CN = collab-test.local',
      '[v3_ext]',
      'subjectAltName = DNS:collab-test.local,IP:127.0.0.1',
      'basicConstraints = critical,CA:TRUE',
      'keyUsage = digitalSignature,keyEncipherment,keyCertSign',
      'extendedKeyUsage = serverAuth',
    ].join('\n'),
    'utf8'
  )
  return new Promise((resolve) => {
    execFile(
      opensslBin,
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-config', cnfPath],
      { encoding: 'utf8' },
      (err) => {
        if (err) resolve(null)
        else resolve({ keyPath, certPath })
      }
    )
  })
}

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
let tlsProxyServer = null
let mockConnectProxy = null

try {
  // Wait for Hub + collaborator port
  let ready = false
  for (let i = 0; i < 30; i++) {
    try {
      const r = await api(COLLAB_BASE, 'GET', '/v2/status')
      if (r.status === 200 && r.data.ok) {
        ready = true
        break
      }
    } catch {}
    await sleep(150)
  }
  assert.equal(ready, true, 'Collaborator gateway :47819 did not become ready')

  // 1. Minimal /v2/status check (no hostname / AGY / accountCount leakage) & admin overview reporting
  const st = await api(COLLAB_BASE, 'GET', '/v2/status')
  assert.equal(st.status, 200)
  assert.equal(st.data.mode, 'collaborator-gateway')
  assert.equal(st.data.channel, 'tailscale-funnel')
  assert.equal(st.data.machine, undefined, 'Must not leak hostname on collaborator gateway')
  assert.equal(st.data.accountCount, undefined, 'Must not leak accountCount on collaborator gateway')
  assert.equal(st.data.agents.antigravity, undefined, 'Must not expose Antigravity info on collaborator gateway')
  assert.equal(typeof st.data.agents.dsh.available, 'boolean')

  const ov = await api(ADMIN_BASE, 'GET', '/admin/overview')
  assert.equal(ov.data.collabPort, TEST_COLLAB_PORT)
  assert.equal(ov.data.collabListening, true)
  console.log('[PASS] 1. Collaborator gateway :47819 returns minimal /v2/status with zero host/AGY leakage')

  // 2. Hidden routes return 404 on collaborator gateway
  for (const hiddenPath of ['/admin/overview', '/internal/events', '/api/muse-agent-link/status', '/v2/bundles/office-v2.zip', '/status']) {
    const r = await api(COLLAB_BASE, 'GET', hiddenPath)
    assert.equal(r.status, 404, `Expected 404 for ${hiddenPath} on collaborator gateway, got ${r.status}`)
  }
  console.log('[PASS] 2. Admin, internal, v1, and bundle routes all return 404 on collaborator gateway')

  // 3. Owner pairing ticket rejected on :47819 (403) WITHOUT consuming ticket; succeeds on :47817; Owner token rejected on :47819 (403)
  const ownerTkt = await api(ADMIN_BASE, 'POST', '/admin/pairing-tickets', {
    body: { label: 'Owner-Secret', role: 'owner' },
  })
  assert.equal(ownerTkt.status, 201)
  const ownerPairOnCollab = await api(COLLAB_BASE, 'POST', '/v2/pair', {
    body: { code: ownerTkt.data.ticket.code },
    headers: { 'x-forwarded-for': '203.0.113.5' },
  })
  assert.equal(ownerPairOnCollab.status, 403)
  assert.equal(ownerPairOnCollab.data.error.code, 'forbidden_role')

  const ownerPairOnAdmin = await api(ADMIN_BASE, 'POST', '/v2/pair', {
    body: { code: ownerTkt.data.ticket.code },
  })
  assert.equal(ownerPairOnAdmin.status, 200, 'Owner ticket must remain usable on private port after 403 on collab gateway')
  const ownerToken = ownerPairOnAdmin.data.token

  const ownerMeOnCollab = await api(COLLAB_BASE, 'GET', '/v2/me', {
    token: ownerToken,
    headers: { 'x-forwarded-for': '203.0.113.5' },
  })
  assert.equal(ownerMeOnCollab.status, 403)
  assert.equal(ownerMeOnCollab.data.error.code, 'forbidden_role')
  console.log('[PASS] 3. Owner pairing ticket & Owner Bearer token strictly blocked on :47819 (403 forbidden_role)')

  // Register mock DSH Adapter
  const internalToken = fs.readFileSync(path.join(tmpDir, 'hub-internal-token.txt'), 'utf8').trim()
  let sessN = 0
  mockDshServer = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    if (req.url === '/rpc/session/create') {
      sessN += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, sessionId: `dsh-collab-${sessN}`, title: body.title }))
      return
    }
    if (req.url === '/rpc/binding/sync') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.url === '/rpc/session/prompt') {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      setTimeout(async () => {
        await api(ADMIN_BASE, 'POST', '/internal/events', {
          headers: { 'x-hub-internal-token': internalToken },
          body: {
            type: 'turn.finished',
            sessionId: body.sessionId,
            threadId: body.threadId,
            payload: { turnId: body.turnId, status: 'ok', resultText: `FUNNEL_DSH_REPLY:${body.text}` },
          },
        })
      }, 120)
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise((r) => mockDshServer.listen(0, '127.0.0.1', r))
  const reg = await api(ADMIN_BASE, 'POST', '/internal/adapters/dsh/register', {
    headers: { 'x-hub-internal-token': internalToken },
    body: { rpcBaseUrl: `http://127.0.0.1:${mockDshServer.address().port}`, version: '2.1.0-mock', pid: process.pid },
  })
  assert.equal(reg.status, 200)

  // Owner creates a private DSH thread to test cross-account isolation
  const ownerThr = await api(ADMIN_BASE, 'POST', '/v2/threads', {
    token: ownerToken,
    body: { agent: 'dsh', title: 'Owner私密窗口' },
  })
  assert.equal(ownerThr.status, 201)

  // 4. Collaborator pairing ticket defaults to DSH-only, works on :47819, survives rotating public NAT IPs (XFF)
  const collabTkt = await api(ADMIN_BASE, 'POST', '/admin/pairing-tickets', {
    body: { label: '外部协作号', role: 'collaborator', workspaceRoots: [collabSandbox] },
  })
  assert.equal(collabTkt.status, 201)
  assert.deepEqual(collabTkt.data.ticket.allowedAgents, ['dsh'], 'Collaborator tickets must default to DSH-only!')

  const collabPair = await api(COLLAB_BASE, 'POST', '/v2/pair', {
    body: { code: collabTkt.data.ticket.code, clientName: 'collab-muse-vm' },
    headers: { 'x-forwarded-for': '203.0.113.10, 127.0.0.1' },
  })
  assert.equal(collabPair.status, 200)
  assert.equal(collabPair.data.role, 'collaborator')
  assert.equal(collabPair.data.machine, undefined, 'Must not leak Windows hostname in collab pair response')
  const collabToken = collabPair.data.token

  // Call /v2/me from a DIFFERENT rotating Meta cloud NAT IP -> must succeed (enforceIpPin === false)
  const collabMe = await api(COLLAB_BASE, 'GET', '/v2/me', {
    token: collabToken,
    headers: { 'x-forwarded-for': '198.51.100.77' },
  })
  assert.equal(collabMe.status, 200)
  assert.equal(collabMe.data.mode, 'collaborator-gateway')
  assert.equal(collabMe.data.machine, undefined)
  assert.equal(collabMe.data.account.enforceIpPin, false)
  assert.deepEqual(collabMe.data.account.pinnedTailnetIps, [])
  assert.deepEqual(collabMe.data.account.allowedAgents, ['dsh'])
  assert.equal(collabMe.data.account.approvalPolicy, 'local_only')
  console.log('[PASS] 4. Collaborator paired via :47819 with default DSH-only + rotating NAT IP support (enforceIpPin=false)')

  // 5. Collaborator isolation on :47819 (AGY blocked 403, sandbox enforced, approvals blocked, owner thread invisible)
  const colAgy = await api(COLLAB_BASE, 'POST', '/v2/threads', {
    token: collabToken,
    body: { agent: 'antigravity' },
  })
  assert.equal(colAgy.status, 403)
  assert.equal(colAgy.data.error.code, 'forbidden_role')

  const colEscape = await api(COLLAB_BASE, 'POST', '/v2/threads', {
    token: collabToken,
    body: { agent: 'dsh', workspace: tmpDir },
  })
  assert.equal(colEscape.status, 400)
  assert.equal(colEscape.data.error.code, 'workspace_not_allowed')

  const colOk = await api(COLLAB_BASE, 'POST', '/v2/threads', {
    token: collabToken,
    body: { agent: 'dsh', workspace: collabSandbox, preset: 'danger-full-access', title: '协作用例' },
  })
  assert.equal(colOk.status, 201)
  assert.equal(colOk.data.thread.preset, 'workspace-write')

  const colApprove = await api(COLLAB_BASE, 'POST', '/v2/approvals/any-id', {
    token: collabToken,
    body: { decision: 'approve_once' },
  })
  assert.equal(colApprove.status, 403)
  assert.equal(colApprove.data.error.code, 'approval_local_only')

  const colPeekOwner = await api(COLLAB_BASE, 'GET', `/v2/threads/${ownerThr.data.thread.id}`, { token: collabToken })
  assert.equal(colPeekOwner.status, 404)
  const colTakeOwner = await api(COLLAB_BASE, 'POST', `/v2/threads/${ownerThr.data.thread.id}/takeover`, { token: collabToken })
  assert.equal(colTakeOwner.status, 403)
  console.log('[PASS] 5. Collaborator :47819 DSH-only, sandbox jail, local-only approval & owner-thread isolation verified')

  // 6. X-Forwarded-For per-IP pairing rate limit (IP A locked out at 429 without blocking IP B)
  for (let i = 0; i < 5; i++) {
    const r = await api(COLLAB_BASE, 'POST', '/v2/pair', {
      body: { code: '000000' },
      headers: { 'x-forwarded-for': '192.0.2.50' },
    })
    assert.equal(r.status, 400)
  }
  const locked = await api(COLLAB_BASE, 'POST', '/v2/pair', {
    body: { code: '000000' },
    headers: { 'x-forwarded-for': '192.0.2.50' },
  })
  assert.equal(locked.status, 429)
  const otherIp = await api(COLLAB_BASE, 'POST', '/v2/pair', {
    body: { code: '000000' },
    headers: { 'x-forwarded-for': '192.0.2.99' },
  })
  assert.equal(otherIp.status, 400, 'Rate limiting IP A must not lock out IP B')
  console.log('[PASS] 6. X-Forwarded-For per-client brute-force rate limiting verified (429 isolated per IP)')

  // 7. Real HTTPS TLS reverse proxy + simulated Meta Muse standard :3128 HTTPS_PROXY CONNECT test!
  const certInfo = await generateTestCert(tmpDir)
  assert.ok(certInfo, 'Expected openssl to generate self-signed TLS cert for HTTPS client E2E test')

  // TLS reverse proxy mimicking Tailscale Funnel -> 127.0.0.1:TEST_COLLAB_PORT
  tlsProxyServer = https.createServer(
    {
      key: fs.readFileSync(certInfo.keyPath),
      cert: fs.readFileSync(certInfo.certPath),
    },
    (req, res) => {
      const fwd = http.request(
        {
          hostname: '127.0.0.1',
          port: TEST_COLLAB_PORT,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, 'x-forwarded-for': '198.51.100.200' },
        },
        (upRes) => {
          res.writeHead(upRes.statusCode || 502, upRes.headers)
          upRes.pipe(res)
        }
      )
      fwd.on('error', (err) => {
        res.writeHead(502)
        res.end(String(err))
      })
      req.pipe(fwd)
    }
  )
  await new Promise((r) => tlsProxyServer.listen(0, '127.0.0.1', r))
  const tlsPort = tlsProxyServer.address().port

  // Mock standard HTTPS_PROXY (:3128 equivalent) that accepts CONNECT collab-test.local:<tlsPort> -> 127.0.0.1:<tlsPort>
  let proxyConnectCalls = 0
  mockConnectProxy = http.createServer((_req, res) => {
    res.writeHead(405)
    res.end()
  })
  mockConnectProxy.on('connect', (req, clientSock, head) => {
    proxyConnectCalls += 1
    const [, portStr] = String(req.url || '').split(':')
    const up = net.connect(Number(portStr), '127.0.0.1', () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length) up.write(head)
      up.pipe(clientSock)
      clientSock.pipe(up)
    })
    up.on('error', () => {
      try { clientSock.end() } catch {}
    })
  })
  await new Promise((r) => mockConnectProxy.listen(0, '127.0.0.1', r))
  const proxyPort = mockConnectProxy.address().port

  // Pair a second collaborator via Python muse_link_client.py --url https://collab-test.local:<tlsPort> THROUGH HTTPS_PROXY!
  const collabTkt2 = await api(ADMIN_BASE, 'POST', '/admin/pairing-tickets', {
    body: { label: 'HTTPS测试协作号', role: 'collaborator', workspaceRoots: [collabSandbox] },
  })
  const pyEnv = {
    HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
    MUSE_LINK_CA_FILE: certInfo.certPath,
  }
  const pyStatus = await runPy(
    ['--machine', 'collab-https', '--url', `https://collab-test.local:${tlsPort}`, 'status'],
    pyEnv
  )
  assert.equal(pyStatus.http, 200)
  assert.equal(pyStatus.mode, 'collaborator-gateway')

  const pyPair = await runPy(
    ['--machine', 'collab-https', '--url', `https://collab-test.local:${tlsPort}`, 'pair', '--code', collabTkt2.data.ticket.code],
    pyEnv
  )
  assert.equal(pyPair.http, 200)
  assert.equal(pyPair.role, 'collaborator')

  // Verify credentials persisted scheme="https" so subsequent calls only need --machine collab-https!
  const savedCred = JSON.parse(fs.readFileSync(path.join(museHome, 'credentials', 'collab-https.json'), 'utf8'))
  assert.equal(savedCred.scheme, 'https')
  assert.equal(savedCred.host, 'collab-test.local')
  assert.equal(savedCred.port, tlsPort)

  const pyMe = await runPy(['--machine', 'collab-https', 'me'], pyEnv)
  assert.equal(pyMe.http, 200)
  assert.equal(pyMe.account.role, 'collaborator')

  const pyOpen = await runPy(
    ['--machine', 'collab-https', 'open', '--agent', 'dsh', '--window-key', 'https:demo', '--title', 'HTTPS联调'],
    pyEnv
  )
  assert.equal(pyOpen.http, 201)
  const pySend = await runPy(['--machine', 'collab-https', 'send', pyOpen.thread.id, 'ping-over-https', '--wait', '6'], pyEnv)
  assert.equal(pySend.status, 'ok')
  assert.equal(pySend.resultText, 'FUNNEL_DSH_REPLY:ping-over-https')
  assert.ok(proxyConnectCalls >= 5, `Expected HTTPS_PROXY CONNECT to be used on all HTTPS calls, got ${proxyConnectCalls}`)
  console.log(`[PASS] 7. Python muse_link_client.py HTTPS + TLS SNI + standard HTTPS_PROXY CONNECT E2E passed (${proxyConnectCalls} proxied TLS requests)`)

  console.log('\nALL 7 COLLABORATOR GATEWAY & HTTPS E2E SUITES PASSED!')
} finally {
  try { mockConnectProxy?.close() } catch {}
  try { tlsProxyServer?.close() } catch {}
  try { mockDshServer?.close() } catch {}
  try { hubProc.kill() } catch {}
  await sleep(300)
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
}

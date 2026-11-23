// End-to-End Verification for Antigravity Native Hooks (PreInvocation / PostToolUse / Stop)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const HUB_ENTRY = path.join(ROOT, 'packages', 'daemon', 'muse-hub.mjs')
const HOOK_ENTRY = path.join(ROOT, 'packages', 'agy-status-pill', 'hooks', 'muse-hook.cjs')

const TEST_ADMIN_PORT = 47817
const TEST_LEGACY_PORT = 47815
const TEST_TAILNET_PORT = 47816
const BASE = `http://127.0.0.1:${TEST_ADMIN_PORT}`

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-agy-hook-'))
const fakeTranscript = path.join(tmpDir, 'fake-transcript.jsonl')
const fakeConvId = '11111111-2222-3333-4444-555555555555'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function runHook(stdinObj) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_ENTRY], {
      env: {
        ...process.env,
        MUSE_LINK_STATE_DIR: tmpDir,
        MUSE_HUB_ADMIN_URL: BASE,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`hook exit ${code}: ${err}`))
      try {
        resolve(JSON.parse(out.trim()))
      } catch (e) {
        reject(new Error(`hook bad JSON: ${out} (${e.message})`))
      }
    })
    child.stdin.end(JSON.stringify(stdinObj))
  })
}

async function api(method, pathname, { body, token } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

const hubProc = spawn(process.execPath, [HUB_ENTRY], {
  env: {
    ...process.env,
    MUSE_LINK_STATE_DIR: tmpDir,
    MUSE_HUB_ADMIN_PORT: String(TEST_ADMIN_PORT),
    MUSE_HUB_LEGACY_PORT: String(TEST_LEGACY_PORT),
    MUSE_HUB_TAILNET_PORT: String(TEST_TAILNET_PORT),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

try {
  let ready = false
  for (let i = 0; i < 30; i++) {
    try {
      const r = await api('GET', '/v2/status')
      if (r.status === 200 && r.data.ok) { ready = true; break }
    } catch {}
    await sleep(150)
  }
  assert.equal(ready, true)

  // Pair one owner account
  const tkt = await api('POST', '/admin/pairing-tickets', { body: { label: 'Hook测试号', role: 'owner' } })
  const pair = await api('POST', '/v2/pair', { body: { code: tkt.data.ticket.code } })
  const token = pair.data.token
  const accountId = pair.data.accountId

  // 1. Unbound conversation fast-path (< 100ms, returns {})
  const t0 = Date.now()
  const unboundOut = await runHook({ conversationId: '00000000-0000-0000-0000-000000000000', hookEventName: 'PreInvocation' })
  assert.deepEqual(unboundOut, {})
  console.log(`[PASS] 1. Unbound AGY conversation fast-path returned {} in ${Date.now() - t0}ms`)

  // Attach fake AGY conversation so it's in bindings.json
  const attach = await api('POST', '/admin/attach', {
    body: { accountId, agent: 'antigravity', localSessionId: fakeConvId, title: 'Hook 实测窗', workspace: tmpDir },
  })
  assert.equal(attach.status, 201)
  const threadId = attach.data.thread.id

  // 2. PostToolUse hook -> real-time output.progress event
  const evBefore = await api('GET', '/v2/events?cursor=0&wait=0', { token })
  const cursor0 = evBefore.data.cursor
  const postOut = await runHook({
    conversationId: fakeConvId,
    hookEventName: 'PostToolUse',
    toolCall: { id: 't1', name: 'run_command', args: { CommandLine: 'echo hi' } },
    stepIdx: 3,
  })
  assert.deepEqual(postOut, {})
  const evAfterTool = await api('GET', `/v2/events?cursor=${cursor0}&wait=0`, { token })
  assert.equal(evAfterTool.data.events.some((e) => e.type === 'output.progress' && e.payload.via === 'hook'), true)
  console.log('[PASS] 2. PostToolUse hook pushed real-time output.progress to Muse account stream')

  // 3. Stop hook -> immediate <100ms turn.finished (no 3.5s settle wait!)
  fs.writeFileSync(
    fakeTranscript,
    [
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'run check' }),
      JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'INSTANT_STOP_HOOK_REPLY' }),
    ].join('\n') + '\n',
    'utf8'
  )
  const stopStart = Date.now()
  const stopOut = await runHook({
    conversationId: fakeConvId,
    hookEventName: 'Stop',
    terminationReason: 'NO_TOOL_CALL',
    fullyIdle: true,
    transcriptPath: fakeTranscript,
  })
  const stopMs = Date.now() - stopStart
  assert.deepEqual(stopOut, {})
  const evAfterStop = await api('GET', `/v2/events?cursor=${evAfterTool.data.cursor}&wait=0`, { token })
  const fin = evAfterStop.data.events.find((e) => e.type === 'turn.finished')
  assert.ok(fin, 'Expected immediate turn.finished from Stop hook')
  assert.equal(fin.payload.resultText, 'INSTANT_STOP_HOOK_REPLY')
  console.log(`[PASS] 3. Stop hook finalized turn.finished immediately (${stopMs}ms, zero 3.5s settle delay)`)

  // 4. Remote /stop + PreInvocation hook -> hard terminate injection!
  const stopReq = await api('POST', `/v2/threads/${threadId}/stop`, { token })
  assert.equal(stopReq.status, 200)
  const preCancel = await runHook({
    conversationId: fakeConvId,
    hookEventName: 'PreInvocation',
    invocationNum: 2,
  })
  assert.equal(preCancel.terminationBehavior, 'terminate')
  assert.ok(Array.isArray(preCancel.injectSteps) && preCancel.injectSteps[0]?.errorMessage?.userMessage)
  // Second PreInvocation after cancel consumed should return {}
  const preClean = await runHook({
    conversationId: fakeConvId,
    hookEventName: 'PreInvocation',
    invocationNum: 3,
  })
  assert.deepEqual(preClean, {})
  console.log('[PASS] 4. Remote /stop -> PreInvocation returned hard terminationBehavior="terminate" (and auto-cleared)')

  console.log('\nALL 4 ANTIGRAVITY NATIVE HOOK TESTS PASSED!')
} finally {
  try { hubProc.kill() } catch {}
  await sleep(300)
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
}

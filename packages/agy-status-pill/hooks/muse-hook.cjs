'use strict'
// Antigravity Native Lifecycle Hook for Muse Hub v2
// Handles PreInvocation (remote /stop, mid-turn steer, workspace guidance),
// PostToolUse (real-time tool progress), and Stop (instant <50ms turn.finished).
//
// ZERO overhead on normal non-Muse conversations: checks ~/.dsh/muse-agent-link/bindings.json
// locally first (~1ms) and immediately outputs {} with zero HTTP calls if unbound.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = process.env.MUSE_LINK_STATE_DIR || path.join(DSH_HOME, 'muse-agent-link')
const BINDINGS_PATH = path.join(STATE_DIR, 'bindings.json')
const INTERNAL_TOKEN_PATH = path.join(STATE_DIR, 'hub-internal-token.txt')
const HUB_URL = process.env.MUSE_HUB_ADMIN_URL || 'http://127.0.0.1:47617'

function isMuseBoundConversation(conversationId) {
  if (!conversationId) return false
  try {
    if (!fs.existsSync(BINDINGS_PATH)) return false
    const doc = JSON.parse(fs.readFileSync(BINDINGS_PATH, 'utf8').replace(/^\uFEFF/, ''))
    if (!doc || !Array.isArray(doc.bindings)) return false
    return doc.bindings.some(
      (b) => b && b.agent === 'antigravity' && b.state !== 'closed' && b.localSessionId === conversationId
    )
  } catch {
    return false
  }
}

function readInternalToken() {
  try {
    return fs.readFileSync(INTERNAL_TOKEN_PATH, 'utf8').trim()
  } catch {
    return ''
  }
}

async function postHub(pathname, body, timeoutMs = 1800) {
  const tok = readInternalToken()
  if (!tok) return null
  try {
    const res = await fetch(`${HUB_URL}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-internal-token': tok,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}

async function main() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  let payload = {}
  try {
    if (raw) payload = JSON.parse(raw)
  } catch {
    process.stdout.write('{}\n')
    return
  }

  const conversationId = String(payload.conversationId || '').trim()
  const eventName = String(payload.hookEventName || '').trim()

  // Fast-path exit for every normal non-Muse conversation
  if (!isMuseBoundConversation(conversationId)) {
    process.stdout.write('{}\n')
    return
  }

  if (eventName === 'PreInvocation') {
    const resp = await postHub(
      '/internal/agy/pre-invocation',
      {
        conversationId,
        invocationNum: payload.invocationNum,
        lastUserInput: payload.lastUserInput,
        cwd: payload.cwd,
      },
      1500
    )
    process.stdout.write(JSON.stringify(resp && typeof resp === 'object' ? resp : {}) + '\n')
    return
  }

  if (eventName === 'PostToolUse') {
    await postHub(
      '/internal/events',
      {
        type: 'agy.tool',
        sessionId: conversationId,
        payload: {
          toolName: payload.toolCall?.name || 'tool',
          error: payload.error || null,
          stepIdx: payload.stepIdx ?? null,
        },
      },
      900
    )
    process.stdout.write('{}\n')
    return
  }

  if (eventName === 'Stop') {
    await postHub(
      '/internal/events',
      {
        type: 'agy.stop',
        sessionId: conversationId,
        payload: {
          terminationReason: payload.terminationReason || 'NO_TOOL_CALL',
          error: payload.error || null,
          fullyIdle: Boolean(payload.fullyIdle),
          transcriptPath: payload.transcriptPath || null,
        },
      },
      2000
    )
    process.stdout.write('{}\n')
    return
  }

  process.stdout.write('{}\n')
}

main().catch(() => {
  process.stdout.write('{}\n')
})

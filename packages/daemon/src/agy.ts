/**
 * Antigravity adapter (skeleton, M0)
 *
 * Antigravity has no DSH-style plugin host, so the daemon manages the `agy`
 * CLI directly:
 *  - spawns headless runs (`agy -p`) inside the thread's workspace;
 *  - permissions come from a per-workspace allowlist written to
 *    ~/.gemini/antigravity-cli/settings.json — never a global
 *    skip-permissions flag; destructive actions still raise approvals;
 *  - session continuity uses agy conversation UUIDs; progress is read from
 *    the transcript files under ~/.gemini/antigravity-cli/brain/<id>/,
 *    never by parsing the protobuf conversation store;
 *  - if Antigravity later ships an ACP/JSON-RPC mode, this adapter is the
 *    single place that switches over.
 *
 * TODO(M2): implement spawn/stream/stop against the pilot machine's agy.
 */

export interface AgyRunOptions {
  workspace: string;
  prompt: string;
  conversationId?: string;
  model?: string;
  timeoutSec?: number;
}

export function placeholder(): string {
  return 'agy-adapter@skeleton';
}

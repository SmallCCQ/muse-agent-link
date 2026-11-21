/**
 * Muse Link — machine-side daemon (skeleton, M0)
 *
 * Responsibilities (DESIGN.md §3.2–3.3):
 *  - serve the /v1 channel endpoint, bound ONLY to this machine's tailnet
 *    address; every route requires the per-machine device token and a
 *    paired-controller source check (protocol/PROTOCOL.md §1);
 *  - own the on-disk state: thread<->session bindings, job ledger with
 *    leases, audit log (no tokens, no credentials, ever);
 *  - talk to the in-host DSH plugin over a loopback-only channel;
 *  - drive Antigravity through the agy adapter (see ./agy.ts).
 *
 * State directory: $MUSE_LINK_HOME or ~/.muse-agent-link/
 *
 * TODO(M1): HTTP server + pairing; TODO(M2): job runner.
 */

export const ENDPOINT_VERSION = '0.0.1';

export interface DaemonConfig {
  /** Tailnet IPv4 of this machine; the only bind address. Never 0.0.0.0. */
  bindAddress: string;
  port: number;
  stateDir: string;
}

export const defaultPort = 47615;

export function placeholder(): string {
  return `muse-link-daemon@${ENDPOINT_VERSION} skeleton`;
}

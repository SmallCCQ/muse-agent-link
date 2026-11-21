/**
 * Muse Link — DSH plugin (skeleton, M0)
 *
 * Runs inside the DeepSeek Harness host process as a Cordis plugin, following
 * the dsh-im architecture:
 *  - talks to the Session Controller / Workspace Controller through the host's
 *    internal Typert Gateway, carrying this plugin's `peer` identity
 *    (required by DSH 0.2.1-rc.2); opens no local HTTP port;
 *  - registers exactly one settings page: "Muse 直连" (pairing, status,
 *    thread bindings — redacted state only, never tokens);
 *  - owns the DSH side of the channel: thread<->session binding, message
 *    queue/steer handling, approval forwarding, deferred result delivery.
 *
 * The HTTP channel endpoint itself lives in @muse-agent-link/daemon, which
 * binds only the machine's tailnet address. This plugin exposes an in-host
 * service that the daemon calls over a loopback-only channel.
 *
 * TODO(M1): implement against the real DSH 0.2.1-rc.2 plugin APIs after the
 * pilot machine's DSH version is verified.
 */

export const PLUGIN_ID = 'muse-agent-link';
export const HOST_BASELINE = '0.2.1-rc.2';

export interface DshPluginConfig {
  /** Local management RPC authority. Fixed to loopback by design. */
  rpcAuthority: 'loopback';
  /** Absolute paths the controller may bind threads to. */
  workspaceAllowlist: string[];
  /** Max concurrent DSH turns driven through this channel. */
  concurrencyLimit: number;
}

export const defaultConfig: DshPluginConfig = {
  rpcAuthority: 'loopback',
  workspaceAllowlist: [],
  concurrencyLimit: 2,
};

// M1: export the Cordis plugin entry (apply(ctx, config)) here.
export function placeholder(): string {
  return `${PLUGIN_ID}@skeleton host>=${HOST_BASELINE}`;
}

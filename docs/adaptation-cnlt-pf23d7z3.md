# Adaptation record — cnlt-pf23d7z3 (M3)

Machine: CNLT-PF23D7Z3, Windows 11 Enterprise, user ADV\victor.cai (domain
account, local Administrators member), Node v26.13.1, DSH 0.2.2-rc.3
(profiles: `desktop` + `headless`), Antigravity desktop app present
(agentapi.bat + hub files under ~/.gemini/antigravity).

Deployed 2026-11-22: DSH plugin v0.5.0 + desktop daemon v0.2.1, paired,
E2E verified the same day (DSH thread → `CNLT_OK`; desktop Antigravity
thread → desktop conversation 5153c1ac-2c20-4360-894b-5b3b63f9c03c →
`CNLT_AGY_OK`).

## Why this machine was deployed by script, not SSH

- Cai installed OpenSSH Server himself; the service is standard
  (C:\WINDOWS\System32\OpenSSH\sshd.exe, stock sshd_config with the
  administrators Match block) and Victor's public key was correctly
  placed in C:\ProgramData\ssh\administrators_authorized_keys.
- Every logon still failed. The OpenSSH/Operational log says it plainly:
  `Invalid user victor.cai@ADV` / `Invalid user
  victor.cai@adv.advantest.com`. sshd cannot resolve the domain account
  because the machine cannot locate a domain controller:
  `nltest /dsgetdc:ADV` and `/dsgetdc:adv.advantest.com` both return
  ERROR_NO_SUCH_DOMAIN (1355), and the `_ldap._tcp.dc._msdcs` SRV query
  returns nothing — even with the AnyConnect VPN shown as connected
  (the interactive desktop session runs on cached credentials).
- Consequence: no domain-account network logon (SSH/WinRM) can succeed
  until DC discovery works. Deployment therefore ran as user-run
  scripts in Cai's own interactive session; the channel itself is pure
  HTTP over Tailscale and needs no SSH. If DC discovery is fixed later,
  key-based SSH should start working with no further changes.

## Desktop-profile plugin install (the hard part)

- The `desktop` profile is managed exclusively by the Electron app:
  `dsh plugin --profile desktop install` refuses to run.
- Editing the profile `package.json` alone is NOT enough: the app never
  installs manually added dependencies. Per Cai's own
  `dsh-profile-migration` skill (section 6), plugin code for the desktop
  profile lives in the profile's `node_modules`. For a `link:`
  dependency, pnpm would place a directory junction at
  `profiles\desktop\node_modules\@local\muse-agent-link` →
  `~/.dsh/plugins/muse-agent-link`. Creating that junction by hand
  (tools/cnlt-bundle/install-cnlt-part4.ps1) made the plugin load.
- Profile wiring uses his existing conventions: dependency
  `"@local/muse-agent-link": "link:../../plugins/muse-agent-link"`
  (relative link, like his other @local plugins) plus the name in
  `dsh.profile.bundles`.
- BOM lesson (also in his migration skill section 6.8, re-learned the
  hard way): PowerShell 5.1 `ConvertTo-Json | Set-Content -Encoding
  UTF8` writes a BOM and the desktop host's JSON.parse dies with
  `Unexpected token ... is not valid JSON`, taking the whole app down.
  Profile edits must be surgical text edits written as UTF-8 without
  BOM (install-cnlt-part3.ps1), with a timestamped backup first
  (the restore from `package.json.bak-muse-20261122-114650` was used
  and worked).

## Daemon autostart

- `schtasks /Create` for the logon task was denied (access denied —
  consistent with the task service being unable to validate the domain
  principal while the DC is unreachable). The daemon is therefore
  started by an HKCU Run key (`MuseAgentLinkDaemon` →
  `~/.dsh/muse-agent-link/run-daemon.cmd`) and was started once
  manually; it listens on 127.0.0.1:47615 as designed.

## Dynamic host port — solved by the plugin's fixed-port mirror (v0.6.0)

- Unlike the web profile's fixed 3080, the desktop host binds dynamic
  ports. At pairing time it listened on the tailnet address at
  **63289** (plus loopback 63290/63291 for internal services).
- Plugin v0.6.0 removes the problem: following the lan-access bundle's
  pattern, the plugin runs an extra http server on the machine's
  Tailscale address at the FIXED port **47616** that forwards into the
  host's own web server (`ctx.webServer.server`). Only the
  `/api/muse-agent-link` prefix is forwarded (everything else 404s),
  and the plugin's token auth still gates every route. The host's
  dynamic port is read from `ctx.webServer.port` at load, so restarts
  no longer matter. `tools/link_client.py` defaults cnlt-pf23d7z3 to
  47616 (`MUSE_LINK_MACHINE` / `MUSE_LINK_PORT` / `MUSE_LINK_HOST` /
  `MUSE_LINK_TOKEN_FILE` still override).
- Verified 2026-11-22 after a full app restart onto an unknown new
  dynamic port: status via 47616 reported v0.6.0 / paired, and a fresh
  DSH thread round-trip returned the expected marker.
- The v0.6.0 update itself was delivered THROUGH the channel: a
  dispatched DSH thread on this machine downloaded index.js (40587
  bytes) and package.json (771 bytes) from this repo's raw URLs,
  verified sizes and version strings, backed up the old files as
  `*.bak-muse-20261122-060`, and replaced them. One caveat: the
  detached restart script killed the app as designed, but its
  Start-Process relaunch did not take (Cai started the app manually).
  File replacement via dispatched sessions works; unattended app
  relaunch does not — plan a human click for future host restarts
  that must be forced.

## Installers

tools/cnlt-bundle/ holds the staged installer scripts used here
(install-cnlt.ps1 parts 1–4). They are ASCII-only on purpose: Windows
PowerShell 5.1 misreads UTF-8-no-BOM scripts containing non-ASCII text
and produces bogus parser errors. The bundle zip is assembled from
packages/dsh-plugin + packages/daemon at build time; the copies in the
bundle folder are build artifacts, not sources.

# Changelog

All notable changes to `muse-agent-link` are documented in this file.

## [2.0.0] - 2026-11-23 — Muse Hub v2 (Multi-Account Bidirectional Session Window)

### Architecture & Decoupling
- **Standalone `Muse Hub` daemon (`packages/daemon/muse-hub.mjs`)**: Promoted Tailscale `:47616` ownership out of the DSH plugin into an independent local daemon (interactive desktop Session 1 via `HKCU\...\Run` + `run-hub-hidden.vbs`), eliminating single-point coupling between DSH and Antigravity Desktop. Restarting or closing DSH no longer interrupts Antigravity sessions, and vice versa.
- **Single-instance PID lock & graceful admin shutdown**: Added `hub.pid` + `:47617` liveness guard (duplicate launches exit cleanly with code `0`) and loopback-only `POST /admin/shutdown`.
- **Silent autostart (`run-hub-hidden.vbs`)**: Launches `muse-hub.mjs` invisibly without flashing a console window on Windows logon.

### Multi-Account Identity, RBAC & v1 Zero-Downtime Migration
- **Multi-account registry (`packages/daemon/store.mjs`)**: Replaced single-token `state.json` with atomic `accounts.json`, concurrent single-use 6-digit `pairing-tickets.json`, and `bindings.json`.
- **Automatic v1 -> v2 migration**: Automatically imports legacy `state.json` (`tokenHash`) as primary `owner` account (`acc_owner_victor`) and migrates existing `threads.json` / `desktop-conversations.json` into `bindings.json`; keeps all `/api/muse-agent-link/*` v1 routes working alongside `/v2/*`.
- **Two-tier role isolation**:
  - `owner` (multiple personal Muse accounts): default per-account isolation (`?scope=mine`), optional cross-owner view (`?scope=owner`) and window takeover (`POST /v2/threads/:id/takeover`), remote+local competitive approvals, and local session attach (`POST /admin/attach`).
  - `collaborator` (reserved for single delegated account): strict `404` tenant isolation, `realpathSync` workspace jail (no `*`), forced DSH `preset`, `approvalPolicy: "local_only"` (`403` on remote approve), and IP pinning.
- **Honest per-account presence**: Tracks real Muse account contact (`lastPollAt` + throttled persistent `lastSeenAt` across both `/v2/*` and `/api/muse-agent-link/*`) with 4 states: `active` (long-polling <= 35s), `online` (contact <= 15m), `offline` (timed out > 15m), and `never`.

### Bidirectional Sync, Multiplexed Events & Artifacts
- **Account-level multiplexed long-poll (`GET /v2/events?cursor=<n>&wait=18`)**: Single monotonic per-account event log (`events/<accountId>.jsonl`) spanning all DSH and Antigravity threads, capped at `wait <= 20s` to stay strictly under Meta Hatch's ~25s `:3130` proxy cutoff.
- **Echo suppression & local desktop sync**: Suppresses Muse-originated `USER_INPUT` echoes via short-lived SHA-256 fingerprints while forwarding genuine local desktop messages as `local.user_message`.
- **Idempotent window opening (`windowKey`)**: Reuses active local sessions for the same `(accountId, agent, windowKey)` and tags titles with `[Muse·<label>]`.
- **Unified file/media token relay (`GET /v2/files/ft_...`)**: Both Antigravity (`step.media[].uri`) and DSH (`collectTurnArtifacts` workspace diff + text path extraction) issue 15-minute account-scoped file tokens with collaborator workspace jail enforcement.

### Antigravity Desktop Native Hooks & v2.0 Pill (`packages/agy-status-pill/`)
- **Native lifecycle hooks (`hooks.json` + `hooks/muse-hook.cjs`)**:
  - Zero-overhead fast-path (`< 3ms`, zero HTTP) returning `{}` for non-Muse conversations.
  - `Stop`: Instant `< 200ms` `turn.finished` settlement (eliminating 3.5s quiet-settle delay, deduplicated against `transcript.jsonl` watcher).
  - `PostToolUse`: Real-time `output.progress` streaming.
  - `PreInvocation`: True remote `/stop` (`terminationBehavior: "terminate"`), mid-turn `steer` injection (`injectSteps: [{ userMessage }]`), and first-turn soft workspace guidance.
  - Deliberately skips `PreToolUse` until empty-JSON pass-through semantics are verified, ensuring zero impact on normal chats.
- **Multi-account sidebar card (`pill.js` v2.0.0)**: Mirrors theme glass style, displays live per-account presence badges (`活跃 / 在线 / 离线 / 未连`), generates `+ 主号码` / `+ 协作码`, revokes accounts, and attaches local AGY conversations.

### DSH Thin Adapter Plugin (`packages/dsh-plugin/` v2.0.0)
- **Decoupled loopback adapter**: Removed Tailscale `:47616` mirror from DSH; registers ephemeral loopback RPC with Hub `:47617` every 10s, auto-spawns `run-hub-hidden.vbs` if Hub is offline, forwards `session/event`, enforces `approvalPolicy` (`remote_or_local` vs `local_only`), and collects turn artifacts.
- **Multi-account sidebar card (`client.js`)**: Symmetric UI with Antigravity pill for pairing tickets, account presence, revocation, and attaching the active DSH session.

### Idle Wake Engine & Muse-Side v2 Client Kit
- **Idle wake engine (`packages/daemon/wake.mjs`)**: Supports local WeChat push (`push_weixin.mjs`), built-in zero-dependency TLS/STARTTLS SMTP (`muse_mail`), and webhook modes with idle threshold & cooldown (`muse-admin.mjs wake / wake-test / smtp-set`).
- **Muse-side zero-dependency client (`tools/muse_link_client.py` + `tools/MUSE_LINK_SKILL.md`)**: Pure Python3 stdlib over `:3130` `HTTP CONNECT` tunnel, automatic `<= 18s` long-poll slicing (`send --wait`), persisted account cursor, and self-bootstrapping download via `GET /v2/client.py` & `GET /v2/skill.md`.
- **Workstation rollout & automated tests**: Added dual-mode `tools/install-office-v2.ps1`, SSH deployer `tools/deploy_v2_office.py`, and 19 automated E2E tests (`tests/e2e-test.mjs`, `tests/agy-hook-test.mjs`, `tests/features-test.mjs`).

---

## [0.6.0] - 2026-11-22
- Added fixed-port Tailnet mirror (`:47616`) inside DSH plugin to decouple from DSH Desktop dynamic ports.
- Added Antigravity Desktop status pill (`agy-status-pill` v1.0.0 – v1.2.0) and CORS headers on `daemon.mjs` v0.2.2.
- Deployed M3 to `cnlt-pf23d7z3` (desktop profile) alongside `office-workstation` (web profile).

## [0.5.0] - 2026-11-22
- Switched Antigravity backend (`daemon.mjs` v0.2.1) from `agy` CLI/ACP to Antigravity Desktop (`agentapi new-conversation` + `SendUserCascadeMessage` + `transcript.jsonl`).

## [0.1.0 – 0.4.0] - 2026-11-22
- M0 protocol spec (`protocol/PROTOCOL.md`), M1 DSH headless tasks (`office-workstation`), M1.5 DSH Typert interactive sessions + competitive approvals, and M2 Antigravity ACP prototype.

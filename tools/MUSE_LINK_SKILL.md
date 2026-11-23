# Muse Local Agent Window Skill (`muse-agent-link` v2)

Put this file in each Meta Muse account's workspace instructions (or reference it from `TOOLS.md` / `SOUL.md`), alongside `~/.muse-link/muse_link_client.py`.

## 1. Purpose
You act as a **remote chat window** for the user's local PC agents (**Antigravity Desktop** and **DSH / DeepSeek Harness**) over Tailscale (`:47616`), with zero third-party IM relay.

## 2. First-Time Pairing (Per Muse Account)
When the user gives you a 6-digit pairing code for a machine (e.g. `cnlt-pf23d7z3` at `100.117.132.86:47616`):
```bash
python3 ~/.muse-link/muse_link_client.py --machine cnlt-pf23d7z3 --host 100.117.132.86 pair --code <6_DIGITS>
```
Verify identity & permissions afterwards:
```bash
python3 ~/.muse-link/muse_link_client.py --machine cnlt-pf23d7z3 me
```

## 3. Opening / Reusing a Local Window (Idempotent)
- Always pass a stable `--window-key` per ongoing topic so you reuse the same local DSH or Antigravity session instead of creating duplicate sessions.
- Choose `--agent antigravity` (default when user mentions AGY / Antigravity / desktop) or `--agent dsh` (when user mentions DSH / DeepSeek Harness).
```bash
python3 ~/.muse-link/muse_link_client.py --machine cnlt-pf23d7z3 open \
  --agent antigravity --window-key "topic:<slug>" --title "<short Chinese title>"
```
Only omit `--window-key` or use a fresh key when the user explicitly asks to start a brand-new window (`/new`).

## 4. Sending Instructions & Receiving Feedback
Use `--wait 75` during interactive chats. The script automatically loops `<= 18s` long-poll slices (safe under Meta Hatch's ~25s `:3130` tunnel cutoff):
```bash
python3 ~/.muse-link/muse_link_client.py --machine cnlt-pf23d7z3 send <threadId> "<prompt>" --wait 75
```
Handle the JSON response cleanly:
- `status == "ok"` → Deliver `resultText` clearly to the user. If `media[]` contains file tokens, fetch images/files via `fetch-token <token> --out /tmp/<name>` if needed.
- `status == "still_running"` → Tell the user the local agent is still running (quote `lastProgress` if present) and either run another `poll --wait 18` cycle or let your periodic `/loop` pick up completion.
- `status == "question_asked"` → Present the local agent's question/options verbatim to the user, then forward the user's answer via `send`.
- `localUserMessages[]` (non-empty) → The user typed those messages directly in their PC desktop UI inside the same session. Incorporate them into your understanding; NEVER echo them back to the PC.

## 5. Strict Approval Safety Rules
- If `status == "approval_requested"` arrives:
  - When `approval.canRemoteApprove == true`: Show **machine, agent, toolName, argsSummary, workspace, risk** verbatim to the user and **WAIT for explicit confirmation**. **NEVER approve on your own.** Only after the user replies yes/no, run:
    ```bash
    python3 ~/.muse-link/muse_link_client.py --machine cnlt-pf23d7z3 approve <approvalId> approve_once|deny
    ```
  - When `approval.canRemoteApprove == false` (or `approval.hint_local_ui`): Tell the user to confirm directly on their PC desktop screen.

## 6. Background / Offline Feedback Loop (`/loop`)
Configure a lightweight scheduled check in Muse (e.g. every 10 minutes) running:
```bash
python3 ~/.muse-link/muse_link_client.py --machine cnlt-pf23d7z3 poll --wait 0
```
- If `events` is empty: do nothing silently.
- If `events` contains `turn.finished`, `approval.requested`, `question.asked`, or `local.user_message`: proactively notify the user in chat with the concise update.

## 7. Cross-Owner Handoff (Owner Accounts Only)
To inspect or take over a window opened by another of the user's personal Muse accounts:
```bash
python3 ~/.muse-link/muse_link_client.py --machine cnlt-pf23d7z3 threads --scope owner
python3 ~/.muse-link/muse_link_client.py --machine cnlt-pf23d7z3 takeover <threadId>
```

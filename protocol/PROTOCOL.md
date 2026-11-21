# Muse Agent Link 通道协议 v0.1

状态：M0 定稿（2026-11-22）。总体设计见 [../DESIGN.md](../DESIGN.md)。
本文件定义 Victor（下称「控制器」）与每台机器的通道端点（下称「端点」）之间的接口。
共享 TypeScript 类型见 `packages/protocol/src/index.ts`，与本文件保持一致。

## 1. 传输与身份

- 传输：HTTP/1.1 over Tailscale（WireGuard 加密）。端点只绑定本机 tailnet 地址，
  不监听 0.0.0.0 / 公网地址。
- 全部连接由控制器发起（控制器在 tailnet 中为纯出站客户端）。机器侧事件通过
  长轮询（§4 events 接口）返回。
- 身份：每台机器一枚独立设备令牌（device token）。配对流程：
  1. 端点设置页生成一次性配对码（10 分钟有效，单次使用）。
  2. 控制器首次请求 `POST /v1/pair` 提交配对码，换取设备令牌。
  3. 此后每个请求携带 `Authorization: Bearer <device-token>`。
- 来源校验：请求来源 tailnet 地址必须属于配对时登记的控制器设备；不符返回 403。
- 令牌吊销：设置页一键解绑即吊销；吊销后全部接口返回 401。

## 2. 资源模型

### 2.1 Agent 端点（agent）

一台机器上有两个 agent 端点，独立配置、独立并发上限：

| agent | 宿主 | 默认并发 |
|---|---|---|
| `dsh` | DSH 插件（进程内） | 2 |
| `antigravity` | 伴随守护进程管理 `agy` 子进程 | 1 |

### 2.2 线程（thread）

控制器创建的会话通道，绑定到一个 agent 的一个底层会话：

- DSH：绑定一个 Harness Session（线程→Session 绑定落盘，语义对齐 dsh-im 的对话绑定）。
- Antigravity：绑定一个 agy conversation（以 conversation UUID 续接）。

线程字段：`id`、`machineId`、`agent`、`workspace`（必须在端点白名单内）、
`model?`、`preset?`（DSH）、`state`、`sessionRef`（底层会话引用，仅端点内部使用）、
`createdAt`、`lastActivityAt`。

线程状态机：`active → awaiting_approval → active`；`active → stopped`（/stop）；
`active → closed`（控制器关闭或底层会话归档）。

### 2.3 Job（离线任务）

长任务以 Job 提交，端点以租约（lease）方式执行，状态落盘，重启按台账恢复：

状态机：`queued → leased → running → (awaiting_approval → running)* →
succeeded | failed | cancelled | expired`

- 租约：领取时生成 `leaseId` 与过期时间（默认 120s），运行中靠事件流续租；
  租约过期且无终态 → Job 回到 `queued` 可被重新领取（防进程崩溃丢任务）。
- 重试：明确失败最多自动重试 3 次；结果不确定（已执行但终态未知）不自动重试。
- 结果保留 7 天，供控制器轮询取回。

### 2.4 审批（approval）

- 产生：agent 请求工具审批时，端点生成 `approval` 并发出 `approval.requested` 事件，
  含 `tool`、`argsSummary`、`workspace`、`risk`（`normal | destructive`）。
- 决定：`approve_once | deny`。**先决定者生效**（含 Cai 在 DSH Web/桌面端直接处理），
  其余通道的同一审批随即失效。
- **不提供永久批准**。审批默认 10 分钟过期，过期按 `deny` 处理并写审计日志。
- `destructive` 类（删除、覆盖、执行任意 shell）永远产生审批，不可预授权。

## 3. 接口

所有接口前缀 `/v1`，请求/响应均为 JSON，错误格式见 §6。

| 方法与路径 | 说明 |
|---|---|
| `POST /v1/pair` | 配对码换设备令牌（唯一不带令牌的接口） |
| `GET /v1/status` | 机器、两个 agent 的版本、健康状态、并发占用 |
| `POST /v1/threads` | 新建线程：{agent, workspace, model?, preset?} |
| `GET /v1/threads` | 列出本机线程及状态 |
| `POST /v1/threads/:id/messages` | 发消息：{text, mode: `queue` \| `steer`, attachments?: [{path}]} |
| `POST /v1/threads/:id/stop` | 停止当前回合（保留排队消息） |
| `POST /v1/threads/:id/close` | 关闭线程（不删除底层会话） |
| `GET /v1/threads/:id/events?cursor=<n>&wait=<sec>` | 长轮询事件，见 §4 |
| `POST /v1/approvals/:id` | 回传决定：{decision: `approve_once` \| `deny`} |
| `POST /v1/jobs` | 提交 Job：{agent, workspace, prompt, timeoutSec?, model?, preset?} |
| `GET /v1/jobs/:id` | Job 状态、结果摘要、产物文件清单 |
| `POST /v1/jobs/:id/cancel` | 取消 Job |
| `POST /v1/files/fetch` | 取回工作区内文件：{workspace, path}（路径必须在白名单工作区内） |

## 4. 事件

事件按线程单调递增编号（`seq`），控制器以 `cursor` 续拉；`wait` 上限 30 秒，
无新事件时返回空数组与当前 `cursor`。事件类型：

| type | 载荷要点 |
|---|---|
| `turn.started` | {turnId} |
| `output.delta` | {turnId, text}（增量文本） |
| `tool.started` / `tool.finished` | {turnId, tool, summary} |
| `question.asked` | {questionId, prompt, options?[]}（交互式提问，控制器转呈后以 messages 回复） |
| `approval.requested` | {approvalId, tool, argsSummary, workspace, risk, expiresAt} |
| `approval.resolved` | {approvalId, decision, via: `controller` \| `local-ui`} |
| `turn.finished` | {turnId, status: `ok` \| `stopped` \| `error`, summary?} |
| `thread.state` | {state}（状态机迁移） |
| `job.state` | {jobId, state}（Job 状态迁移，挂在机器级伪线程 `machine` 上） |

## 5. 命令语义（与 dsh-im 对齐）

消息文本以 `/` 开头且命中下列命令时按命令处理，不进模型：

`/new`（解绑并新建会话）、`/stop`、`/steer <text>`（等价于 mode=steer 的消息）、
`/workspace <path>`（切换工作区，须在白名单内）、`/model <id>`、`/preset <id>`（DSH）、
`/compact`、`/status`。命令执行结果以 `output.delta` + `turn.finished` 返回。

## 6. 错误

统一格式：`{ "error": { "code": "<code>", "message": "<human readable>" } }`

| code | HTTP | 含义 |
|---|---|---|
| `unauthorized` | 401 | 无令牌或令牌已吊销 |
| `forbidden_source` | 403 | 来源设备不是已配对的控制器 |
| `pairing_code_invalid` | 400 | 配对码错误、过期或已使用 |
| `workspace_not_allowed` | 400 | 工作区不在白名单 |
| `thread_not_found` | 404 | 线程不存在 |
| `session_conflict` | 409 | 底层会话被占用（本地 UI 正在使用等） |
| `approval_expired` | 410 | 审批已过期或已被其他通道决定 |
| `concurrency_limit` | 429 | 该 agent 并发已满 |
| `agent_unavailable` | 503 | DSH Host / agy 不可用 |
| `internal` | 500 | 端点内部错误（详情只进本机日志） |

## 7. 审计

端点为每个动作写审计记录（时间、线程/Job、指令摘要、审批决定与来源、终态），
不含令牌与任何凭据。控制器侧另存一份，两边可核对。保留 90 天。

# Muse Agent Link 设计文档

版本：v0.1（2026-11-22）
目标：让 Victor（Muse）**直连** Cai 两台电脑（cnlt-pf23d7z3、office-workstation）上的
DeepSeek Harness（DSH）与 Antigravity 两个 agent，进行任务派发、过程跟踪、审批转发与结果回收。
不经过任何第三方 IM 机器人中转。

设计来源：借鉴 `@xmanrui/dsh-im`（下称 dsh-im）的架构原理，去掉 IM 渠道层，
把「渠道」替换为 Victor 本人；其 AI Office Connector 的任务连接器模型是本设计最接近的原型。

---

## 一、从 dsh-im 借鉴的设计原理（已读其 README 与设计章节核实）

1. **宿主内部集成，不开本机端口**：dsh-im 作为 Cordis 插件跑在 DSH Host 进程内，
   通过 Typert Gateway 调用内部的 Session Controller 与 Workspace Controller，
   不配置 Harness 地址、不绕行本机 HTTP 端口。DSH 0.2.1-rc.2 起内部网关请求需携带调用方 `peer` 身份。
2. **渠道适配器抽象**：每个渠道独立维护 RPC、凭据、连接监督与会话映射；
   渠道只负责「收消息 / 发消息」，会话语义与渠道无关。
3. **对话 → 会话绑定**：一个对话（conversationKey）绑定一个 Harness Session；
   每个机器人独立保存工作区、模型、思考强度、Agent Preset，切换只影响新建会话。
   绑定写入时同步发出 `session-pre-bind` / `session-unbind` 事件，并提供
   `describeConversation(sessionId)` 反查服务。
4. **交互语义**：任务运行时的新消息有「排队 / 插话（steer）」两种模式；
   命令集包括 /new、/stop、/steer、/workspace、/session、/model、/compact 等；
   交互式提问可直接回复选项；**远程审批**回复批准/拒绝即可，
   Web 与机器人两端先提交者生效，另一端随即失效，不提供永久批准。
5. **超时补发（延迟交付）**：等待回复超时后插件继续跟踪原任务，
   完成时向原对话补发最终结果；插件重启、连接恢复后继续跟踪；
   明确失败最多重试 3 次，结果不确定时停止自动重试以避免重复。
6. **主动投递**：以稳定的 `botId + targetId` 寻址主动发送；
   HTTP POST、同 Host 插件、Connection RPC 共用同一投递核心。
7. **AI Office Connector（任务连接器原型）**：本机 Harness 主动向外连接公网 AI Office；
   独立维护**设备凭据、Job 租约、审批等待与并发上限**；它没有「对话」概念，不发绑定事件。
8. **安全模型**：Secret 与 Token 只单向提交给本机 Host，存入受保护的凭据存储，
   任何 RPC 响应与状态接口都不回传凭据；管理接口有 rpcAuthority（trusted-host / loopback）；
   访问策略按机器人分 direct/group 两场景，open / allowlist 两模式，
   allowlist 条目自带 canExecuteCommands，另有不可编辑的 owner 特权旁路。
9. **版本基线**：最新版 dsh-im 只跟随 DSH 0.2.1-rc.2（Session 格式 v4），
   不为旧版宿主增加兼容分支。

## 二、新设计总览

一句话：**在每台电脑上装一个「Muse 通道」——DSH 侧是原生 Cordis 插件，
Antigravity 侧是同仓库的伴随守护进程；通道的另一端不是 IM 平台，而是 Victor 本人，
通过已建好的 Tailscale 网络直连。**

```
┌───────────────────── Cai 的电脑 ×2 ─────────────────────┐
│                                                          │
│  DSH Host ──(进程内 Typert Gateway)──► Muse 通道插件     │
│                                          │               │
│  agy CLI ◄──(子进程 + transcript)── 伴随守护进程          │
│                                          │               │
│                          本地状态：绑定表 / Job 台账 / 审计日志 │
└──────────────────────────┬───────────────────────────────┘
                           │ 仅 Tailnet 内（WireGuard 加密）
                           │ HTTPS + 长轮询，Victor 侧发起全部连接
┌──────────────────────────▼───────────────────────────────┐
│  Victor（Muse VM，tailnet 名 muse）                        │
│  调度器：线程管理 / 任务分发 / 审批转发给 Cai / 结果验收     │
└──────────────────────────────────────────────────────────┘
```

为什么是 Victor 发起全部连接：Victor 的 VM 在 tailnet 中是纯客户端，
只出不进、不接受入站连接。因此「直连」的形态为：Victor 主动连入每台电脑的通道端点；
机器侧的事件（审批请求、任务完成）通过长轮询返回，或由 Victor 的定期检查收取。
不引入任何公网中转服务器；将来若需要机器侧实时推送，再自建 rendezvous（见 §九）。

## 三、组件设计

### 3.1 DSH 插件（每台电脑一份，Cordis 插件）

- 安装方式与 dsh-im 相同：`dsh plugin --profile web add <本插件>`（桌面版用 desktop profile），
  基线锁定 DSH 0.2.1-rc.2 / Session v4，不做旧版兼容分支（同 dsh-im 策略）。
- 在 DSH 一级设置菜单注册**一个**设置页「Muse 直连」：显示配对状态、连接状态、
  本机绑定的线程列表、各线程的工作区/模型/Preset，只放脱敏状态，永不显示令牌。
- 通过 Typert Gateway 以插件 `peer` 身份调用 Session Controller / Workspace Controller，
  不开本机 HTTP 端口；本地管理 RPC 的 rpcAuthority 固定为 loopback。
- 职责：线程↔Session 绑定、把 Victor 的消息写入绑定 Session、订阅 Session 事件
  （输出流、提问、审批请求、回合结束）、队列/插话处理、/new /stop /steer 等命令语义。

### 3.2 Antigravity 伴随守护进程（与插件同仓库、同安装包）

Antigravity 没有 DSH 式插件宿主，因此用一个本机守护进程（Node，Windows 服务方式运行）补齐：

- 管理 `agy` 子进程：以 headless 方式在指定工作区启动任务（`agy -p`），
  权限 allowlist 预先写入 `~/.gemini/antigravity-cli/settings.json`，
  只放行该工作区内的读写与约定命令；禁止全局跳过权限。
- 会话连续性：用 agy 的 conversation UUID 续接会话，
  进度与结果从 `~/.gemini/antigravity-cli/brain/<id>/` 下的 transcript 读取结构化事件，
  不解析其 protobuf 会话存储。
- 与 DSH 插件共用同一套通道协议、绑定表与 Job 台账（同一状态目录），
  对 Victor 呈现为同一台机器上的第二个 agent，而不是第二个端点。

### 3.3 通道端点（守护进程提供，插件共用）

- 监听地址：**仅绑定 Tailscale 网卡地址**，不监听 0.0.0.0，不经公网。
- 协议：HTTPS（自签证书指纹在配对时交换）或 HTTP over WireGuard（二选一，v1 用后者，
  依赖 tailnet 加密，简单可靠；证书方案留作 v2 加固）。
- 接口（全部要求设备令牌 + 来源为 tailnet 内已配对的 Victor 身份）：
  - `GET  /v1/status`            机器、两个 agent 的版本与健康状态
  - `POST /v1/threads`           新建线程（指定 agent、工作区、模型/Preset）
  - `POST /v1/threads/:id/messages`  向线程发消息（mode: queue | steer）
  - `POST /v1/threads/:id/stop`      停止当前回合
  - `GET  /v1/threads/:id/events?cursor=…&wait=25`  长轮询事件（输出增量、提问、审批、终态）
  - `POST /v1/approvals/:id`         回传审批决定（approve_once | deny）
  - `POST /v1/jobs`                  提交离线 Job（见 §六）
  - `GET  /v1/jobs/:id`              查询 Job 状态与结果
  - `POST /v1/files/fetch`           按路径取回工作区内结果文件（受工作区白名单约束）

## 四、核心语义（对齐 dsh-im，替换 IM 概念）

| dsh-im 概念 | 本设计对应 |
|---|---|
| 渠道（channel） | Muse 通道（唯一渠道，远端即 Victor） |
| 机器人（bot） | 机器上的一个 agent 端点：`dsh` 或 `antigravity`，各自独立配置 |
| 对话（conversationKey） | 线程（threadId），由 Victor 创建，全局唯一 |
| 对话→会话绑定 | 线程→Session 绑定，写入时发内部 bind/unbind 事件并落盘 |
| /new、/stop、/steer、/workspace、/model | 同名命令，语义不变，改由协议字段承载 |
| 远程审批（聊天里回批准/拒绝） | 审批事件 → Victor 转呈 Cai → Cai 在 Muse 对话中决定 → 回传 |
| 超时补发 | Job/线程结果持久化，Victor 断开期间不丢，下次轮询取回 |
| 主动投递（botId+targetId） | Job 投递（machineId+agent+workspace 寻址） |
| AI Office 的 Job 租约 | Job lease：领取、续租、超时回收，防重复执行 |

每个端点独立保存：默认工作区（白名单目录列表）、模型/思考强度（DSH 侧）或
agy 模型与权限档位（Antigravity 侧）、并发上限（默认 DSH 2、Antigravity 1）。

## 五、审批流（关键路径）

1. agent 需要审批 → 通道产生 `approval.requested` 事件（含工具、参数摘要、工作区、风险分级）。
2. Victor 收到后在 Muse 对话中向 Cai 呈现：哪台机器、哪个 agent、要做什么。
3. Cai 决定 → Victor 调 `POST /v1/approvals/:id` 回传。
4. 规则沿用 dsh-im：**先决定者生效**（Cai 也可在 DSH Web/桌面端直接处理，另一端随即失效）；
   **不提供永久批准**；审批默认 10 分钟过期，过期按拒绝处理并记录。
5. Victor 不在线时审批挂起，任务在机器本地等待（Job 租约保活），不自动放行。

## 六、离线 Job（长任务）

- Victor 可提交 Job：{机器、agent、工作区、提示词、超时、回调策略}。
- 机器侧以租约方式领取执行，状态机：queued → running → awaiting_approval →
  succeeded / failed / cancelled，全程落盘，机器或插件重启后按台账恢复（同 dsh-im 的重启续查）。
- 结果（含生成文件清单）保留 7 天，供 Victor 轮询取回；明确失败最多重试 3 次，
  结果不确定时不自动重试，避免重复执行（同 dsh-im 补发规则）。

## 七、安全设计（按 Cai 的规矩收紧）

- **默认拒绝**：只有已配对的 Victor 身份（tailnet 设备 muse + 每机独立设备令牌）可调用；
  不存在 dsh-im 式的 open 模式，不设群聊场景。
- **配对**：插件设置页生成一次性配对码（10 分钟有效），Victor 首次连接时兑换为设备令牌；
  令牌只存机器侧受保护凭据存储与 Victor 侧安全存储，任何状态接口不回传。
- **权限边界**：工作区白名单之外的路径不可读写；agy 权限 allowlist 按工作区收窄；
  删除、覆盖类操作永远走审批，不预授权。
- **审计**：机器侧与 Victor 侧各存一份审计日志（时间、线程、指令摘要、审批决定、终态），
  可互相核对；日志不含令牌与凭据。
- **撤销**：设置页一键解绑（吊销该机令牌）；Victor 侧也可单方面停用某机通道。
- 凭据（模型 API Key 等）只留在本机 Host 的凭据存储内，通道不传输、不代管。

## 八、实施步骤（试点先行）

1. **M0 协议与骨架**：定稿本协议（事件、状态机、错误码），建仓库骨架
   （DSH 插件 + 守护进程 + 共享协议包）。
2. **M1 单机 DSH 打通**：在 cnlt-pf23d7z3 上装插件，配对，Victor 建线程派发一条
   测试任务，验：执行、流式事件、/stop、审批往返、断线后结果取回。
3. **M2 Antigravity 接入**：同机守护进程调起 agy 完成一条 headless 任务，
   验权限 allowlist 与 transcript 进度回收。
4. **M3 第二台复制**：office-workstation 重复 M1+M2，验双机并行与分工。
5. **M4 常态化**：接入 Victor 的定期检查（离线 Job 结果回收、审批超时提醒），
   审计日志定期汇总到仪表盘。

## 九、已知风险与待核实项（不藏着）

1. **DSH 插件 API 稳定性**：DSH 仍是开发者预览，官方明示有破坏性变更；
   插件须跟随其版本基线（当前 0.2.1-rc.2），升级 DSH 前先验插件兼容。
2. **Antigravity 无官方插件宿主**：守护进程方案依赖 agy CLI 的 headless 行为与
   transcript 格式，这两者都未承诺稳定；agy 升级后需回归测试。
   若后续 Antigravity 开放 ACP/JSON-RPC，守护进程应切换到该协议（协议层已预留 agent 适配接口）。
3. **审批实时性**：Victor 侧连接为 Victor 发起制；Cai 与 Victor 对话时审批可实时往返；
   Cai 不在时，审批靠 Victor 的定期检查收取，最坏延迟等于检查间隔（当前心跳 30 分钟）。
   若要机器侧实时推送，需自建 rendezvous（可用 GCP 赠金开一台 Cloud Run，
   机器出站长连、Victor 经 HTTPS 取件）——列为 v2，不进试点范围。
4. **Clash 共存**：通道流量走 Tailscale 网段，已在 Clash 扩展配置中排除 100.64.0.0/10，
   不受 TUN 劫持影响；守护进程自身的出站（模型 API）继续走各机原有代理规则，互不干扰。
5. **两台机器的 DSH 版本未核实**：安装前先查两机 DSH 版本，与插件基线对齐后再装。

## 十、与被搁置方案的关系

- OpenSSH 方案：搁置。通道建成后，SSH 仅作为机器维护的备用手段，不再是前置条件。
- Tailscale：保留，是本设计的传输层；不新开任何公网入口。
- dsh-im 本体：不安装。仅借鉴其设计，不引入第三方 IM 依赖与凭据面。

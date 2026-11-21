# 适配记录：office-workstation（2026-11-22 实测）

机器：DESKTOP-PRNM1F1，Windows 10 Pro（10.0.19045），用户 smallsun。
接入方式：OpenSSH Server + 密钥登录，经 Tailscale（100.91.205.57）。

## 实测结论

| 项 | 结果 |
|---|---|
| Node / npm | v24.22.1 / 11.19.1 ✓ |
| DSH | **0.2.2-rc.1**（npm 全局），profiles：web、headless |
| DSH headless | `dsh headless "<task>"` 实测跑通（exit 0，正确返回）✓ |
| web profile 已装插件 | 含 `@xmanrui/dsh-im@5.10.0`、`dsh-agy-link@0.6.18` 等 20 个 |
| agy | **1.5.4**（`%LOCALAPPDATA%\agy\bin\agy.exe`）；Antigravity 桌面端已装 |
| agy 能力 | 有 `acp` 子命令（ACP stdio 服务）、`--input-format/--output-format stream-json`、`--conversation` 续接、`plugin` 子命令、`--mode`、`--sandbox`、`--settings` |
| agy 授权 | 非交互会话（SSH / WMI，session 0）读不到桌面钥匙串 → 打印 OAuth 链接并超时 ✗ |
| 通道约束 | Victor 侧 SSH-over-Tailscale 代理连接约 25 秒断开 → 长任务必须在机器侧脱离会话运行 + 轮询取结果 |

## 对设计的影响（DESIGN.md 修订点）

1. **插件基线改 DSH 0.2.2-rc.1**（原写 0.2.1-rc.2）。dsh-im 5.10.0 已在该版本
   web profile 中安装，说明其宿主内部 API（Typert Gateway / Session 绑定）在
   0.2.2-rc.1 上可用，本插件沿用同一路径。
2. **Antigravity 适配改走 ACP**：agy 1.5.4 自带 `agy acp`（stdio JSON-RPC），
   优先于原方案的 transcript 文件解析；stream-json 的 print 模式作为降级通道。
   `packages/daemon/src/agy.ts` 的实现路线据此调整。
3. **守护进程必须跑在交互桌面会话内**（登录任务 / 由 DSH 宿主拉起），
   不能做成 Windows 服务：服务会话读不到 agy 的登录凭据。
   DSH 侧同理——插件宿主（桌面/Web）本就在交互会话内，无此问题。
4. Victor 侧一切长操作走「机器侧脱离执行 + 短连接轮询」，与协议的
   Job 租约模型天然一致。

## 插件安装记录（2026-11-22 00:52–01:05）

`@local/muse-agent-link` v0.1.0 已安装进 web profile（Cai 反馈 DSH 里看不到插件后补装）：

- 插件目录：`~/.dsh/plugins/muse-agent-link`（package.json / index.js / client.js /
  cordis.patch.yml / icon.svg，形态对齐本机 `@local/dsh-flow-credits`）。
- 接线：web profile 的 package.json 已加 link 依赖与 bundles 条目
  （原文件备份为 `package.json.bak-muse-20261122`），`pnpm install` 成功，
  `dsh plugin --profile web list` 显示 21 个包（含本插件，原有 20 个无缺失），
  `dsh --profile web --dump-config` 确认插件已组合进配置树。
- 功能 v0.1.0：侧边栏底部「Muse 直连」状态卡（client.js）+
  `GET /api/muse-agent-link/status` 状态接口（index.js，inject webServer）。
- 加载验证（2026-11-22 01:03，Cai 授权后由 Victor 执行重启）：旧宿主
  （2026-11-21 18:34 启动，:3080）进程树已结束，经 schtasks /IT 在交互会话
  （session 1）按原命令重拉 `dsh web`；新宿主 pid 31056 监听 3080，
  启动日志出现 `[muse-agent-link] v0.1.0 loaded on DESKTOP-PRNM1F1 (paired=false)`，
  插件状态文件 `~/.dsh/muse-agent-link/state.json` 已生成。插件加载确认完成。
  注：PowerShell 的 ScheduledTask cmdlet 从 SSH 会话注册的交互任务不执行，
  必须用 schtasks.exe /IT——后续机器侧操作按此办理。

## M1 通道打通（2026-11-22 01:20，插件 v0.2.1）

- 传输：Victor 经 Tailscale 直连宿主 3080 端口的插件路由，未新开监听端口。
- 配对：插件生成一次性配对码（30 分钟有效；状态接口只对本机回环请求披露，
  供侧边栏卡片显示给机主）；`POST /pair` 校验后发每机独立设备令牌，
  插件只存 SHA-256 哈希，令牌本体只在 Victor 侧（仓库外文件，600 权限）。
  本机已配对成功（paired=true），卡片显示「已配对」。
- 任务：`POST /tasks` 以 Job 台账落盘（`~/.dsh/muse-agent-link/jobs/`），
  执行体为插件拉起的 `dsh headless` 一次性运行（默认工作区
  `~/.dsh/muse-agent-link/workspace`，并发上限 2，超时可调）；
  `GET /task?id=` 轮询取结果，`POST /task-cancel?id=` 取消，`POST /unpair` 解绑。
- 实测：任务 1「Reply with exactly: LINK_OK」9 秒成功返回原文；
  任务 2 在默认工作区建文件 link-test.txt，内容经 SSH 独立核对为 `M1_OK`。
- 踩坑：宿主 webServer 的 `kind: 'prefix'` 路由对 API 子路径不匹配（宿主回 404），
  v0.2.1 改为全部 exact 路由 + 查询参数传 job id。
- Victor 侧客户端：`tools/link_client.py`（status/pair/task/job/jobs/unpair）。
- 未做（下一层）：交互式会话绑定（线程↔UI Session、steer、审批转发）需要接入
  宿主内部 Gateway，属 M1.5；Antigravity 属 M2。当前 headless 任务内的工具
  权限遵循 headless profile 自身的 permission preset。

## M1.5 交互会话打通（2026-11-22 01:54，插件 v0.3.2）

- 结论：经 Muse 派发的任务现在跑在宿主的**真实 Session** 里，与 DSH 界面里
  手工开的会话完全一致（同一目录、同一历史、可在 UI 里继续聊）。
- 路径（照 dsh-im 的做法）：插件静态注入 `connection` + `typertGateway`，
  `connection.createPeer({principal:{kind:'owner'}, interactions:'none'})` 建 peer，
  全部操作走 `typertGateway.invoke({namespace:'session', method, args:{request}, peer})`：
  create {cwd, agentPreset?} → {sessionId}；prompt {requestId, sessionId, mode, content:[{type:'text',text}]}；
  wait {sessionId, timeoutMs, afterSeq, maxMessages} → {reason: idle|input-required|timeout, output.records}；
  rename {sessionId, title}；cancel {sessionId}。
- 结果文本以 `session/event` 流的 `assistant/message` 事件为准
  （data.message.content 里 {type:'text'} 拼接）；wait 的 records 形状不同，未作主源。
- 创建后即 rename 为「Muse 直连 · MM-DD HH:mm」，方便机主在 UI 里辨认。
- 审批：插件以 prepend 全局挂 `approval/request` 中间件，只处理自有线程的会话，
  与本地 UI 竞速、先到先决（与 dsh-im 同规则），其余会话直接 next() 放行；
  10 分钟未决自动拒绝。本轮未实测审批竞速（待真实工具审批场景验证）。
- 踩坑三则：① Cordis 未注入的 ctx.<service> 属性访问会直接抛错，插件整体加载失败，
  只能用静态 inject 或 ctx.inject；② `ctx.sessions` 客户端门面在本机 create 时
  报 header id 不匹配（品牌化 id 对象），宿主侧正道是 Gateway，不要用该门面建会话；
  ③ webServer 'prefix' 路由不匹配 API 子路径（见 M1 记录）。
- 实测：线程 095775ce… → session-809841ec-47c2-4d5b-bb9f-fcd6c84c04bd，
  第一轮回复 SESSION_OK；宿主重启后同一线程第二轮能答出上一轮的口令，
  证明会话连续性与持久化都成立。

## M2 探活：Antigravity ACP 可用（2026-11-22 01:56）

- 探针 `packages/daemon/acp-probe.mjs` 在交互桌面会话内拉起 `agy acp`（stdio JSON-RPC）：
  initialize 成功（protocolVersion 1，支持 loadSession/list/resume/close）；
  session/new 得 conversation 3d445867-ae33-4c68-8b43-b78cb661b619；
  session/prompt 流式返回 session/update（标题自动生成、tool_call、agent_message_chunk），
  最终 stopReason=end_turn，回复 AGY_OK。
- **账号风险解除**：此前 cli.log 里 2026-11-12 的 ToS 封禁 403 已不复现，
  Antigravity 在桌面会话内可正常使用（模型列表含 Gemini 4 Neon / Carbon）。
- （此条已被 2026-11-22 02:34 Cai 的纠正推翻：ACP 会话只存在于
  `~/.gemini/antigravity-cli` 存储，桌面版 Antigravity 应用不可见。见下方 M2.5。）
- 待建：常驻 daemon（交互会话内、回环接口）+ 插件侧 antigravity 线程代理（M2 主体）。

## M2 完成（2026-11-22 02:08，插件 v0.4.0 + daemon v0.1.0）

- daemon：`packages/daemon/daemon.mjs` 部署在 `~/.dsh/muse-agent-link/daemon.mjs`，
  登录计划任务 `MuseAgentLinkDaemon`（/IT 交互会话）自启，常驻托管一个 `agy acp` 进程；
  回环 API 127.0.0.1:47615，自有令牌（daemon-token.txt，与插件同机读取）。
  会话索引落盘 agy-conversations.json；daemon/agy 重启后用 session/load 恢复。
- 插件 v0.4.0：线程加 `agent` 字段；`agent:'antigravity'` 的线程创建/发消息/停止
  全部代理到 daemon，线程状态机与 DSH 线程一致。
- 审批闭环实测：agy 每轮会调用其 custom-models MCP 并触发 ACP
  `session/request_permission`；daemon 挂起 → 插件镜像为线程 pendingApproval →
  Victor 经 /approvals 批准（allow_once → optionId 'allow'）→ 回合继续完成。
- 实测：线程 b88e7064… → conversation bad21b18-7179-48c7-8863-eccffbc31391，
  两轮对话连续，第二轮正确答出第一轮口令 AGY_THREAD_OK。
- 已知小缺：插件线程视图里 agy 会话标题未同步（Antigravity 应用内标题正常）。

## 待确认风险

- `~/.gemini/antigravity-cli/cli.log` 显示 **2026-11-12** 有多次
  `PERMISSION_DENIED 403: This service has been disabled in this account for
  violation of Terms of Service`。这是 10 天前的记录；在交互会话内成功跑一次
  agy 之前，无法确认该账号现在能否正常使用 Antigravity 服务端。
  若封禁仍在，工程做得再对也用不了 Ultra 额度，需要先走申诉。

## M2.5 桌面版改造（2026-11-22，插件 v0.5.0 + daemon v0.2.1）

Cai 纠正：Antigravity 侧必须对接**桌面版应用**，不是 agy CLI。核查证实两套
存储完全独立（`~/.gemini/antigravity` vs `~/.gemini/antigravity-cli`），
M2 的 ACP 会话桌面端不可见，daemon 后端整体重写：

- **新建会话**：桌面应用自带 agent 接口
  `~/.gemini/antigravity/bin/agentapi.bat`（包 language_server.exe），
  `agentapi new-conversation --title=<t> <prompt>` 立即返回真实桌面
  conversation id，回合在桌面应用内异步执行。必需环境变量：
  `ANTIGRAVITY_LS_ADDRESS=http://127.0.0.1:<hub httpPort>`、
  `ANTIGRAVITY_CSRF_TOKEN=<hub csrfToken>`，取自
  `~/.gemini/antigravity/daemon/hub_<httpPort>.json`（取 mtime 最新一份）。
- **追问回合**：`agentapi send-message` 只会往会话里注入一条高优先级
  SYSTEM_MESSAGE，空闲 cascade 不会为此启动新回合（实测第一追问因 cascade
  尚热而秒回、其后不再响应）。正确做法是语言服务器的 Connect JSON RPC：
  `POST http://127.0.0.1:<httpPort>/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage`，
  头 `x-codeium-csrf-token: <csrfToken>`，体
  `{"cascadeId": "<id>", "items": [{"text": "..."}]}`，产生真实 USER_INPUT 回合。
- **回合结果**：轮询桌面会话自有 transcript
  `~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl`；
  完成判据 = 基线步之后出现带内容的 PLANNER_RESPONSE(DONE) 且文件静默 ≥4s；
  轮询的步集是「基线之后全部步」，不能只认 USER_INPUT（追问以 SYSTEM_MESSAGE 入账）。
- **审批**：桌面端无远程审批接口，`commandExecutionPolicy: "eager"` 下命令自动
  执行；daemon 只在 transcript 停滞 >120s 时标 awaitingApproval 提示，
  真正的审批由 Cai 在桌面应用内处理。agentapi 无取消命令，取消只停本地等待。
- daemon 记录 id 用自有 UUID（provisional），首回合创建桌面会话后把
  desktopConversationId 落盘到 desktop-conversations.json，插件线程同步展示。
- 实测：线程 bdd2ea9e… → 桌面会话 80b148d7-e2cd-46fa-a066-036facbc09f7，
  标题「Muse 直连 · 11-22 02:59」；两轮经完整通道验证 FINAL_OK / FINAL_OK2
  （第二轮走 RPC 追问）。另手工验证 RPC 直发得 RPC_OK。

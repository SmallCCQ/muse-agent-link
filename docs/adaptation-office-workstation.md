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
- 未完成验证：本机已有一个 2026-11-21 18:34 启动的 DSH web 宿主在跑（:3080，
  带访问鉴权），它早于本次安装，不含本插件；另起的测试实例因端口冲突退出。
  **需重启 DSH 宿主后插件才真正加载**，状态文件 `~/.dsh/muse-agent-link/state.json`
  会在首次加载时生成。重启会中断正在进行的会话，故留给 Cai 决定时机。

## 待确认风险

- `~/.gemini/antigravity-cli/cli.log` 显示 **2026-11-12** 有多次
  `PERMISSION_DENIED 403: This service has been disabled in this account for
  violation of Terms of Service`。这是 10 天前的记录；在交互会话内成功跑一次
  agy 之前，无法确认该账号现在能否正常使用 Antigravity 服务端。
  若封禁仍在，工程做得再对也用不了 Ultra 额度，需要先走申诉。

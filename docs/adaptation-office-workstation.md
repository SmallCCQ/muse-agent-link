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

## 待确认风险

- `~/.gemini/antigravity-cli/cli.log` 显示 **2026-11-12** 有多次
  `PERMISSION_DENIED 403: This service has been disabled in this account for
  violation of Terms of Service`。这是 10 天前的记录；在交互会话内成功跑一次
  agy 之前，无法确认该账号现在能否正常使用 Antigravity 服务端。
  若封禁仍在，工程做得再对也用不了 Ultra 额度，需要先走申诉。

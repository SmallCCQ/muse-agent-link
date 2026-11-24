# muse-agent-link (v2 — Muse Hub)

把多个 **Meta Muse 账号** 经 Tailscale 直连接入本机 **DeepSeek Harness (DSH)** 与 **Antigravity Desktop**，作为双向实时会话窗口源（零第三方 IM 中转）。

## v2 核心架构

- **独立网关 (`packages/daemon/muse-hub.mjs`)**：独占 Tailscale `:47616` 私有入口 + 回环 `:47617` 管理/内部接口 + 回环 `:47619` **协作专用网关**（配合 Tailscale Funnel 对外暴露公网 HTTPS，零 Owner/Admin/AGY 攻击面）+ `:47615` 旧胶囊兼容接口；DSH 与 Antigravity 彻底故障隔离。
- **多账号分权与零停机迁移 (`store.mjs`)**：支持多 `owner` 个人主号（私有 Tailnet 接入，默认隔离 + 可选跨主号接管）与受限 `collaborator` 协作号（公网 HTTPS Funnel 接入无需加入 Tailscale，默认仅放行 DSH、`404` 会话隔离、`realpathSync` 目录沙箱、强制仅本机审批）；自动迁移 v1 `state.json` 并兼容 `/api/muse-agent-link/*`。
- **账号级 18s 多路复用长轮询 (`/v2/events`)**：规避 Meta Hatch `:3130` 约 25s 代理断连，单游标汇总全部 DSH + AGY 窗口输出、审批、本地桌面插话（回声过滤）与 15 分钟短期产物文件令牌（`/v2/files/ft_...`）。
- **双宿主对称插件**：
  - `packages/dsh-plugin/`（v2.0.0）：薄回环 Cordis 适配器、竞争式审批（受 `approvalPolicy` 约束）、离线自愈拉起 Hub、产物自动收集与侧栏多账号管理卡片。
  - `packages/agy-status-pill/`（v2.0.0）：原生 `PreInvocation` / `PostToolUse` / `Stop` 生命周期 Hook（毫秒级回合结算、真远程 `/stop`、盘中 `steer` 插话、软工作区引导）与左下角多账号管理胶囊。
- **空闲秒级唤醒 (`wake.mjs`)**：支持本机微信推送（`push_weixin.mjs`）、内置零依赖 TLS/STARTTLS SMTP（`muse_mail`）与 Webhook。

## 文档

- [CHANGELOG.md](CHANGELOG.md) — 版本变更日志（含 `v2.0.0` 完整变更记录）
- [protocol/PROTOCOL_V2.md](protocol/PROTOCOL_V2.md) — **v2 完整协议与多账号架构规范**
- [DESIGN.md](DESIGN.md) / [protocol/PROTOCOL.md](protocol/PROTOCOL.md) — v0.1 初版设计与历史基线
- [docs/adaptation-cnlt-pf23d7z3.md](docs/adaptation-cnlt-pf23d7z3.md) / [docs/adaptation-office-workstation.md](docs/adaptation-office-workstation.md) — 双机适配与运维记录

## 仓库结构

```text
packages/
  daemon/           独立 Muse Hub v2 (muse-hub.mjs, store.mjs, antigravity-adapter.mjs, wake.mjs, muse-admin.mjs, run-hub-hidden.vbs)
  dsh-plugin/       DSH v2.0.0 薄回环 Cordis 插件与侧栏多账号管理卡片
  agy-status-pill/  Antigravity 原生生命周期 Hook (hooks.json + muse-hook.cjs) 与 v2.0.0 多账号胶囊
  protocol/         共享 TypeScript 协议类型
protocol/           PROTOCOL.md (v0.1) & PROTOCOL_V2.md (v2.0)
tools/              Muse 云端零依赖客户端 (muse_link_client.py + MUSE_LINK_SKILL.md) 与部署脚本 (install-office-v2.ps1, deploy_v2_office.py)
tests/              26 项端到端自动化验收测试 (e2e-test.mjs, agy-hook-test.mjs, features-test.mjs, collab-gateway-test.mjs)
```

## 快速部署与测试

```powershell
# 运行全部 26 项端到端测试（隔离临时端口与状态目录，不污染线上数据）
node tests/e2e-test.mjs
node tests/agy-hook-test.mjs
node tests/features-test.mjs
node tests/collab-gateway-test.mjs

# 本机签发新 Muse 账号 6 位配对码（主号走私有 Tailnet :47616；协作号走 Tailscale Funnel HTTPS -> :47619，默认仅 DSH）
node "$HOME\.dsh\muse-agent-link\muse-admin.mjs" ticket --label "Victor·二号" --role owner
node "$HOME\.dsh\muse-agent-link\muse-admin.mjs" ticket --label "协作号" --role collaborator --workspace "D:\collab-sandbox"

# 将本机 :47619 协作专用网关暴露为公网 HTTPS（需先在 Tailscale Admin 启用 Funnel）
tailscale funnel --bg 47619

# 在 office-workstation 上一键升级（或从 1 号 Muse VM 运行 python3 tools/deploy_v2_office.py）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-office-v2.ps1 -RestartDshWeb
```

## License

MIT

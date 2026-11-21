# muse-agent-link

让 Muse（Victor）**直连**本机 agent 的通道插件：机器一侧是 DeepSeek Harness（DSH）的
原生插件 + Antigravity 的伴随守护进程，另一端只有 Victor 本人。
不经过任何第三方 IM 机器人中转，传输只走 Tailscale 私有网络。

设计借鉴 [@xmanrui/dsh-im](https://github.com/xmanrui/dsh-im) 的架构原理
（宿主内部集成、对话→会话绑定、排队/插话、远程审批、超时补发、AI Office 的 Job 租约模型），
把其中的「IM 渠道」替换为 Muse 直连通道。

## 文档

- [DESIGN.md](DESIGN.md) — 总体设计：组件、审批流、安全模型、实施步骤、风险清单
- [protocol/PROTOCOL.md](protocol/PROTOCOL.md) — 通道协议规格 v0.1：端点、事件、状态机、错误码

## 仓库结构

```
packages/
  protocol/    共享协议类型（Thread / Job / Event / Approval）
  dsh-plugin/  DSH 侧 Cordis 插件（设置页、线程↔Session 绑定、审批转发）
  daemon/      机器侧守护进程：通道端点（仅绑 tailnet）+ Antigravity(agy) 适配
protocol/      协议规格文档
```

## 状态

M0：协议与骨架（当前）。后续里程碑见 DESIGN.md §八：
M1 单机 DSH 打通 → M2 Antigravity 接入 → M3 第二台复制 → M4 常态化。

## 安全要点

- 默认拒绝：只有已配对的 Victor 身份（tailnet 设备 + 每机独立设备令牌）可以调用。
- 端点只绑定 Tailscale 网卡地址，不监听公网，不开入站端口到互联网。
- 凭据只留在本机 Host 的受保护存储中，通道不传输、不代管，任何状态接口不回传令牌。
- 删除/覆盖类操作永远走审批，不预授权；审批不提供永久批准。

## License

MIT

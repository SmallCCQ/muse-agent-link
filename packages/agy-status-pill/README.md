# Antigravity Muse 直连状态 (`antigravity-muse-link`)

在 Antigravity 桌面应用窗口**左下角**显示一枚 Muse 直连状态胶囊：

- 🟢 **已连接** — 本机守护进程在线且 Antigravity 语言服务就绪
- 🟡 **应用未就绪** — 守护进程在线，但语言服务 hub 尚未就绪
- 🔴 **守护进程离线** — 连不上本机守护进程（127.0.0.1:47615）

点击胶囊弹出详情卡（机器名、守护进程版本、语言服务版本、直连会话数、检查时间）。胶囊每 10 秒刷新一次状态；被应用界面重绘冲掉时会在 5 秒内自动挂回。

## 原理

不改 app.asar、不改 google-ultra-suite 的注入器。Antigravity 的 suite 引导脚本会在每次窗口启动时从磁盘读取并 eval `~/.gemini/config/plugins/antigravity-suite-client.js`；本插件只是用 `append-pill.cjs` 把 `pill.js` 里带标记的一段自包含 IIFE **追加**到该文件末尾。追加前会先移除旧的同名标记段（可重复更新）、用 `node --check` 校验合并后的整文件语法、并把原文件备份为 `antigravity-suite-client.js.bak-muse-<时间戳>`，校验不过绝不写入。

数据来自守护进程的免鉴权状态接口 `GET http://127.0.0.1:47615/status`（与 DSH 侧边栏卡片同一条直连通道的本机一端）。

## 安装 / 更新

```powershell
node "<本插件目录>\install_widget.cjs"
```

装好后重启 Antigravity 应用（或新开一个窗口）即可在左下角看到胶囊。

## 卸载

把 `antigravity-suite-client.js` 里 `muse-agent-link status pill (BEGIN)` 与 `(END)` 之间的段落删掉，或直接用最近的 `.bak-muse-*` 备份覆盖回去，然后重启应用。

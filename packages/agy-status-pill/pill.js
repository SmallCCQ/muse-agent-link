// ==== muse-agent-link status pill (BEGIN) ====
// Muse direct-link status pill for the Antigravity desktop app.
// Appended to antigravity-suite-client.js by append-pill.js; the suite
// bootstrap evals that file in the app window, and this IIFE renders a
// small pill in the bottom-left corner that polls the local muse-agent
// -link daemon (http://127.0.0.1:47615/status, no auth needed) and shows
// the link state: connected / app not ready / daemon offline.
(() => {
  if (window.__museLinkPill) return

  const DAEMON_STATUS = 'http://127.0.0.1:47615/status'
  const POLL_MS = 10000

  const css = `
#muse-link-pill{position:fixed;left:14px;bottom:14px;z-index:2147483000;display:flex;align-items:center;gap:7px;
padding:5px 12px 5px 10px;border-radius:999px;background:rgba(13,17,23,.85);border:1px solid rgba(255,255,255,.16);
color:#e5e7eb;font:12px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;cursor:pointer;user-select:none;
backdrop-filter:blur(8px);box-shadow:0 4px 18px rgba(0,0,0,.35)}
#muse-link-pill .mlp-dot{width:8px;height:8px;border-radius:50%;background:#9ca3af;flex:none}
#muse-link-pill[data-mode="ok"] .mlp-dot{background:#34d399;box-shadow:0 0 6px #34d39988}
#muse-link-pill[data-mode="warn"] .mlp-dot{background:#fbbf24;box-shadow:0 0 6px #fbbf2488}
#muse-link-pill[data-mode="down"] .mlp-dot{background:#f87171;box-shadow:0 0 6px #f8717188}
#muse-link-pill .mlp-name{font-weight:600;letter-spacing:.02em}
#muse-link-pill .mlp-state{opacity:.85}
#muse-link-card{position:fixed;left:14px;bottom:52px;z-index:2147483000;width:248px;padding:10px 12px;border-radius:12px;
background:rgba(13,17,23,.92);border:1px solid rgba(255,255,255,.16);color:#e5e7eb;
font:11.5px/1.65 -apple-system,"Segoe UI",system-ui,sans-serif;backdrop-filter:blur(10px);
box-shadow:0 8px 28px rgba(0,0,0,.45);display:none}
#muse-link-card.open{display:block}
#muse-link-card .mlc-title{font-weight:600;font-size:12px;margin-bottom:4px}
#muse-link-card .mlc-row{display:flex;justify-content:space-between;gap:10px}
#muse-link-card .mlc-k{opacity:.65;flex:none}
#muse-link-card .mlc-v{text-align:right;word-break:break-all}
`

  let mode = 'init'
  let data = null
  let root = null
  let card = null

  function ensureDom() {
    if (!document.getElementById('muse-link-pill-style')) {
      const st = document.createElement('style')
      st.id = 'muse-link-pill-style'
      st.textContent = css
      document.head.appendChild(st)
    }
    if (!root || !document.contains(root)) {
      root = document.createElement('div')
      root.id = 'muse-link-pill'
      root.setAttribute('data-mode', 'init')
      root.title = 'Muse 直连状态（点击查看详情）'
      root.innerHTML =
        '<span class="mlp-dot"></span><span class="mlp-name">Muse 直连</span><span class="mlp-state">检测中…</span>'
      root.addEventListener('click', () => {
        if (card) card.classList.toggle('open')
      })
      document.body.appendChild(root)
    }
    if (!card || !document.contains(card)) {
      card = document.createElement('div')
      card.id = 'muse-link-card'
      document.body.appendChild(card)
    }
  }

  function stateText() {
    if (mode === 'ok') return '已连接'
    if (mode === 'warn') return '应用未就绪'
    if (mode === 'down') return '守护进程离线'
    return '检测中…'
  }

  function render() {
    ensureDom()
    root.setAttribute('data-mode', mode)
    root.querySelector('.mlp-state').textContent = stateText()
    const rows = []
    const row = (k, v) =>
      rows.push(
        `<div class="mlc-row"><span class="mlc-k">${k}</span><span class="mlc-v">${v ?? '—'}</span></div>`
      )
    row('状态', stateText())
    if (data) {
      row('机器', data.machine)
      row('守护进程', data.version ? 'v' + data.version : null)
      row('语言服务', data.lsVersion)
      row('直连会话', data.conversations)
      row('检查时间', new Date().toLocaleTimeString())
    }
    card.innerHTML = `<div class="mlc-title">Muse 直连 · Antigravity</div>` + rows.join('')
  }

  async function poll() {
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 3000)
      const res = await fetch(DAEMON_STATUS, { signal: ctl.signal })
      clearTimeout(timer)
      const json = await res.json()
      if (json && json.ok) {
        data = json
        mode = json.hubPort ? 'ok' : 'warn'
      } else {
        mode = 'down'
      }
    } catch (_e) {
      mode = 'down'
    }
    render()
  }

  ensureDom()
  render()
  poll()
  setInterval(poll, POLL_MS)
  // The app is a SPA and may wipe foreign DOM nodes; re-attach if needed.
  setInterval(() => {
    if (!root || !document.contains(root)) render()
  }, 5000)

  window.__museLinkPill = { refresh: poll }
})()
// ==== muse-agent-link status pill (END) ====

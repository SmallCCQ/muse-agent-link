// ==== muse-agent-link status pill (BEGIN) ====
// Muse direct-link status card for the Antigravity desktop app (v1.2).
// Appended to antigravity-suite-client.js by append-pill.cjs; the suite
// bootstrap evals that file in the app window, and this IIFE renders a
// sidebar card styled and mounted like the suite's own Usage & Billing
// trigger card (.dsh-ub-trigger): it is inserted INTO the sidebar footer
// container, directly above the Customizations/Settings rows, so it
// stacks in flow and never overlays the settings button. Status comes
// from the local muse-agent-link daemon (http://127.0.0.1:47615/status).
(() => {
  if (window.__museLinkPill) return

  const DAEMON_STATUS = 'http://127.0.0.1:47615/status'
  const POLL_MS = 10000
  const CARD_ID = 'muse-link-card'

  const css = `
#muse-link-card{box-sizing:border-box;width:100%;min-width:0;margin:10px 0 4px;
border:1px solid var(--ag-ultra-border,rgba(127,127,127,.28));border-radius:12px;
background:var(--ag-ultra-sampled-bg,var(--ag-ultra-bg,rgba(30,34,40,.72)));
-webkit-backdrop-filter:blur(14px) saturate(1.2);backdrop-filter:blur(14px) saturate(1.2);
box-shadow:var(--ag-ultra-shadow,0 4px 18px rgba(0,0,0,.25));
color:var(--ag-ultra-sampled-fg,var(--ag-ultra-fg,#e5e7eb));
font:12px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;
padding:9px 12px;cursor:pointer;user-select:none;position:relative;overflow:hidden}
#muse-link-card:hover{border-color:var(--ag-ultra-border-hover,rgba(96,165,250,.45))}
#muse-link-card .mlc-head{display:flex;align-items:center;gap:8px}
#muse-link-card .mlc-dot{width:8px;height:8px;border-radius:50%;background:#9ca3af;flex:none}
#muse-link-card[data-mode="ok"] .mlc-dot{background:#34d399;box-shadow:0 0 6px #34d39988}
#muse-link-card[data-mode="warn"] .mlc-dot{background:#fbbf24;box-shadow:0 0 6px #fbbf2488}
#muse-link-card[data-mode="down"] .mlc-dot{background:#f87171;box-shadow:0 0 6px #f8717188}
#muse-link-card .mlc-name{font-weight:600;letter-spacing:.02em;flex:none}
#muse-link-card .mlc-state{margin-left:auto;opacity:.85;flex:none}
#muse-link-card .mlc-details{display:none;margin-top:7px;padding-top:7px;
border-top:1px solid var(--ag-ultra-border,rgba(127,127,127,.22));font-size:11.5px}
#muse-link-card.open .mlc-details{display:block}
#muse-link-card .mlc-row{display:flex;justify-content:space-between;gap:10px;line-height:1.65}
#muse-link-card .mlc-k{opacity:.65;flex:none}
#muse-link-card .mlc-v{text-align:right;word-break:break-all}
`

  let mode = 'init'
  let data = null
  let card = null

  // Same anchoring strategy as the suite's sidebar widgets: find the
  // sidebar footer rows (Settings/Customizations first, then Plugins/
  // Skills/Automations) in the bottom-left and insert before them.
  function findAnchor() {
    const footerLabels = new Set(['Customizations', '自定义', 'Settings', '设置'])
    const fallbackLabels = new Set(['Plugins', '插件', 'Automations', '自动化', 'Skills', '技能'])
    const nodes = document.querySelectorAll('span, div, button, a, [role="button"], [role="menuitem"]')
    const candidates = []
    for (const el of nodes) {
      if (el.children && el.children.length > 0) continue
      if (el.closest && el.closest('#' + CARD_ID)) continue
      const txt = (el.textContent || '').trim()
      const isFooter = footerLabels.has(txt)
      const isFallback = !isFooter && fallbackLabels.has(txt)
      if (!isFooter && !isFallback) continue
      const row = el.closest('button, a, [role="button"], [role="menuitem"]') || el.parentElement
      if (!row) continue
      const r = row.getBoundingClientRect()
      if (r.left >= 0 && r.left < 80 && r.width >= 40 && r.width <= 380 && r.top > window.innerHeight * 0.5) {
        candidates.push({ row, top: r.top, priority: isFooter ? 0 : 1 })
      }
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.top - b.top))
    let wrap = candidates[0].row
    while (
      wrap.parentElement &&
      wrap.parentElement !== document.body &&
      wrap.parentElement.children.length === 1 &&
      wrap.parentElement.getBoundingClientRect().height < 90
    ) {
      wrap = wrap.parentElement
    }
    const p = wrap.parentElement
    if (!p || p === document.body) return null
    const pr = p.getBoundingClientRect()
    if (pr.width < 150 || pr.width > 400) return null
    let before = wrap
    for (const ch of Array.from(p.children)) {
      if (ch.id === CARD_ID) continue
      const cr = ch.getBoundingClientRect()
      if (cr.top > window.innerHeight * 0.5 && cr.height > 16 && cr.height < 90) {
        before = ch
        break
      }
    }
    return { container: p, beforeNode: before }
  }

  function ensureCard() {
    if (!document.getElementById('muse-link-card-style')) {
      const st = document.createElement('style')
      st.id = 'muse-link-card-style'
      st.textContent = css
      document.head.appendChild(st)
    }
    if (!card) {
      card = document.createElement('div')
      card.id = CARD_ID
      card.className = 'notranslate'
      card.setAttribute('translate', 'no')
      card.setAttribute('data-ag-localization-skip', 'true')
      card.setAttribute('data-mode', 'init')
      card.title = 'Muse 直连状态（点击展开详情）'
      card.innerHTML =
        '<div class="mlc-head"><span class="mlc-dot"></span>' +
        '<span class="mlc-name">Muse 直连</span>' +
        '<span class="mlc-state">检测中…</span></div>' +
        '<div class="mlc-details"></div>'
      card.addEventListener('click', () => card.classList.toggle('open'))
    }
    return card
  }

  // Mirror the Usage & Billing trigger card's *computed* style so this
  // card always wears the exact same background/border/shadow the
  // current skin paints on it (the skin overrides that card with
  // sampled glass colors via !important rules keyed to its class, which
  // a plain var() background cannot reproduce — it resolves to gray).
  function mirrorRefStyle(el) {
    const ref =
      document.querySelector('.dsh-ub-trigger') ||
      document.querySelector('.dsh-ultra-unified-card')
    if (!ref || ref === el) return
    const cs = window.getComputedStyle(ref)
    el.style.backgroundColor = cs.backgroundColor
    el.style.backgroundImage = cs.backgroundImage
    el.style.borderColor = cs.borderColor
    el.style.boxShadow = cs.boxShadow
    el.style.color = cs.color
    el.style.backdropFilter = cs.backdropFilter
    el.style.webkitBackdropFilter = cs.backdropFilter
  }

  function mount() {
    const el = ensureCard()
    const anchor = findAnchor()
    if (!anchor) {
      el.style.display = 'none'
      return
    }
    const cr = anchor.container.getBoundingClientRect()
    if (cr.width < 140) {
      el.style.display = 'none'
      return
    }
    el.style.display = 'block'
    if (el.parentElement !== anchor.container || el.nextSibling !== anchor.beforeNode) {
      anchor.container.insertBefore(el, anchor.beforeNode)
    }
    mirrorRefStyle(el)
  }

  function stateText() {
    if (mode === 'ok') return '已连接'
    if (mode === 'warn') return '应用未就绪'
    if (mode === 'down') return '守护进程离线'
    return '检测中…'
  }

  function render() {
    const el = ensureCard()
    el.setAttribute('data-mode', mode)
    el.querySelector('.mlc-state').textContent = stateText()
    const rows = []
    const row = (k, v) =>
      rows.push(
        `<div class="mlc-row"><span class="mlc-k">${k}</span><span class="mlc-v">${v ?? '—'}</span></div>`
      )
    if (data) {
      row('机器', data.machine)
      row('守护进程', data.version ? 'v' + data.version : null)
      row('语言服务', data.lsVersion)
      row('直连会话', data.conversations)
      row('检查时间', new Date().toLocaleTimeString())
    } else {
      row('检查时间', new Date().toLocaleTimeString())
    }
    el.querySelector('.mlc-details').innerHTML = rows.join('')
    mount()
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

  render()
  poll()
  setInterval(poll, POLL_MS)
  // The app re-renders its sidebar often; keep the card mounted in flow.
  setInterval(mount, 3000)

  window.__museLinkPill = { refresh: poll }
})()
// ==== muse-agent-link status pill (END) ====

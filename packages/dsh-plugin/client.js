window.__ModuleLoader__.load({
  id: '@local/muse-agent-link',
  factory() {
    const CARD_ATTR = 'data-muse-agent-link-card'
    const STYLE_ATTR = 'data-muse-agent-link-style'

    function ensureStyles() {
      if (document.querySelector(`style[${STYLE_ATTR}]`)) return
      const style = document.createElement('style')
      style.setAttribute(STYLE_ATTR, '')
      style.textContent = `
        [${CARD_ATTR}] {
          margin: 6px 8px;
          padding: 8px 10px;
          border: 1px solid rgba(127, 127, 127, 0.35);
          border-radius: 8px;
          font-size: 12px;
          line-height: 1.5;
        }
        [${CARD_ATTR}] .mal-title { font-weight: 600; }
        [${CARD_ATTR}] .mal-state { opacity: 0.75; }
      `
      document.head.appendChild(style)
    }

    function findSidebarFootArea() {
      const sidebar = document.querySelector(
        '[data-pane="sidebar"], [class*="sidebarCol"], [class*="_root"]'
      )
      if (!sidebar) return document.querySelector('[class*="footArea"]')
      return (
        sidebar.querySelector('[class*="footArea"]') ||
        document.querySelector('[class*="footArea"]')
      )
    }

    async function refreshState(stateEl) {
      try {
        const res = await fetch('/api/muse-agent-link/status')
        const data = await res.json()
        stateEl.textContent = data.paired
          ? `已配对 · ${data.machine} · v${data.version}`
          : `未配对 · 通道待接入 · v${data.version}`
      } catch {
        stateEl.textContent = '状态接口未就绪'
      }
    }

    function mount() {
      ensureStyles()
      let hostEl = null
      let stateEl = null
      let timer = null

      function ensureMounted() {
        const footArea = findSidebarFootArea()
        if (!footArea) return
        const existing = footArea.querySelector(`[${CARD_ATTR}]`)
        if (existing && existing === hostEl) return
        if (hostEl) {
          try {
            hostEl.remove()
          } catch {}
        }
        hostEl = document.createElement('div')
        hostEl.setAttribute(CARD_ATTR, '')
        const title = document.createElement('div')
        title.className = 'mal-title'
        title.textContent = 'Muse 直连'
        stateEl = document.createElement('div')
        stateEl.className = 'mal-state'
        stateEl.textContent = '加载中…'
        hostEl.appendChild(title)
        hostEl.appendChild(stateEl)
        const anchor =
          footArea.querySelector('[class*="footerActions"]') ||
          footArea.querySelector('[class*="settingsArea"]') ||
          footArea.firstChild
        if (anchor) footArea.insertBefore(hostEl, anchor)
        else footArea.prepend(hostEl)
        void refreshState(stateEl)
      }

      ensureMounted()
      timer = setInterval(ensureMounted, 3000)
      return () => {
        if (timer) clearInterval(timer)
        if (hostEl) {
          try {
            hostEl.remove()
          } catch {}
        }
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const cleanup = mount()
        if (ctx && typeof ctx.on === 'function') {
          ctx.on('dispose', cleanup)
        }
      },
    }
  },
})

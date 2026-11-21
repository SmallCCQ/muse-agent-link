window.__ModuleLoader__.load({
  id: '@local/muse-agent-link',
  factory() {
    const CARD_ATTR = 'data-muse-agent-link-card'
    const STYLE_ATTR = 'data-muse-agent-link-style'

    // Visual language mirrors the neighbouring @local/dsh-colab-ultra card:
    // same host CSS variables, radius, glass background, padding and type size,
    // so this card aligns with the modules above and below it in the sidebar.
    function ensureStyles() {
      if (document.querySelector(`style[${STYLE_ATTR}]`)) return
      const style = document.createElement('style')
      style.setAttribute(STYLE_ATTR, '')
      style.textContent = `
        [${CARD_ATTR}] {
          flex: none;
          width: 100%;
          min-width: 0;
          max-width: 100%;
          box-sizing: border-box;
          margin: 0 0 6px 0;
          display: block;
          position: relative;
          container-type: inline-size;
        }
        [class*="collapsed"] [${CARD_ATTR}] {
          display: none !important;
        }
        .mal-card {
          box-sizing: border-box;
          width: 100%;
          min-width: 0;
          padding: 9px 14px;
          border-radius: var(--ds-r-2, 12px);
          border: 1px solid var(--ds-border, var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08)));
          background: var(--dsb-glass, color-mix(in srgb, var(--dsw-alias-bg-layer-2) 78%, transparent));
          -webkit-backdrop-filter: blur(14px) saturate(1.2);
          backdrop-filter: blur(14px) saturate(1.2);
          box-shadow: 0 1px 2px #0000000a;
          color: var(--ds-t-1, var(--dsw-alias-label-primary, #e5e7eb));
          font-size: 11.5px;
          line-height: 16px;
          user-select: none;
          display: flex;
          flex-direction: column;
          gap: 6px;
          position: relative;
          overflow: hidden;
          transition: border-color 0.16s cubic-bezier(0.2, 0.8, 0.2, 1),
                      box-shadow 0.16s cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        .mal-card::before {
          content: "";
          background: linear-gradient(180deg, var(--ds-hi-top, #ffffff0b), transparent);
          pointer-events: none;
          height: 1px;
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
        }
        .mal-card:hover {
          border-color: var(--ds-border-strong, var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.16)));
        }
        .mal-head {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .mal-dot {
          flex: none;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--ds-t-3, var(--dsw-alias-label-tertiary, #9ca3af));
        }
        .mal-dot[data-on="true"] {
          background: #34d399;
        }
        .mal-title {
          font-weight: 600;
        }
        .mal-ver {
          margin-left: auto;
          color: var(--ds-t-3, var(--dsw-alias-label-tertiary, #9ca3af));
        }
        .mal-state {
          color: var(--ds-t-3, var(--dsw-alias-label-tertiary, #9ca3af));
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        @container (width <= 210px) {
          .mal-card {
            padding: 7px 10px;
          }
        }
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

    function mount() {
      ensureStyles()
      let hostEl = null
      let dotEl = null
      let stateEl = null
      let verEl = null
      let mountTimer = null
      let fetchTimer = null
      let lastFetch = 0

      async function refreshState() {
        if (!stateEl) return
        try {
          const res = await fetch('/api/muse-agent-link/status')
          const data = await res.json()
          if (dotEl) dotEl.setAttribute('data-on', data.paired ? 'true' : 'false')
          if (verEl) verEl.textContent = `v${data.version}`
          stateEl.textContent = data.paired
            ? `已配对 · ${data.machine}`
            : '未配对 · 通道待接入'
        } catch {
          stateEl.textContent = '状态接口未就绪'
        }
      }

      function ensureMounted() {
        const footArea = findSidebarFootArea()
        if (!footArea) return
        const existing = footArea.querySelector(`[${CARD_ATTR}]`)
        if (existing && existing === hostEl) {
          if (Date.now() - lastFetch > 15000) {
            lastFetch = Date.now()
            void refreshState()
          }
          return
        }
        if (hostEl) {
          try {
            hostEl.remove()
          } catch {}
        }
        hostEl = document.createElement('div')
        hostEl.setAttribute(CARD_ATTR, '')
        const card = document.createElement('div')
        card.className = 'mal-card'
        const head = document.createElement('div')
        head.className = 'mal-head'
        dotEl = document.createElement('span')
        dotEl.className = 'mal-dot'
        const title = document.createElement('span')
        title.className = 'mal-title'
        title.textContent = 'Muse 直连'
        verEl = document.createElement('span')
        verEl.className = 'mal-ver'
        head.appendChild(dotEl)
        head.appendChild(title)
        head.appendChild(verEl)
        stateEl = document.createElement('div')
        stateEl.className = 'mal-state'
        stateEl.textContent = '加载中…'
        card.appendChild(head)
        card.appendChild(stateEl)
        hostEl.appendChild(card)
        const anchor =
          footArea.querySelector('[class*="footerActions"]') ||
          footArea.querySelector('[class*="settingsArea"]') ||
          footArea.firstChild
        if (anchor) footArea.insertBefore(hostEl, anchor)
        else footArea.prepend(hostEl)
        lastFetch = Date.now()
        void refreshState()
      }

      ensureMounted()
      mountTimer = setInterval(ensureMounted, 3000)
      fetchTimer = setInterval(() => {
        lastFetch = Date.now()
        void refreshState()
      }, 30000)
      return () => {
        if (mountTimer) clearInterval(mountTimer)
        if (fetchTimer) clearInterval(fetchTimer)
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

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
        [class*="collapsed"] [${CARD_ATTR}] { display: none !important; }
        .mal-card {
          box-sizing: border-box;
          width: 100%;
          padding: 9px 12px;
          border-radius: var(--ds-r-2, 12px);
          border: 1px solid var(--ds-border, var(--dsw-alias-border-l1, rgba(255,255,255,0.08)));
          background: var(--dsb-glass, color-mix(in srgb, var(--dsw-alias-bg-layer-2) 78%, transparent));
          -webkit-backdrop-filter: blur(14px) saturate(1.2);
          backdrop-filter: blur(14px) saturate(1.2);
          color: var(--ds-t-1, var(--dsw-alias-label-primary, #e5e7eb));
          font-size: 11.5px;
          line-height: 16px;
          user-select: none;
          display: flex;
          flex-direction: column;
          gap: 6px;
          position: relative;
          overflow: hidden;
        }
        .mal-card:hover {
          border-color: var(--ds-border-strong, var(--dsw-alias-border-l2, rgba(255,255,255,0.16)));
        }
        .mal-head {
          display: flex;
          align-items: center;
          gap: 6px;
          cursor: pointer;
        }
        .mal-dot {
          flex: none;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #9ca3af;
        }
        .mal-dot[data-on="ok"], .mal-dot[data-presence="active"] { background: #22c55e; box-shadow: 0 0 6px #22c55e99; }
        .mal-dot[data-presence="online"] { background: #34d399; }
        .mal-dot[data-on="warn"] { background: #fbbf24; }
        .mal-dot[data-on="down"], .mal-dot[data-presence="offline"] { background: #f87171; }
        .mal-dot[data-presence="never"] { background: #9ca3af; }
        .mal-pst { font-size: 10px; opacity: 0.75; flex: none; }
        .mal-pst[data-presence="active"], .mal-pst[data-presence="online"] { color: #34d399; opacity: 1; }
        .mal-pst[data-presence="offline"] { color: #f87171; opacity: 0.95; }
        .mal-title { font-weight: 600; }
        .mal-ver { margin-left: auto; color: var(--ds-t-3, #9ca3af); font-size: 10.5px; }
        .mal-state {
          color: var(--ds-t-3, #9ca3af);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          cursor: pointer;
        }
        .mal-panel {
          display: none;
          flex-direction: column;
          gap: 6px;
          padding-top: 6px;
          border-top: 1px solid rgba(255,255,255,0.08);
        }
        .mal-card[data-open="true"] .mal-panel { display: flex; }
        .mal-sec-title {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: .04em;
          color: var(--ds-t-3, #9ca3af);
        }
        .mal-acc-row, .mal-tkt-row {
          display: flex;
          align-items: center;
          gap: 5px;
          font-size: 11px;
        }
        .mal-badge {
          font-size: 9.5px;
          padding: 0 4px;
          border-radius: 4px;
          background: rgba(96,165,250,0.16);
          color: #93c5fd;
        }
        .mal-badge[data-role="collaborator"] {
          background: rgba(251,191,36,0.16);
          color: #fcd34d;
        }
        .mal-code {
          font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
          font-weight: 700;
          letter-spacing: .08em;
          color: #34d399;
          cursor: pointer;
        }
        .mal-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          margin-top: 2px;
        }
        .mal-btn {
          flex: 1 1 auto;
          padding: 3px 6px;
          border-radius: 6px;
          border: 1px solid rgba(255,255,255,0.14);
          background: rgba(255,255,255,0.06);
          color: inherit;
          font-size: 10.5px;
          cursor: pointer;
          text-align: center;
        }
        .mal-btn:hover { background: rgba(255,255,255,0.14); }
        .mal-btn-mini {
          margin-left: auto;
          padding: 1px 5px;
          border-radius: 4px;
          border: 1px solid rgba(248,113,113,0.35);
          background: transparent;
          color: #fca5a5;
          font-size: 10px;
          cursor: pointer;
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

    function currentSessionIdFromUrl() {
      const m = (window.location.pathname + window.location.search + window.location.hash).match(
        /(session-[0-9a-f-]{8,})/i
      )
      return m ? m[1] : null
    }

    function mount() {
      ensureStyles()
      let hostEl = null
      let cardEl = null
      let dotEl = null
      let stateEl = null
      let verEl = null
      let panelEl = null
      let isOpen = false
      let lastOverview = null
      let mountTimer = null
      let fetchTimer = null
      let lastFetch = 0

      function renderPanel(data) {
        if (!panelEl) return
        panelEl.innerHTML = ''
        if (!data || !data.ok) {
          const msg = document.createElement('div')
          msg.style.color = '#fca5a5'
          msg.textContent = 'Muse Hub 未运行（127.0.0.1:47617）'
          panelEl.appendChild(msg)
          return
        }

        const activeAccounts = (data.accounts || []).filter((a) => a.status === 'active')
        const sec1 = document.createElement('div')
        sec1.className = 'mal-sec-title'
        sec1.textContent = `已接入账号 (${activeAccounts.length}) · ${data.tailnetIp || 'no-tailnet'}:${data.tailnetPort}`
        panelEl.appendChild(sec1)

        if (activeAccounts.length === 0) {
          const empty = document.createElement('div')
          empty.style.opacity = '0.7'
          empty.textContent = '暂无账号，点击下方生成配对码'
          panelEl.appendChild(empty)
        } else {
          const fmtAgo = (iso) => {
            if (!iso) return '尚未通信'
            const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
            if (sec < 60) return `${sec}秒前`
            if (sec < 3600) return `${Math.floor(sec / 60)}分钟前`
            return `${Math.floor(sec / 3600)}小时前`
          }
          for (const acc of activeAccounts) {
            const row = document.createElement('div')
            row.className = 'mal-acc-row'
            const presence = acc.presence || (acc.online ? 'online' : 'never')
            const d = document.createElement('span')
            d.className = 'mal-dot'
            d.setAttribute('data-presence', presence)
            const shortState =
              presence === 'active'
                ? '活跃'
                : presence === 'online'
                  ? '在线'
                  : presence === 'offline'
                    ? '离线'
                    : '未连'
            const pst = document.createElement('span')
            pst.className = 'mal-pst'
            pst.setAttribute('data-presence', presence)
            pst.textContent = shortState
            row.title = `${acc.label} · ${shortState} · 最近通信：${fmtAgo(acc.lastContactAt)}`
            const name = document.createElement('span')
            name.textContent = acc.label
            name.style.overflow = 'hidden'
            name.style.textOverflow = 'ellipsis'
            name.style.whiteSpace = 'nowrap'
            const badge = document.createElement('span')
            badge.className = 'mal-badge'
            badge.setAttribute('data-role', acc.role)
            badge.textContent = acc.role === 'collaborator' ? '协作' : 'Owner'
            const cnt = document.createElement('span')
            cnt.style.opacity = '0.7'
            cnt.textContent = `${acc.activeThreads || 0}窗`
            const rev = document.createElement('button')
            rev.className = 'mal-btn-mini'
            rev.textContent = '吊销'
            rev.onclick = async (ev) => {
              ev.stopPropagation()
              if (!window.confirm(`确认吊销 Muse 账号「${acc.label}」？`)) return
              await fetch(`/api/muse-agent-link/admin-revoke?id=${encodeURIComponent(acc.id)}`, { method: 'POST' })
              void refreshState()
            }
            row.append(d, name, badge, pst, cnt, rev)
            panelEl.appendChild(row)
          }
        }

        const tickets = data.tickets || []
        if (tickets.length > 0) {
          const secT = document.createElement('div')
          secT.className = 'mal-sec-title'
          secT.textContent = '待配对票据（点击复制）'
          panelEl.appendChild(secT)
          for (const t of tickets) {
            const row = document.createElement('div')
            row.className = 'mal-tkt-row'
            const code = document.createElement('span')
            code.className = 'mal-code'
            code.textContent = t.code
            code.title = '点击复制配对码'
            code.onclick = (ev) => {
              ev.stopPropagation()
              try { navigator.clipboard.writeText(t.code) } catch {}
              code.textContent = `${t.code} ✓`
            }
            const lbl = document.createElement('span')
            lbl.textContent = `${t.label} (${t.role === 'collaborator' ? '协作' : 'Owner'})`
            lbl.style.opacity = '0.8'
            row.append(code, lbl)
            panelEl.appendChild(row)
          }
        }

        const acts = document.createElement('div')
        acts.className = 'mal-actions'

        const btnOwner = document.createElement('button')
        btnOwner.className = 'mal-btn'
        btnOwner.textContent = '+ 主号配对码'
        btnOwner.onclick = async (ev) => {
          ev.stopPropagation()
          const label = window.prompt('新 Muse 主号别名（如 Victor·二号）：', `Victor·号${activeAccounts.length + 1}`)
          if (label === null) return
          await fetch('/api/muse-agent-link/admin-ticket', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ label: label.trim() || undefined, role: 'owner' }),
          })
          void refreshState()
        }

        const btnCollab = document.createElement('button')
        btnCollab.className = 'mal-btn'
        btnCollab.textContent = '+ 协作配对码'
        btnCollab.onclick = async (ev) => {
          ev.stopPropagation()
          const label = window.prompt('协作账户别名：', '协作账户')
          if (label === null) return
          const ws = window.prompt('允许访问的单一沙箱目录（留空用默认隔离目录）：', '')
          if (ws === null) return
          await fetch('/api/muse-agent-link/admin-ticket', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              label: label.trim() || '协作账户',
              role: 'collaborator',
              ...(ws.trim() ? { workspaceRoots: [ws.trim()] } : {}),
            }),
          })
          void refreshState()
        }

        const btnAttach = document.createElement('button')
        btnAttach.className = 'mal-btn'
        btnAttach.textContent = '挂载当前会话'
        btnAttach.onclick = async (ev) => {
          ev.stopPropagation()
          const owners = activeAccounts.filter((a) => a.role === 'owner')
          if (!owners.length) {
            window.alert('请先配对至少一个 Owner Muse 账号。')
            return
          }
          const sid = currentSessionIdFromUrl() || window.prompt('输入要挂载的 DSH Session ID：', '')
          if (!sid) return
          const targetAcc =
            owners.length === 1
              ? owners[0].id
              : window.prompt(
                  `输入目标 Owner 账号 ID：\n${owners.map((o) => `${o.id} (${o.label})`).join('\n')}`,
                  owners[0].id
                )
          if (!targetAcc) return
          const res = await fetch('/api/muse-agent-link/admin-attach', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ accountId: targetAcc.trim(), agent: 'dsh', localSessionId: sid.trim() }),
          })
          const j = await res.json().catch(() => ({}))
          if (j.ok) {
            window.alert(`已挂载到 ${targetAcc}，线程 ID：${j.thread?.id}`)
            void refreshState()
          } else {
            window.alert(`挂载失败：${j.error?.message || res.status}`)
          }
        }

        acts.append(btnOwner, btnCollab, btnAttach)
        panelEl.appendChild(acts)
      }

      async function refreshState() {
        if (!stateEl) return
        try {
          const res = await fetch('/api/muse-agent-link/admin-overview')
          const data = await res.json()
          lastOverview = data
          const active = (data.accounts || []).filter((a) => a.status === 'active')
          const online = active.filter((a) => a.online).length
          const dshOk = Boolean(data.agents?.dsh?.available)
          const agyOk = Boolean(data.agents?.antigravity?.available)
          if (verEl) verEl.textContent = `v${data.version || '2.0'}`
          if (dotEl) {
            dotEl.setAttribute('data-on', data.tailnetListening ? (online > 0 || active.length > 0 ? 'ok' : 'warn') : 'warn')
          }
          const agyTag = agyOk ? 'AGY✓' : 'AGY·'
          const dshTag = dshOk ? 'DSH✓' : 'DSH·'
          stateEl.textContent = `${active.length} 账号(${online}在线) · ${dshTag} ${agyTag}`
          renderPanel(data)
        } catch {
          if (dotEl) dotEl.setAttribute('data-on', 'down')
          stateEl.textContent = 'Muse Hub 未连接'
          renderPanel(null)
        }
      }

      function ensureMounted() {
        const footArea = findSidebarFootArea()
        if (!footArea) return
        const existing = footArea.querySelector(`[${CARD_ATTR}]`)
        if (existing && existing === hostEl) {
          if (Date.now() - lastFetch > 12000) {
            lastFetch = Date.now()
            void refreshState()
          }
          return
        }
        if (hostEl) {
          try { hostEl.remove() } catch {}
        }
        hostEl = document.createElement('div')
        hostEl.setAttribute(CARD_ATTR, '')
        cardEl = document.createElement('div')
        cardEl.className = 'mal-card'
        cardEl.setAttribute('data-open', isOpen ? 'true' : 'false')

        const toggle = () => {
          isOpen = !isOpen
          cardEl.setAttribute('data-open', isOpen ? 'true' : 'false')
          if (isOpen && lastOverview) renderPanel(lastOverview)
        }

        const head = document.createElement('div')
        head.className = 'mal-head'
        head.onclick = toggle
        dotEl = document.createElement('span')
        dotEl.className = 'mal-dot'
        const title = document.createElement('span')
        title.className = 'mal-title'
        title.textContent = 'Muse Hub'
        verEl = document.createElement('span')
        verEl.className = 'mal-ver'
        head.append(dotEl, title, verEl)

        stateEl = document.createElement('div')
        stateEl.className = 'mal-state'
        stateEl.textContent = '加载中…'
        stateEl.onclick = toggle

        panelEl = document.createElement('div')
        panelEl.className = 'mal-panel'

        cardEl.append(head, stateEl, panelEl)
        hostEl.appendChild(cardEl)
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
      }, 20000)
      return () => {
        if (mountTimer) clearInterval(mountTimer)
        if (fetchTimer) clearInterval(fetchTimer)
        if (hostEl) {
          try { hostEl.remove() } catch {}
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

// ==== muse-agent-link status pill (BEGIN) ====
// Muse Hub v2 multi-account sidebar card for the Antigravity desktop app.
// Appended to antigravity-suite-client.js by append-pill.cjs (no app.asar edits).
// Talks strictly to loopback Muse Hub (http://127.0.0.1:47617/admin/*) with
// fallback to legacy http://127.0.0.1:47615/status.
(() => {
  if (window.__museLinkPill) return

  const HUB_ADMIN = 'http://127.0.0.1:47617'
  const LEGACY_STATUS = 'http://127.0.0.1:47615/status'
  const POLL_MS = 10000
  const CARD_ID = 'muse-link-card'

  const css = `
#muse-link-card{box-sizing:border-box;width:100%;min-width:0;margin:10px 0 4px;
border:1px solid var(--ag-ultra-border,rgba(127,127,127,.28));border-radius:12px;
background:var(--ag-ultra-sampled-bg,var(--ag-ultra-bg,rgba(30,34,40,.72)));
-webkit-backdrop-filter:blur(14px) saturate(1.2);backdrop-filter:blur(14px) saturate(1.2);
box-shadow:var(--ag-ultra-shadow,0 4px 18px rgba(0,0,0,.25));
color:var(--ag-ultra-sampled-fg,var(--ag-ultra-fg,#e5e7eb));
font:11.5px/1.45 -apple-system,"Segoe UI",system-ui,sans-serif;
padding:9px 11px;user-select:none;position:relative;overflow:hidden}
#muse-link-card:hover{border-color:var(--ag-ultra-border-hover,rgba(96,165,250,.45))}
#muse-link-card .mlc-head{display:flex;align-items:center;gap:7px;cursor:pointer}
#muse-link-card .mlc-dot{width:7.5px;height:7.5px;border-radius:50%;background:#9ca3af;flex:none}
#muse-link-card[data-mode="ok"] .mlc-dot{background:#34d399;box-shadow:0 0 6px #34d39988}
#muse-link-card[data-mode="warn"] .mlc-dot{background:#fbbf24;box-shadow:0 0 6px #fbbf2488}
#muse-link-card[data-mode="down"] .mlc-dot{background:#f87171;box-shadow:0 0 6px #f8717188}
#muse-link-card .mlc-name{font-weight:600;letter-spacing:.01em;flex:none}
#muse-link-card .mlc-state{margin-left:auto;opacity:.82;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#muse-link-card .mlc-details{display:none;margin-top:7px;padding-top:7px;
border-top:1px solid var(--ag-ultra-border,rgba(127,127,127,.22));font-size:11px;flex-direction:column;gap:5px}
#muse-link-card.open .mlc-details{display:flex}
#muse-link-card .mlc-row{display:flex;align-items:center;justify-content:space-between;gap:6px}
#muse-link-card .mlc-k{opacity:.65;flex:none}
#muse-link-card .mlc-v{text-align:right;word-break:break-all;opacity:.92}
#muse-link-card .mlc-sec{font-size:10px;opacity:.6;margin-top:3px;letter-spacing:.03em}
#muse-link-card .mlc-acc{display:flex;align-items:center;gap:5px}
#muse-link-card .mlc-adot{width:7px;height:7px;border-radius:50%;background:#9ca3af;flex:none}
#muse-link-card .mlc-adot[data-presence="active"]{background:#22c55e;box-shadow:0 0 6px #22c55eaa}
#muse-link-card .mlc-adot[data-presence="online"]{background:#34d399}
#muse-link-card .mlc-adot[data-presence="offline"]{background:#f87171}
#muse-link-card .mlc-adot[data-presence="never"]{background:#9ca3af}
#muse-link-card .mlc-pst{font-size:10px;opacity:.75;flex:none}
#muse-link-card .mlc-pst[data-presence="active"],#muse-link-card .mlc-pst[data-presence="online"]{color:#34d399;opacity:1}
#muse-link-card .mlc-pst[data-presence="offline"]{color:#f87171;opacity:.95}
#muse-link-card .mlc-albl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#muse-link-card .mlc-badge{font-size:9.5px;padding:0 4px;border-radius:4px;background:rgba(96,165,250,.18);color:#93c5fd;flex:none}
#muse-link-card .mlc-badge[data-role="collaborator"]{background:rgba(251,191,36,.18);color:#fcd34d}
#muse-link-card .mlc-code{font-family:ui-monospace,Consolas,monospace;font-weight:700;letter-spacing:.08em;color:#34d399;cursor:pointer}
#muse-link-card .mlc-acts{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
#muse-link-card .mlc-btn{flex:1 1 auto;padding:3px 6px;border-radius:6px;border:1px solid rgba(148,163,184,.28);
background:rgba(255,255,255,.07);color:inherit;font-size:10.5px;cursor:pointer;text-align:center}
#muse-link-card .mlc-btn:hover{background:rgba(255,255,255,.16)}
#muse-link-card .mlc-rev{margin-left:auto;padding:1px 5px;border-radius:4px;border:1px solid rgba(248,113,113,.38);
background:transparent;color:#fca5a5;font-size:9.5px;cursor:pointer;flex:none}
#muse-link-card .mlc-copy{margin-left:auto;padding:1px 6px;border-radius:4px;border:1px solid rgba(52,211,153,.42);
background:rgba(52,211,153,.12);color:#6ee7b7;font-size:9.5px;cursor:pointer;flex:none;white-space:nowrap}
#muse-link-card .mlc-copy:hover{background:rgba(52,211,153,.24)}
#muse-link-card .mlc-funnel{display:flex;align-items:center;gap:5px;padding:3px 6px;border-radius:6px;
background:rgba(255,255,255,.04);border:1px solid rgba(148,163,184,.16);margin-top:2px}
#muse-link-card .mlc-flink{font-size:10px;color:#fcd34d;cursor:pointer;text-decoration:underline;padding:1px 2px}
`

  let mode = 'init'
  let overview = null
  let card = null

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

  function detectCurrentConvId() {
    const m = (window.location.href || '').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
    return m ? m[1] : null
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
      card.title = 'Muse Hub v2 多账号通道（点击展开管理）'
      card.innerHTML =
        '<div class="mlc-head"><span class="mlc-dot"></span>' +
        '<span class="mlc-name">Muse Hub</span>' +
        '<span class="mlc-state">检测中…</span></div>' +
        '<div class="mlc-details"></div>'
      card.querySelector('.mlc-head').addEventListener('click', () => card.classList.toggle('open'))
    }
    return card
  }

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

  function mk(tag, cls, text) {
    const el = document.createElement(tag)
    if (cls) el.className = cls
    if (text !== undefined) el.textContent = text
    return el
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
    } else {
      fallbackCopy(text)
    }
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      ta.style.top = '0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      document.execCommand('copy')
      ta.remove()
    } catch {}
  }

  function buildOnboardingPrompt(ticket, ov) {
    const dnsName = String(ov?.tailnetDnsName || '').replace(/\.+$/, '')
    const rawHost = dnsName ? dnsName.split('.')[0] : String(ov?.machine || 'pc')
    const baseSlug = rawHost.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'pc'
    if (ticket.role === 'collaborator') {
      const slug = `${baseSlug}-collab`
      const funnelUrl = ov?.funnelUrl || (dnsName ? `https://${dnsName}` : 'https://<本机Tailscale域名>')
      return [
        '请帮我连接一个受限的远程 DSH 协作工作区（公网 HTTPS 网关，无需 Tailscale）：',
        '1. 下载客户端并配对：',
        'mkdir -p ~/.muse-link/credentials ~/.muse-link/state',
        'curl -fsSL https://raw.githubusercontent.com/SmallCCQ/muse-agent-link/main/tools/muse_link_client.py -o ~/.muse-link/muse_link_client.py',
        `python3 ~/.muse-link/muse_link_client.py --machine ${slug} --url ${funnelUrl} pair --code ${ticket.code}`,
        `python3 ~/.muse-link/muse_link_client.py --machine ${slug} me`,
        '',
        `2. 后续所有操作均使用 --machine ${slug}（仅允许 --agent dsh，不要使用 antigravity）：`,
        `- 开窗/复用：python3 ~/.muse-link/muse_link_client.py --machine ${slug} open --agent dsh --window-key "topic:main" --title "协作对话"`,
        `- 发送并等待回复：python3 ~/.muse-link/muse_link_client.py --machine ${slug} send <threadId> "<消息>" --wait 75`,
        '- 若返回 approval_requested，请提醒主机主人在其本地电脑桌面点击确认，不要自行审批。',
      ].join('\n')
    }
    const hostIp = ov?.tailnetIp || '<本机Tailscale-IP>'
    const port = ov?.tailnetPort || 47616
    return [
      '请帮我把本 Muse 账号接入本机 Muse Hub v2（私有 Tailscale 直连，支持 DSH + Antigravity）：',
      '1. 下载客户端并配对：',
      'mkdir -p ~/.muse-link/credentials ~/.muse-link/state',
      'curl -fsSL https://raw.githubusercontent.com/SmallCCQ/muse-agent-link/main/tools/muse_link_client.py -o ~/.muse-link/muse_link_client.py',
      `python3 ~/.muse-link/muse_link_client.py --machine ${baseSlug} --host ${hostIp} --port ${port} pair --code ${ticket.code}`,
      `python3 ~/.muse-link/muse_link_client.py --machine ${baseSlug} me`,
      '',
      '2. 常用命令（--agent 可选 antigravity 或 dsh）：',
      `- 开窗/复用：python3 ~/.muse-link/muse_link_client.py --machine ${baseSlug} open --agent antigravity --window-key "topic:main" --title "远程对话"`,
      `- 发送并等待回复：python3 ~/.muse-link/muse_link_client.py --machine ${baseSlug} send <threadId> "<消息>" --wait 75`,
      `- 拉取事件：python3 ~/.muse-link/muse_link_client.py --machine ${baseSlug} poll --wait 0`,
    ].join('\n')
  }

  function render() {
    const el = ensureCard()
    el.setAttribute('data-mode', mode)
    const stateNode = el.querySelector('.mlc-state')
    const det = el.querySelector('.mlc-details')
    det.innerHTML = ''

    if (!overview) {
      stateNode.textContent = mode === 'down' ? 'Hub 离线' : '检测中…'
      det.appendChild(mk('div', 'mlc-row', '请确认本机 Muse Hub (:47617) 已启动'))
      mount()
      return
    }

    const active = (overview.accounts || []).filter((a) => a.status === 'active')
    const online = active.filter((a) => a.online).length
    const agyOk = Boolean(overview.agents?.antigravity?.available)
    const dshOk = Boolean(overview.agents?.dsh?.available)
    stateNode.textContent = `${active.length}号(${online}在线) · ${agyOk ? 'AGY✓' : 'AGY·'} ${dshOk ? 'DSH✓' : 'DSH·'}`

    const addRow = (k, v) => {
      const r = mk('div', 'mlc-row')
      r.append(mk('span', 'mlc-k', k), mk('span', 'mlc-v', v == null ? '—' : String(v)))
      det.appendChild(r)
    }
    addRow('入口', `${overview.tailnetIp || '—'}:${overview.tailnetPort || 47616}${overview.tailnetListening ? ' ✓' : ' (等待接管)'}`)
    addRow('引擎', `Hub v${overview.version || '2.0'} · AGY ${overview.agents?.antigravity?.lsVersion || '—'}`)

    const funnel = overview.funnel || {}
    const handleFunnelResult = (j) => {
      if (!j) return
      if (j.needsApproval && j.enableUrl) {
        copyToClipboard(j.enableUrl)
        try { window.open(j.enableUrl, '_blank', 'noopener') } catch {}
        window.alert(
          'Tailscale 首次启用公网 Funnel 需在浏览器控制台点一次「Enable Funnel」（一次性授权，链接已复制到剪贴板）：\n\n' +
          j.enableUrl +
          '\n\n授权完成后，点卡片上的「开启公网」即可自动生效。'
        )
      } else if (!j.ok && j.message) {
        window.alert('公网 Funnel 操作失败：' + j.message)
      }
    }
    const fRow = mk('div', 'mlc-funnel')
    const fDot = mk('span', 'mlc-adot')
    fDot.setAttribute('data-presence', funnel.active ? 'active' : 'never')
    const fLbl = mk('span', 'mlc-albl', funnel.active ? '公网协作 · 已开启' : '公网协作 · 未开启')
    fLbl.style.flex = '1 1 auto'
    fLbl.title = funnel.url ? `${funnel.url} → ${funnel.target || '127.0.0.1:47619'}` : '无需对方加入 Tailscale 的受限 DSH 入口'
    const fBtn = mk('button', funnel.active ? 'mlc-rev' : 'mlc-copy', funnel.active ? '关闭公网' : '开启公网')
    fBtn.onclick = async (ev) => {
      ev.stopPropagation()
      fBtn.disabled = true
      fBtn.textContent = funnel.active ? '关闭中…' : '开启中…'
      try {
        const ep = funnel.active ? `${HUB_ADMIN}/admin/funnel/disable` : `${HUB_ADMIN}/admin/funnel/enable`
        const r = await fetch(ep, { method: 'POST' })
        const j = await r.json().catch(() => null)
        handleFunnelResult(j)
      } finally {
        void poll()
      }
    }
    fRow.append(fDot, fLbl, fBtn)
    det.appendChild(fRow)
    if (!funnel.active && funnel.enableUrl) {
      const fLink = mk('div', 'mlc-flink', '↗ 点此去 Tailscale 控制台启用 Funnel（一次性授权）')
      fLink.onclick = (ev) => {
        ev.stopPropagation()
        copyToClipboard(funnel.enableUrl)
        try { window.open(funnel.enableUrl, '_blank', 'noopener') } catch {}
      }
      det.appendChild(fLink)
    }

    det.appendChild(mk('div', 'mlc-sec', `已接入 Muse 账号 (${active.length})`))
    if (active.length === 0) {
      det.appendChild(mk('div', 'mlc-k', '暂无账号，点下方按钮生成配对码'))
    } else {
      const fmtAgo = (iso) => {
        if (!iso) return '尚未通信'
        const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
        if (sec < 60) return `${sec}秒前`
        if (sec < 3600) return `${Math.floor(sec / 60)}分钟前`
        return `${Math.floor(sec / 3600)}小时前`
      }
      for (const acc of active) {
        const row = mk('div', 'mlc-acc')
        const presence = acc.presence || (acc.online ? 'online' : 'never')
        const dot = mk('span', 'mlc-adot')
        dot.setAttribute('data-presence', presence)
        const shortState =
          presence === 'active'
            ? '活跃'
            : presence === 'online'
              ? '在线'
              : presence === 'offline'
                ? '离线'
                : '未连'
        const pst = mk('span', 'mlc-pst', shortState)
        pst.setAttribute('data-presence', presence)
        row.title = `${acc.label} · ${shortState} · 最近通信：${fmtAgo(acc.lastContactAt)}`
        const badge = mk('span', 'mlc-badge', acc.role === 'collaborator' ? '协作' : 'Owner')
        badge.setAttribute('data-role', acc.role)
        const rev = mk('button', 'mlc-rev', '吊销')
        rev.onclick = async (ev) => {
          ev.stopPropagation()
          if (!window.confirm(`确认吊销 Muse 账号「${acc.label}」？`)) return
          await fetch(`${HUB_ADMIN}/admin/accounts/${encodeURIComponent(acc.id)}/revoke`, { method: 'POST' })
          const remainCollab = active.filter((x) => x.role === 'collaborator' && x.id !== acc.id).length
          if (acc.role === 'collaborator' && remainCollab === 0 && funnel.active) {
            if (window.confirm('当前已无活跃协作账号，是否顺手关闭公网 Funnel 入口？')) {
              await fetch(`${HUB_ADMIN}/admin/funnel/disable`, { method: 'POST' }).catch(() => {})
            }
          }
          void poll()
        }
        row.append(dot, mk('span', 'mlc-albl', acc.label), badge, pst, mk('span', 'mlc-k', `${acc.activeThreads || 0}窗`), rev)
        det.appendChild(row)
      }
    }

    const tickets = overview.tickets || []
    if (tickets.length > 0) {
      det.appendChild(mk('div', 'mlc-sec', '待配对码（可点码或一键复制指令）'))
      for (const t of tickets) {
        const row = mk('div', 'mlc-acc')
        const code = mk('span', 'mlc-code', t.code)
        code.title = '点击仅复制 6 位配对码'
        code.onclick = (ev) => {
          ev.stopPropagation()
          copyToClipboard(t.code)
          code.textContent = `${t.code} ✓`
          setTimeout(() => { code.textContent = t.code }, 1800)
        }
        const lbl = mk('span', 'mlc-albl', `${t.label} (${t.role === 'collaborator' ? '协作' : 'Owner'})`)
        lbl.title = lbl.textContent
        const btnCopy = mk('button', 'mlc-copy', '复制指令')
        btnCopy.title = '一键复制完整 Muse 接入指令发给对方'
        btnCopy.onclick = (ev) => {
          ev.stopPropagation()
          copyToClipboard(buildOnboardingPrompt(t, overview))
          btnCopy.textContent = '已复制 ✓'
          setTimeout(() => { btnCopy.textContent = '复制指令' }, 2000)
        }
        row.append(code, lbl, btnCopy)
        det.appendChild(row)
      }
    }

    const acts = mk('div', 'mlc-acts')
    const btnOwner = mk('button', 'mlc-btn', '+ 主号码')
    btnOwner.onclick = async (ev) => {
      ev.stopPropagation()
      const label = window.prompt('新 Muse 主号别名：', `Victor·号${active.length + 1}`)
      if (label === null) return
      await fetch(`${HUB_ADMIN}/admin/pairing-tickets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: label.trim() || undefined, role: 'owner' }),
      })
      void poll()
    }

    const btnCollab = mk('button', 'mlc-btn', '+ 协作码')
    btnCollab.onclick = async (ev) => {
      ev.stopPropagation()
      const label = window.prompt('协作账户别名：', '协作账户')
      if (label === null) return
      const ws = window.prompt('锁定单一沙箱目录（留空使用默认隔离目录）：', '')
      if (ws === null) return
      await fetch(`${HUB_ADMIN}/admin/pairing-tickets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label: label.trim() || '协作账户',
          role: 'collaborator',
          allowedAgents: ['dsh'],
          ...(ws.trim() ? { workspaceRoots: [ws.trim()] } : {}),
        }),
      })
      if (!funnel.active) {
        const fr = await fetch(`${HUB_ADMIN}/admin/funnel/enable`, { method: 'POST' }).catch(() => null)
        const fj = fr ? await fr.json().catch(() => null) : null
        handleFunnelResult(fj)
      }
      void poll()
    }

    const btnAttach = mk('button', 'mlc-btn', '挂载会话')
    btnAttach.onclick = async (ev) => {
      ev.stopPropagation()
      const owners = active.filter((a) => a.role === 'owner')
      if (!owners.length) {
        window.alert('请先配对至少一个 Owner Muse 账号。')
        return
      }
      let cid = detectCurrentConvId()
      if (!cid) {
        try {
          const r = await fetch(`${HUB_ADMIN}/admin/local-sessions`).then((x) => x.json())
          const top = (r.antigravity || []).slice(0, 6)
          const hint = top.map((x, i) => `${i + 1}. ${x.localSessionId} (${x.preview || '无预览'})`).join('\n')
          cid = window.prompt(`输入要挂载的 AGY 对话 UUID（默认最近一条）：\n${hint}`, top[0]?.localSessionId || '')
        } catch {
          cid = window.prompt('输入要挂载的 AGY 对话 UUID：', '')
        }
      }
      if (!cid || !cid.trim()) return
      const targetAcc =
        owners.length === 1
          ? owners[0].id
          : window.prompt(
              `选择目标 Owner 账号 ID：\n${owners.map((o) => `${o.id} (${o.label})`).join('\n')}`,
              owners[0].id
            )
      if (!targetAcc) return
      const res = await fetch(`${HUB_ADMIN}/admin/attach`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: targetAcc.trim(), agent: 'antigravity', localSessionId: cid.trim() }),
      })
      const j = await res.json().catch(() => ({}))
      if (j.ok) {
        window.alert(`已挂载到 ${targetAcc}，线程 ID：${j.thread?.id}`)
        void poll()
      } else {
        window.alert(`挂载失败：${j.error?.message || res.status}`)
      }
    }

    acts.append(btnOwner, btnCollab, btnAttach)
    det.appendChild(acts)
    mount()
  }

  async function poll() {
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 3000)
      const res = await fetch(`${HUB_ADMIN}/admin/overview`, { signal: ctl.signal })
      clearTimeout(timer)
      const json = await res.json()
      if (json && json.ok) {
        overview = json
        mode = json.agents?.antigravity?.available && json.tailnetListening ? 'ok' : 'warn'
      } else {
        overview = null
        mode = 'down'
      }
    } catch (_e) {
      try {
        const res2 = await fetch(LEGACY_STATUS)
        const j2 = await res2.json()
        if (j2 && j2.ok) {
          overview = {
            version: j2.version,
            tailnetIp: '100.x',
            tailnetPort: 47616,
            tailnetListening: Boolean(j2.tailnetListening),
            agents: { antigravity: { available: Boolean(j2.hubPort), lsVersion: j2.lsVersion }, dsh: { available: Boolean(j2.dshAvailable) } },
            accounts: [],
            tickets: [],
          }
          mode = j2.hubPort ? 'ok' : 'warn'
        } else {
          overview = null
          mode = 'down'
        }
      } catch {
        overview = null
        mode = 'down'
      }
    }
    render()
  }

  render()
  poll()
  setInterval(poll, POLL_MS)
  setInterval(mount, 3000)

  window.__museLinkPill = { refresh: poll }
})()
// ==== muse-agent-link status pill (END) ====

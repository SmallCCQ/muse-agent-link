#!/usr/bin/env node
// Local CLI admin helper for Muse Hub v2 (talks strictly to 127.0.0.1:47617/admin/*)
const BASE = process.env.MUSE_HUB_ADMIN_URL || 'http://127.0.0.1:47617'

async function api(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    console.error(`HTTP ${res.status}:`, JSON.stringify(data, null, 2))
    process.exit(1)
  }
  return data
}

function parseFlags(argv) {
  const pos = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags[k] = next
        i++
      } else {
        flags[k] = true
      }
    } else {
      pos.push(a)
    }
  }
  return { pos, flags }
}

async function main() {
  const { pos, flags } = parseFlags(process.argv.slice(2))
  const cmd = pos[0] || 'status'

  if (cmd === 'status' || cmd === 'overview') {
    const d = await api('GET', '/admin/overview')
    console.log(JSON.stringify(d, null, 2))
    return
  }

  if (cmd === 'accounts') {
    const d = await api('GET', '/admin/accounts')
    console.log(JSON.stringify(d, null, 2))
    return
  }

  if (cmd === 'ticket' || cmd === 'pair-code') {
    const body = {
      label: flags.label || pos[1] || undefined,
      role: flags.role === 'collaborator' ? 'collaborator' : 'owner',
      ...(flags.agents ? { allowedAgents: String(flags.agents).split(',') } : {}),
      ...(flags.workspace ? { workspaceRoots: String(flags.workspace).split(';') } : {}),
      ...(flags.preset ? { forcedPreset: String(flags.preset) } : {}),
      ...(flags.ttl ? { ttlSec: Number(flags.ttl) } : {}),
    }
    const d = await api('POST', '/admin/pairing-tickets', body)
    console.log(JSON.stringify(d, null, 2))
    return
  }

  if (cmd === 'revoke') {
    const id = pos[1]
    if (!id) {
      console.error('Usage: node muse-admin.mjs revoke <accountId>')
      process.exit(2)
    }
    const d = await api('POST', `/admin/accounts/${encodeURIComponent(id)}/revoke`, {})
    console.log(JSON.stringify(d, null, 2))
    return
  }

  if (cmd === 'local-sessions') {
    const d = await api('GET', '/admin/local-sessions')
    console.log(JSON.stringify(d, null, 2))
    return
  }

  if (cmd === 'attach') {
    const [_, accountId, agent, localSessionId] = pos
    if (!accountId || !agent || !localSessionId) {
      console.error('Usage: node muse-admin.mjs attach <accountId> <dsh|antigravity> <localSessionId> [--title "..."]')
      process.exit(2)
    }
    const d = await api('POST', '/admin/attach', {
      accountId,
      agent,
      localSessionId,
      ...(flags.title ? { title: flags.title } : {}),
    })
    console.log(JSON.stringify(d, null, 2))
    return
  }

  if (cmd === 'wake') {
    const accountId = pos[1]
    if (!accountId) {
      console.error('Usage: node muse-admin.mjs wake <accountId> --mode wechat|muse_mail|both|none [--email x@muse.ai] [--disable] [--min-idle 30] [--cooldown 60]')
      process.exit(2)
    }
    const mode = flags.mode || 'wechat'
    const enabled = flags.disable ? false : mode !== 'none'
    const d = await api('PATCH', `/admin/accounts/${encodeURIComponent(accountId)}`, {
      wake: {
        enabled,
        mode,
        ...(flags.email ? { email: String(flags.email) } : {}),
        ...(flags['min-idle'] ? { minIdleSec: Number(flags['min-idle']) } : {}),
        ...(flags.cooldown ? { cooldownSec: Number(flags.cooldown) } : {}),
      },
    })
    console.log(JSON.stringify(d, null, 2))
    return
  }

  if (cmd === 'wake-test') {
    const accountId = pos[1]
    if (!accountId) {
      console.error('Usage: node muse-admin.mjs wake-test <accountId>')
      process.exit(2)
    }
    const d = await api('POST', '/admin/wake/test', { accountId })
    console.log(JSON.stringify(d, null, 2))
    return
  }

  if (cmd === 'smtp-set') {
    if (!flags.host || !flags.user || !flags.pass) {
      console.error('Usage: node muse-admin.mjs smtp-set --host smtp.example.com --port 465 --user u@ex.com --pass secret [--from ...] [--starttls]')
      process.exit(2)
    }
    const d = await api('POST', '/admin/wake/config', {
      smtp: {
        host: String(flags.host),
        port: Number(flags.port || (flags.starttls ? 587 : 465)),
        secure: !flags.starttls,
        user: String(flags.user),
        pass: String(flags.pass),
        ...(flags.from ? { from: String(flags.from) } : {}),
      },
    })
    console.log(JSON.stringify(d, null, 2))
    return
  }

  console.log(`Muse Hub v2 Admin CLI (${BASE})
Commands:
  status                                                     Show Hub overview, accounts, tickets & bindings
  accounts                                                   List paired Muse accounts & pending tickets
  ticket [--label "Victor·二号"] [--role owner|collaborator] [--workspace "D:\\sandbox"] [--agents dsh,antigravity]
  revoke <accountId>                                         Revoke a Muse account token
  local-sessions                                             List recent local DSH & Antigravity sessions
  attach <accountId> <dsh|antigravity> <localSessionId>      Bind an existing local session to an owner Muse account
  wake <accountId> --mode wechat|muse_mail|both|none [--email x@muse.ai] [--disable]
  wake-test <accountId>                                      Fire a test wake notification immediately
  smtp-set --host <h> --port <p> --user <u> --pass <pw>      Save SMTP credentials for Muse Mail wake`)
}

main().catch((err) => {
  console.error(err?.message || err)
  process.exit(1)
})

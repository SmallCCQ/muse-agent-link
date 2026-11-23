// Muse Hub v2 — Real Idle Wake Engine (WeChat push_weixin.mjs + Built-in Zero-Dep TLS SMTP Muse Mail + Webhook)
// Fires a minimal, secret-free wake notification ONLY when an account is idle (> minIdleSec)
// and receives a wake-worthy event (turn.finished / approval.requested / approval.hint_local_ui / question.asked).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { DSH_HOME, STATE_DIR, readJsonSafe, writeFileAtomicSync } from './store.mjs'

export const WAKE_CONFIG_PATH = path.join(STATE_DIR, 'wake-config.json')

const WAKE_EVENT_TYPES = new Set([
  'turn.finished',
  'approval.requested',
  'approval.hint_local_ui',
  'question.asked',
])

function defaultWechatScript() {
  const candidates = [
    path.join(DSH_HOME, 'skills', 'weixin-push', 'scripts', 'push_weixin.mjs'),
    path.join(
      os.homedir(),
      '.gemini',
      'config',
      'plugins',
      'skillpack-office-workflow',
      'skills',
      'weixin-push',
      'scripts',
      'push_weixin.mjs'
    ),
  ]
  return candidates.find((c) => fs.existsSync(c)) || candidates[0]
}

// ---------- Zero-dependency SMTP client (SMTPS :465 & STARTTLS :587) ----------

function smtpSendRaw({ host, port = 465, secure = true, user, pass, from, to, subject, text, timeoutMs = 15_000 }) {
  return new Promise((resolve, reject) => {
    let sock = null
    let settled = false
    let buf = ''
    let lineWaiter = null

    const done = (err, res) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock?.destroy() } catch {}
      if (err) reject(err)
      else resolve(res)
    }

    const timer = setTimeout(() => done(new Error('SMTP timeout')), timeoutMs)

    function attachListeners(s) {
      s.setEncoding('utf8')
      s.on('error', (e) => done(e))
      s.on('close', () => {
        if (!settled) done(new Error('SMTP closed unexpectedly'))
      })
      s.on('data', (chunk) => {
        buf += chunk
        while (lineWaiter) {
          const lines = buf.split('\r\n')
          // Check for final response line ("XYZ ..." not "XYZ-...")
          let endIdx = -1
          for (let i = 0; i < lines.length - 1; i++) {
            if (/^\d{3} /.test(lines[i])) {
              endIdx = i
              break
            }
          }
          if (endIdx < 0) break
          const respLines = lines.slice(0, endIdx + 1)
          buf = lines.slice(endIdx + 1).join('\r\n')
          const w = lineWaiter
          lineWaiter = null
          w(respLines.join('\n'))
        }
      })
    }

    function readResp() {
      return new Promise((res) => {
        const lines = buf.split('\r\n')
        let endIdx = -1
        for (let i = 0; i < lines.length - 1; i++) {
          if (/^\d{3} /.test(lines[i])) {
            endIdx = i
            break
          }
        }
        if (endIdx >= 0) {
          const respLines = lines.slice(0, endIdx + 1)
          buf = lines.slice(endIdx + 1).join('\r\n')
          res(respLines.join('\n'))
          return
        }
        lineWaiter = res
      })
    }

    async function cmd(line, expectPrefix) {
      if (line !== null) sock.write(line + '\r\n')
      const resp = await readResp()
      const code = Number(resp.slice(0, 3))
      const ok = Array.isArray(expectPrefix)
        ? expectPrefix.includes(code)
        : Math.floor(code / 100) === expectPrefix
      if (!ok) throw new Error(`SMTP rejected (${line ? line.split(' ')[0] : 'GREET'}): ${resp.slice(0, 200)}`)
      return resp
    }

    async function runSession() {
      const ehloHost = os.hostname().replace(/[^a-zA-Z0-9.-]/g, '') || 'localhost'
      await cmd(null, 2) // server banner 220
      const ehlo = await cmd(`EHLO ${ehloHost}`, 2)
      if (!secure && /STARTTLS/i.test(ehlo)) {
        await cmd('STARTTLS', 2)
        const plain = sock
        plain.removeAllListeners('data')
        plain.removeAllListeners('close')
        plain.removeAllListeners('error')
        sock = tls.connect({ socket: plain, servername: host })
        attachListeners(sock)
        await new Promise((r) => sock.once('secureConnect', r))
        await cmd(`EHLO ${ehloHost}`, 2)
      }
      if (user && pass) {
        await cmd('AUTH LOGIN', [334])
        await cmd(Buffer.from(String(user), 'utf8').toString('base64'), [334])
        await cmd(Buffer.from(String(pass), 'utf8').toString('base64'), [235])
      }
      const sender = from || user
      await cmd(`MAIL FROM:<${sender}>`, 2)
      await cmd(`RCPT TO:<${to}>`, 2)
      await cmd('DATA', [354])
      const encodedSubj = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`
      const safeBody = String(text || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')
      const msg = [
        `From: <${sender}>`,
        `To: <${to}>`,
        `Subject: ${encodedSubj}`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        safeBody,
        '.',
      ].join('\r\n')
      await cmd(msg, 2)
      await cmd('QUIT', 2).catch(() => {})
      done(null, { ok: true })
    }

    if (secure) {
      sock = tls.connect({ host, port: Number(port), servername: host })
      attachListeners(sock)
      sock.once('secureConnect', () => { runSession().catch((e) => done(e)) })
    } else {
      sock = net.connect({ host, port: Number(port) })
      attachListeners(sock)
      sock.once('connect', () => { runSession().catch((e) => done(e)) })
    }
  })
}

export class WakeEngine {
  constructor({ log = console.log } = {}) {
    this.log = log
    this.lastWakeByAccount = new Map() // accountId -> ms
  }

  getConfig() {
    const cfg = readJsonSafe(WAKE_CONFIG_PATH, {}) || {}
    return {
      wechatScript: cfg.wechatScript || defaultWechatScript(),
      webhookUrl: cfg.webhookUrl || process.env.MUSE_WAKE_MAIL_WEBHOOK || '',
      webhookSecret: cfg.webhookSecret || process.env.MUSE_WAKE_MAIL_SECRET || '',
      smtp: cfg.smtp || null,
    }
  }

  getPublicConfig() {
    const cfg = this.getConfig()
    return {
      wechatScript: cfg.wechatScript,
      wechatAvailable: fs.existsSync(cfg.wechatScript),
      webhookConfigured: Boolean(cfg.webhookUrl),
      smtpConfigured: Boolean(cfg.smtp?.host && cfg.smtp?.user),
      smtpHost: cfg.smtp?.host || null,
      smtpPort: cfg.smtp?.port || null,
      smtpUser: cfg.smtp?.user || null,
      smtpFrom: cfg.smtp?.from || cfg.smtp?.user || null,
    }
  }

  saveConfig(patch = {}) {
    const existing = readJsonSafe(WAKE_CONFIG_PATH, {}) || {}
    const next = { ...existing }
    if (typeof patch.wechatScript === 'string') next.wechatScript = patch.wechatScript.trim()
    if (typeof patch.webhookUrl === 'string') next.webhookUrl = patch.webhookUrl.trim()
    if (typeof patch.webhookSecret === 'string') next.webhookSecret = patch.webhookSecret.trim()
    if (patch.smtp === null) {
      delete next.smtp
    } else if (patch.smtp && typeof patch.smtp === 'object') {
      next.smtp = {
        ...(existing.smtp || {}),
        ...(patch.smtp.host ? { host: String(patch.smtp.host).trim() } : {}),
        ...(patch.smtp.port ? { port: Number(patch.smtp.port) } : {}),
        ...(typeof patch.smtp.secure === 'boolean' ? { secure: patch.smtp.secure } : {}),
        ...(patch.smtp.user ? { user: String(patch.smtp.user).trim() } : {}),
        ...(patch.smtp.pass ? { pass: String(patch.smtp.pass) } : {}),
        ...(patch.smtp.from ? { from: String(patch.smtp.from).trim() } : {}),
      }
    }
    writeFileAtomicSync(WAKE_CONFIG_PATH, JSON.stringify(next, null, 2))
    return this.getPublicConfig()
  }

  maybeWake(ev, account) {
    if (!ev || !account || !account.wake?.enabled) return
    if (!WAKE_EVENT_TYPES.has(ev.type)) return
    const mode = account.wake.mode || 'none'
    if (mode === 'none') return

    const now = Date.now()
    const minIdleMs = Math.max(Number(account.wake.minIdleSec) || 30, 10) * 1000
    const lastPollMs = account.lastPollAt ? new Date(account.lastPollAt).getTime() : 0
    if (lastPollMs > 0 && now - lastPollMs <= minIdleMs) {
      return
    }

    const cooldownMs = Math.max(Number(account.wake.cooldownSec) || 60, 15) * 1000
    const lastWake = this.lastWakeByAccount.get(account.id) || 0
    if (now - lastWake < cooldownMs) return
    this.lastWakeByAccount.set(account.id, now)

    void this.dispatchWake(account, ev)
  }

  async dispatchWake(account, ev) {
    const mode = account.wake?.mode || 'none'
    const summary = `[Muse Hub · ${os.hostname()}] 账号「${account.label}」收到 ${ev.type} (agent=${ev.agent || '-'}, thread=${ev.threadId || '-'}, seq=${ev.seq ?? '-'})。请在 Muse 运行 poll 拉取完整详情。`
    const results = {}

    if (mode === 'wechat' || mode === 'both') {
      results.wechat = await this._sendWechatAlert(summary)
    }
    if (mode === 'muse_mail' || mode === 'both') {
      results.muse_mail = await this._sendMuseMail(account, ev, summary)
    }
    return results
  }

  async _sendMuseMail(account, ev, summary) {
    const to = account.wake?.email
    if (!to) return { ok: false, error: 'account.wake.email is not set' }
    const cfg = this.getConfig()

    // Priority 1: Direct built-in TLS SMTP
    if (cfg.smtp?.host && cfg.smtp?.user && cfg.smtp?.pass) {
      try {
        await smtpSendRaw({
          host: cfg.smtp.host,
          port: Number(cfg.smtp.port || 465),
          secure: cfg.smtp.secure !== false,
          user: cfg.smtp.user,
          pass: cfg.smtp.pass,
          from: cfg.smtp.from || cfg.smtp.user,
          to,
          subject: `[Muse Wake] ${os.hostname()} ${ev.type}`,
          text: summary,
        })
        this.log(`[wake] SMTP muse_mail sent to ${to} for ${account.id} (${ev.type})`)
        return { ok: true, transport: 'smtp' }
      } catch (err) {
        this.log(`[wake] SMTP muse_mail failed for ${account.id}: ${err?.message || err}`)
        return { ok: false, transport: 'smtp', error: String(err?.message || err) }
      }
    }

    // Priority 2: Webhook fallback if configured
    if (cfg.webhookUrl) {
      try {
        const res = await fetch(cfg.webhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.webhookSecret ? { authorization: `Bearer ${cfg.webhookSecret}` } : {}),
          },
          body: JSON.stringify({
            to,
            subject: `[Muse Wake] ${os.hostname()} ${ev.type}`,
            text: summary,
          }),
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) {
          this.log(`[wake] webhook HTTP ${res.status} for ${account.id}`)
          return { ok: false, transport: 'webhook', error: `HTTP ${res.status}` }
        }
        this.log(`[wake] webhook muse_mail sent for ${account.id}`)
        return { ok: true, transport: 'webhook' }
      } catch (err) {
        this.log(`[wake] webhook failed for ${account.id}: ${err?.message || err}`)
        return { ok: false, transport: 'webhook', error: String(err?.message || err) }
      }
    }

    this.log(`[wake] muse_mail skipped for ${account.id}: neither SMTP nor webhook configured`)
    return { ok: false, error: 'neither SMTP nor webhook configured' }
  }

  _sendWechatAlert(summary) {
    return new Promise((resolve) => {
      const cfg = this.getConfig()
      const script = cfg.wechatScript
      if (!script || !fs.existsSync(script)) {
        this.log(`[wake] wechat script not found at ${script}`)
        resolve({ ok: false, error: `script not found: ${script}` })
        return
      }
      const child = spawn(process.execPath, [script, 'text', summary], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        try { child.kill() } catch {}
        resolve({ ok: false, error: 'wechat push timed out' })
      }, 15_000)
      child.stdout.on('data', (d) => (out += d.toString()))
      child.stderr.on('data', (d) => (err += d.toString()))
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve({ ok: false, error: String(e?.message || e) })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          this.log(`[wake] wechat alert sent via push_weixin.mjs`)
          resolve({ ok: true, output: out.trim().slice(0, 200) })
        } else {
          this.log(`[wake] wechat alert failed (exit ${code}): ${(err || out).slice(0, 200)}`)
          resolve({ ok: false, error: (err || out || `exit ${code}`).trim().slice(0, 200) })
        }
      })
    })
  }
}

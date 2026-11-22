#!/usr/bin/env node
/**
 * append-pill.cjs — install/refresh the muse-agent-link status pill inside
 * antigravity-suite-client.js (the shared client script the Antigravity
 * suite bootstrap evals in the app window on every launch).
 *
 * Safety by construction:
 *  - any previous muse pill block (between the BEGIN/END markers) is
 *    stripped first, so re-runs are idempotent updates;
 *  - the combined file must pass `node --check` BEFORE anything is
 *    written — a syntax failure aborts and leaves the original intact;
 *  - the original file is backed up next to itself as
 *    antigravity-suite-client.js.bak-muse-<timestamp> before replacing.
 *
 * Usage: node append-pill.cjs [path-to-antigravity-suite-client.js]
 * Default target: ~/.gemini/config/plugins/antigravity-suite-client.js
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const BEGIN = '// ==== muse-agent-link status pill (BEGIN) ===='
const END = '// ==== muse-agent-link status pill (END) ===='

const clientPath =
  process.argv[2] ||
  path.join(os.homedir(), '.gemini', 'config', 'plugins', 'antigravity-suite-client.js')
const pillPath = path.join(__dirname, 'pill.js')

function fail(msg) {
  console.error('[muse-pill] ERROR: ' + msg)
  process.exit(1)
}

if (!fs.existsSync(clientPath)) fail('client file not found: ' + clientPath)
if (!fs.existsSync(pillPath)) fail('pill.js not found next to this script')

const pill = fs.readFileSync(pillPath, 'utf8')
if (!pill.includes(BEGIN) || !pill.includes(END)) fail('pill.js is missing its markers')

let combined = fs.readFileSync(clientPath, 'utf8')
const b = combined.indexOf(BEGIN)
const e = combined.indexOf(END)
if (b !== -1 && e !== -1 && e > b) {
  combined = combined.slice(0, b) + combined.slice(e + END.length)
  console.log('[muse-pill] previous pill block removed (will be replaced)')
} else if (b !== -1 || e !== -1) {
  fail('found a partial pill block; refusing to guess — fix the file manually')
}
combined = combined.replace(/\s+$/, '') + '\n\n' + pill.replace(/\s+$/, '') + '\n'

const tmpPath = clientPath + '.muse-check.cjs'
fs.writeFileSync(tmpPath, combined, 'utf8')
const check = spawnSync(process.execPath, ['--check', tmpPath], { encoding: 'utf8' })
if (check.status !== 0) {
  fs.unlinkSync(tmpPath)
  fail('combined file failed node --check; original left untouched.\n' + (check.stderr || ''))
}

const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const bakPath = clientPath + '.bak-muse-' + ts
fs.copyFileSync(clientPath, bakPath)
fs.copyFileSync(tmpPath, clientPath)
fs.unlinkSync(tmpPath)
console.log('[muse-pill] backup: ' + bakPath)
console.log('[muse-pill] pill installed into ' + clientPath + ' (' + combined.length + ' chars total)')
console.log('[muse-pill] restart the Antigravity app (or open a new window) to see the pill.')

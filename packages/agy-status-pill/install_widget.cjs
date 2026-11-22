#!/usr/bin/env node
// Installs/refreshes the Muse link status pill by appending pill.js to
// antigravity-suite-client.js (see append-pill.cjs for the safety rules).
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const targetScript = path.join(__dirname, 'append-pill.cjs');
const res = spawnSync(process.execPath, [targetScript], { stdio: 'inherit', windowsHide: true });
process.exit(res.status ?? 0);

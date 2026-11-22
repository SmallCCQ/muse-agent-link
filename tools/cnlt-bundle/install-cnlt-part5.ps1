# install-cnlt-part5.ps1 - update the plugin to v0.6.0 (fixed-port mirror).
# v0.6.0 adds a mirror listener on the machine's Tailscale address at the
# FIXED port 47616 that forwards into the DSH host's own web server, so
# Victor no longer needs the desktop host's dynamic port after restarts.
# This script only replaces the two plugin files (with a backup); the
# junction in the desktop profile already points at this folder.
# Run as victor.cai, normal PowerShell. ASCII-only (PS 5.1 encoding trap).

$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'plugin'
$dest = Join-Path $env:USERPROFILE '.dsh\plugins\muse-agent-link'
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'

foreach ($f in 'index.js','package.json') {
    $from = Join-Path $src $f
    $to = Join-Path $dest $f
    if (-not (Test-Path $from)) { throw "missing source file: $from" }
    if (Test-Path $to) { Copy-Item $to "$to.bak-muse-$ts" -Force }
    Copy-Item $from $to -Force
    Write-Host "updated: $to"
}

Write-Host ''
Write-Host 'Plugin v0.6.0 in place. Now RESTART the DSH desktop app (quit fully, then open it again),'
Write-Host 'wait ~30 seconds, and tell Victor. He will verify the fixed port 47616 from his side.'

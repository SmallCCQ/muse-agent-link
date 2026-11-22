# install-cnlt-part2.ps1 - Muse Agent Link for CNLT, part 2 (daemon + pairing)
# Part 1 already deployed the plugin files and wired the desktop profile.
# The desktop profile is managed by the DSH Electron app, so the plugin
# itself is installed/loaded by the app - start (or restart) DSH after
# running this script if the plugin does not show up.
# Run as victor.cai in a normal PowerShell, from the extracted bundle folder.
# ASCII-only on purpose (PS 5.1 encoding trap).

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$stateDir = Join-Path $dshHome 'muse-agent-link'

Write-Host '== 1/2 deploy daemon + logon task =='
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
Copy-Item (Join-Path $src 'daemon.mjs') (Join-Path $stateDir 'daemon.mjs') -Force
$daemonPath = Join-Path $stateDir 'daemon.mjs'
$logPath = Join-Path $stateDir 'daemon-stdout.log'
$cmdPath = Join-Path $stateDir 'run-daemon.cmd'
$cmdText = "@echo off`r`nnode `"$daemonPath`" >> `"$logPath`" 2>&1`r`n"
[System.IO.File]::WriteAllText($cmdPath, $cmdText, (New-Object System.Text.ASCIIEncoding))
schtasks /Create /TN MuseAgentLinkDaemon /TR "`"$cmdPath`"" /SC ONLOGON /IT /F | Out-Null
schtasks /Run /TN MuseAgentLinkDaemon | Out-Null
Start-Sleep 4
$listen = Get-NetTCPConnection -State Listen -LocalPort 47615 -ErrorAction SilentlyContinue
if ($listen) { Write-Host '   daemon is listening on 127.0.0.1:47615' } else { Write-Host '   WARNING: daemon not listening yet - check daemon-stdout.log in the state dir' }

Write-Host '== 2/2 pairing code =='
Write-Host 'Make sure the DSH desktop app is running (start or restart it now).'
Write-Host 'Waiting up to 3 minutes for the plugin to publish a pairing code...'
$statePath = Join-Path $stateDir 'state.json'
$code = $null
$paired = $false
for ($i = 0; $i -lt 60; $i++) {
    if (Test-Path $statePath) {
        try {
            $st = Get-Content $statePath -Raw | ConvertFrom-Json
            if ($st.pairingCode) { $code = $st.pairingCode; break }
            if ($st.paired) { $paired = $true; break }
        } catch {}
    }
    Start-Sleep 3
}
if ($code) {
    Write-Host ''
    Write-Host "   PAIRING CODE: $code"
    Write-Host '   Send this code to Victor in chat - he pairs from his side.'
} elseif ($paired) {
    Write-Host '   Already paired.'
} else {
    Write-Host '   No code yet - the plugin may not have loaded in the DSH app.'
    Write-Host '   Check the DSH sidebar for a Muse status card; if absent, tell Victor.'
    Write-Host "   You can re-check any time with: Get-Content `"$statePath`""
}
Write-Host '== part 2 done =='

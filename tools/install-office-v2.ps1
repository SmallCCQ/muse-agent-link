# install-office-v2.ps1 - Upgrade office-workstation (DESKTOP-PRNM1F1, DSH web profile + AGY Desktop) to Muse Hub v2
# ASCII-only on purpose (Windows PowerShell 5.1 encoding safety).
# Dual-mode: works both from the GitHub repo (tools/install-office-v2.ps1) and from office-workstation-v2-bundle.zip.
param(
    [switch]$RestartDshWeb
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$repoRoot = Split-Path -Parent $scriptDir

if (Test-Path (Join-Path $scriptDir 'hub\muse-hub.mjs')) {
    $hubSrc = Join-Path $scriptDir 'hub'
    $dshSrc = Join-Path $scriptDir 'dsh-plugin'
    $agySrc = Join-Path $scriptDir 'antigravity-plugin'
    $cliSrc = Join-Path $scriptDir 'muse-client'
} elseif (Test-Path (Join-Path $repoRoot 'packages\daemon\muse-hub.mjs')) {
    $hubSrc = Join-Path $repoRoot 'packages\daemon'
    $dshSrc = Join-Path $repoRoot 'packages\dsh-plugin'
    $agySrc = Join-Path $repoRoot 'packages\agy-status-pill'
    $cliSrc = Join-Path $repoRoot 'tools'
} else {
    throw "Cannot locate Muse Hub v2 source folders from $scriptDir"
}

$dshHome = Join-Path $env:USERPROFILE '.dsh'
$stateDir = Join-Path $dshHome 'muse-agent-link'
$pluginDir = Join-Path $dshHome 'plugins\muse-agent-link'
$agyPlugDir = Join-Path $env:USERPROFILE '.gemini\config\plugins\antigravity-muse-link'

Write-Host '== 1/6 Backup existing Muse Link files =='
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$bakRoot = Join-Path $dshHome "muse-agent-link-backup-$ts"
New-Item -ItemType Directory -Path (Join-Path $bakRoot 'state'), (Join-Path $bakRoot 'plugin'), (Join-Path $bakRoot 'agy-plugin') -Force | Out-Null
if (Test-Path $stateDir) { Copy-Item (Join-Path $stateDir '*') (Join-Path $bakRoot 'state') -Recurse -Force -ErrorAction SilentlyContinue }
if (Test-Path $pluginDir) { Copy-Item (Join-Path $pluginDir '*') (Join-Path $bakRoot 'plugin') -Recurse -Force -ErrorAction SilentlyContinue }
if (Test-Path $agyPlugDir) { Copy-Item (Join-Path $agyPlugDir '*') (Join-Path $bakRoot 'agy-plugin') -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host "   backup: $bakRoot"

Write-Host '== 2/6 Deploy Muse Hub v2 modules =='
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
foreach ($f in @('store.mjs', 'wake.mjs', 'antigravity-adapter.mjs', 'muse-hub.mjs', 'muse-admin.mjs', 'run-hub-hidden.vbs')) {
    Copy-Item (Join-Path $hubSrc $f) (Join-Path $stateDir $f) -Force
}
Copy-Item (Join-Path $cliSrc 'muse_link_client.py') (Join-Path $stateDir 'muse_link_client.py') -Force
Copy-Item (Join-Path $cliSrc 'MUSE_LINK_SKILL.md') (Join-Path $stateDir 'MUSE_LINK_SKILL.md') -Force
node --check (Join-Path $stateDir 'muse-hub.mjs')
Write-Host '   hub modules syntax OK'

Write-Host '== 3/6 Deploy thin DSH v2 adapter plugin =='
New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
foreach ($f in @('index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'icon.svg')) {
    Copy-Item (Join-Path $dshSrc $f) (Join-Path $pluginDir $f) -Force
}
node --check (Join-Path $pluginDir 'index.js')
Write-Host '   DSH plugin v2.0.0 deployed'

Write-Host '== 4/6 Deploy Antigravity native hooks + v2.0 sidebar pill =='
New-Item -ItemType Directory -Path (Join-Path $agyPlugDir 'hooks'), (Join-Path $agyPlugDir 'assets'), (Join-Path $agyPlugDir '.antigravity-plugin') -Force | Out-Null
Copy-Item (Join-Path $agySrc 'hooks.json') (Join-Path $agyPlugDir 'hooks.json') -Force
Copy-Item (Join-Path $agySrc 'hooks\muse-hook.cjs') (Join-Path $agyPlugDir 'hooks\muse-hook.cjs') -Force
Copy-Item (Join-Path $agySrc 'pill.js') (Join-Path $agyPlugDir 'pill.js') -Force
Copy-Item (Join-Path $agySrc 'plugin.json') (Join-Path $agyPlugDir 'plugin.json') -Force
Copy-Item (Join-Path $agySrc 'plugin.json') (Join-Path $agyPlugDir '.antigravity-plugin\plugin.json') -Force
foreach ($opt in @('append-pill.cjs', 'install_widget.cjs', 'README.md')) {
    $srcOpt = Join-Path $agySrc $opt
    if (Test-Path $srcOpt) { Copy-Item $srcOpt (Join-Path $agyPlugDir $opt) -Force }
}
$logoOpt = Join-Path $agySrc 'assets\logo.svg'
if (Test-Path $logoOpt) { Copy-Item $logoOpt (Join-Path $agyPlugDir 'assets\logo.svg') -Force }
$appendScript = Join-Path $agyPlugDir 'append-pill.cjs'
$suiteClient = Join-Path $env:USERPROFILE '.gemini\config\plugins\antigravity-suite-client.js'
if ((Test-Path $appendScript) -and (Test-Path $suiteClient)) {
    node $appendScript $suiteClient
} else {
    Write-Host '   antigravity-suite-client.js not present; hooks deployed cleanly'
}

Write-Host '== 5/6 Configure silent interactive autostart & launch Muse Hub v2 =='
$hubPath = Join-Path $stateDir 'muse-hub.mjs'
$logPath = Join-Path $stateDir 'hub-stdout.log'
$cmdPath = Join-Path $stateDir 'run-daemon.cmd'
$vbsPath = Join-Path $stateDir 'run-hub-hidden.vbs'
$cmdText = "@echo off`r`nnode `"$hubPath`" >> `"$logPath`" 2>&1`r`n"
[System.IO.File]::WriteAllText($cmdPath, $cmdText, (New-Object System.Text.ASCIIEncoding))

Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'MuseAgentLinkDaemon' -Value "wscript.exe `"$vbsPath`""

# Gracefully ask existing v2 Hub to stop if present, then clean up legacy daemon.mjs
try { Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:47617/admin/shutdown' -TimeoutSec 2 | Out-Null } catch {}
Start-Sleep -Milliseconds 500
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'muse-agent-link\\(daemon|muse-hub)\.mjs' } |
    ForEach-Object {
        Write-Host "   stopping old PID=$($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
Start-Sleep -Milliseconds 800

$schOk = $false
try {
    & schtasks.exe /Create /TN MuseAgentLinkDaemon /TR "wscript.exe `"$vbsPath`"" /SC ONLOGON /IT /F 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        & schtasks.exe /Run /TN MuseAgentLinkDaemon 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $schOk = $true }
    }
} catch {}
if (-not $schOk) {
    Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbsPath`"" -WindowStyle Hidden
}
Start-Sleep -Seconds 3

Write-Host '== 6/6 Verify Muse Hub v2 =='
node (Join-Path $stateDir 'muse-admin.mjs') status

if ($RestartDshWeb) {
    Write-Host '== Restarting DSH web host via interactive scheduled task =='
    $c = Get-NetTCPConnection -State Listen -LocalPort 3080 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) {
        Write-Host "   stopping DSH web tree PID=$($c.OwningProcess)"
        & taskkill.exe /PID $c.OwningProcess /T /F 2>&1 | Out-Null
    }
    Start-Sleep -Seconds 3
    $launchScript = Join-Path $env:TEMP 'muse-probe\launch-dsh-web.ps1'
    $dshCmd = Join-Path $env:APPDATA 'npm\dsh.cmd'
    $trCmd = if (Test-Path $launchScript) {
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$launchScript`""
    } elseif (Test-Path $dshCmd) {
        "`"$dshCmd`" web"
    } else { $null }
    if ($trCmd) {
        & schtasks.exe /Create /TN MuseRestartDshWeb /TR $trCmd /SC ONCE /ST 23:59 /IT /F 2>&1 | Out-Null
        & schtasks.exe /Run /TN MuseRestartDshWeb 2>&1 | Out-Null
        Start-Sleep -Seconds 10
        & schtasks.exe /Delete /TN MuseRestartDshWeb /F 2>&1 | Out-Null
    }
    node (Join-Path $stateDir 'muse-admin.mjs') status
} else {
    Write-Host ''
    Write-Host 'Next step: restart DSH web host (or re-run with -RestartDshWeb) so DSH plugin v2.0.0 loads and registers with Muse Hub.'
}
Write-Host '== Office Workstation v2 upgrade complete =='

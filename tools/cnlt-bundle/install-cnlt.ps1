# install-cnlt.ps1 - Muse Agent Link installer for CNLT-PF23D7Z3
# Run as victor.cai in a normal PowerShell (no admin needed - everything
# lands in the user profile). ASCII-only on purpose (PS 5.1 encoding trap).
# Steps: deploy DSH plugin -> wire the "desktop" profile -> dsh plugin
# install -> deploy Antigravity daemon -> logon task -> start daemon ->
# print the pairing code once the DSH host is up.

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$pluginDir = Join-Path $dshHome 'plugins\muse-agent-link'
$stateDir = Join-Path $dshHome 'muse-agent-link'
$profileName = 'desktop'

Write-Host '== 1/5 deploy plugin files =='
New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
Copy-Item (Join-Path $src 'plugin\*') $pluginDir -Force
Get-ChildItem $pluginDir | ForEach-Object { Write-Host "   $($_.Name) $($_.Length)" }

Write-Host '== 2/5 wire the desktop profile =='
$profPkgPath = Join-Path $dshHome "profiles\$profileName\package.json"
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $profPkgPath "$profPkgPath.bak-muse-$stamp"
Write-Host "   backup: $profPkgPath.bak-muse-$stamp"
$pkg = Get-Content $profPkgPath -Raw | ConvertFrom-Json
if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([PSCustomObject]@{}) }
$linkVal = 'link:' + ($pluginDir -replace '\\', '/')
if ($pkg.dependencies.PSObject.Properties.Name -contains '@local/muse-agent-link') {
    $pkg.dependencies.'@local/muse-agent-link' = $linkVal
} else {
    $pkg.dependencies | Add-Member -NotePropertyName '@local/muse-agent-link' -NotePropertyValue $linkVal
}
if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([PSCustomObject]@{}) }
if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([PSCustomObject]@{}) }
if (-not $pkg.dsh.profile.bundles) { $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() }
if ($pkg.dsh.profile.bundles -notcontains '@local/muse-agent-link') {
    $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles) + '@local/muse-agent-link'
}
$pkg | ConvertTo-Json -Depth 10 | Set-Content $profPkgPath -Encoding UTF8
Select-String -Path $profPkgPath -Pattern 'muse-agent-link' | ForEach-Object { Write-Host "   $($_.Line.Trim())" }

Write-Host '== 3/5 dsh plugin install (this can take a minute) =='
& dsh plugin --profile $profileName install 2>&1 | Select-Object -Last 5 | ForEach-Object { Write-Host "   $_" }

Write-Host '== 4/5 deploy daemon + logon task =='
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

Write-Host '== 5/5 pairing code =='
Write-Host 'If DSH (desktop) is not running yet, start it now the way you normally do.'
$statePath = Join-Path $stateDir 'state.json'
$code = $null
for ($i = 0; $i -lt 30; $i++) {
    if (Test-Path $statePath) {
        try {
            $st = Get-Content $statePath -Raw | ConvertFrom-Json
            if ($st.pairingCode) { $code = $st.pairingCode; break }
            if ($st.paired) { Write-Host '   Already paired.'; break }
        } catch {}
    }
    Start-Sleep 3
}
if ($code) {
    Write-Host ''
    Write-Host "   PAIRING CODE: $code"
    Write-Host '   Send this code to Victor in chat - he pairs from his side.'
} elseif (-not $st.paired) {
    Write-Host '   No code yet. After DSH is running, run this and send Victor the pairingCode value:'
    Write-Host "   Get-Content `"$statePath`""
}
Write-Host '== installer done =='

# install-cnlt-part4.ps1 - make the desktop profile actually LOAD the plugin.
# Root cause: in the Desktop profile, plugin code lives in the profile's
# node_modules (see Cai's own dsh-profile-migration skill, section 6).
# Editing package.json alone is not enough - the Electron app never ran an
# install for it, and the CLI refuses ("managed exclusively"). For a link:
# dependency, pnpm would create a directory junction in node_modules -
# this script creates exactly that junction by hand.
# Run as victor.cai, normal PowerShell, with the DSH app CLOSED.
# ASCII-only (PS 5.1 encoding trap).

$ErrorActionPreference = 'Stop'
$target = Join-Path $env:USERPROFILE '.dsh\plugins\muse-agent-link'
$scopeDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\@local'
$link = Join-Path $scopeDir 'muse-agent-link'

if (-not (Test-Path $target)) { throw "plugin source missing: $target" }
New-Item -ItemType Directory -Path $scopeDir -Force | Out-Null

if (Test-Path $link) {
    $item = Get-Item $link -Force
    Write-Host "already exists: $link (LinkType=$($item.LinkType) Target=$($item.Target))"
} else {
    cmd /c mklink /J "`"$link`"" "`"$target`""
    if (-not (Test-Path $link)) { throw 'junction creation failed' }
    Write-Host "junction created: $link -> $target"
}

Write-Host ''
Write-Host 'Now start the DSH desktop app, wait ~40 seconds, then run these two checks and paste the results to Victor:'
Write-Host "   Get-Content `"$env:USERPROFILE\.dsh\muse-agent-link\state.json`""
Write-Host '   Get-NetTCPConnection -State Listen -LocalPort 3080 | Select-Object -Expand LocalAddress'
Write-Host 'If state.json still does not exist, also paste the tail of the newest host log:'
Write-Host '   $log = Get-ChildItem "$env:APPDATA\@deepseek-ai\dsh-desktop\logs" -Filter *host*.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1'
Write-Host '   Get-Content $log.FullName -Tail 60 | Select-String "muse|Failed|error"'

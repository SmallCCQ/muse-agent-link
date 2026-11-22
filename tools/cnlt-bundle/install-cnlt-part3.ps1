# install-cnlt-part3.ps1 - wire muse-agent-link into the desktop profile
# by SURGICAL TEXT EDIT only (no JSON round-trip, no BOM - that is what
# broke the file last time). ASCII-only. Run as victor.cai, normal shell.
# Prerequisite: DSH desktop app opens normally again on the restored
# package.json, and the app is CLOSED while this runs.

$ErrorActionPreference = 'Stop'
$path = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\package.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $path "$path.bak-muse-$stamp"
Write-Host "backup: $path.bak-muse-$stamp"

$text = [System.IO.File]::ReadAllText($path)
if ($text -match '@local/muse-agent-link') {
    Write-Host 'Already wired - nothing to do.'
    exit 0
}

$anchor1 = '"@local/dsh-flow-credits": "link:../../plugins/dsh-flow-credits",'
$insert1 = "`n    `"@local/muse-agent-link`": `"link:../../plugins/muse-agent-link`","
if (-not $text.Contains($anchor1)) { throw 'anchor1 (dependencies) not found - file shape changed, stop and tell Victor' }
$text = $text.Replace($anchor1, $anchor1 + $insert1)

$anchor2 = '"@local/dsh-fleet-bridge",'
$insert2 = "`n        `"@local/muse-agent-link`","
if (-not $text.Contains($anchor2)) { throw 'anchor2 (bundles) not found - file shape changed, stop and tell Victor' }
$text = $text.Replace($anchor2, $anchor2 + $insert2)

# Validate only - the parsed object is discarded, the TEXT is written.
$null = $text | ConvertFrom-Json
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($path, $text, $utf8NoBom)
Write-Host 'wired OK. Lines now in package.json:'
Select-String -Path $path -Pattern 'muse-agent-link' | ForEach-Object { Write-Host "   $($_.Line.Trim())" }
Write-Host ''
Write-Host 'Next: start the DSH desktop app, wait ~30s, then run:'
Write-Host "   Get-Content `"$env:USERPROFILE\.dsh\muse-agent-link\state.json`""
Write-Host 'Send Victor the pairingCode value from that file.'

# install-victor-key-cnlt.ps1
# Run on CNLT (cnlt-pf23d7z3) as victor.cai. Installs Victor's SSH public key
# in the one place Windows OpenSSH actually reads for this account.
# If victor.cai is a local Administrators member, run this from an ELEVATED
# PowerShell ("Run as administrator") - admins' keys only count in
# C:\ProgramData\ssh\administrators_authorized_keys; a key placed in the user
# profile is silently ignored for admin accounts.
# This file is intentionally ASCII-only: Windows PowerShell 5.1 misreads
# UTF-8-no-BOM scripts that contain non-ASCII text and produces bogus
# parser errors.

$ErrorActionPreference = 'Stop'

$pubKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJVmKUe0e5TzIi8vU87JV4f17gG7jM3zlYCUi3FYWkPE hatch'
# Key fingerprint for manual check: SHA256:F22A0Eoa/b9piP6jhpqiYtVe1S8dPqCGco7rcqKyGC8

# Admin MEMBERSHIP (not current elevation) decides the file location: an
# unelevated admin still has the Administrators group (SID S-1-5-32-544)
# in whoami /groups, and sshd only reads the ProgramData file for them.
$isAdminMember = [bool]((whoami /groups) -match 'S-1-5-32-544')
$isElevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($isAdminMember) {
    if (-not $isElevated) {
        throw 'victor.cai is an Administrators member, so the key must go to C:\ProgramData\ssh\administrators_authorized_keys. Right-click PowerShell -> Run as administrator, then run this script again.'
    }
    $target = 'C:\ProgramData\ssh\administrators_authorized_keys'
    $aclArgs = @($target, '/inheritance:r',
        '/grant:r', 'NT AUTHORITY\SYSTEM:(F)',
        '/grant:r', 'BUILTIN\Administrators:(F)')
    $dir = Split-Path $target -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
} else {
    $sshDir = Join-Path $env:USERPROFILE '.ssh'
    if (-not (Test-Path $sshDir)) { New-Item -ItemType Directory -Path $sshDir -Force | Out-Null }
    $target = Join-Path $sshDir 'authorized_keys'
    $aclArgs = @($target, '/inheritance:r',
        '/grant:r', ($env:USERDOMAIN + '\' + $env:USERNAME + ':(F)'))
}

# Write as UTF-8 without BOM; append only if the key is not already there
# (safe to run repeatedly).
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
if (Test-Path $target) {
    $existing = [System.IO.File]::ReadAllText($target, $utf8NoBom)
    if ($existing -match [regex]::Escape($pubKey)) {
        Write-Host "Key already present in $target - nothing to add."
    } else {
        $text = $existing.TrimEnd("`r", "`n") + "`r`n" + $pubKey + "`r`n"
        [System.IO.File]::WriteAllText($target, $text, $utf8NoBom)
        Write-Host "Key appended to $target"
    }
} else {
    [System.IO.File]::WriteAllText($target, $pubKey + "`r`n", $utf8NoBom)
    Write-Host "Created $target and wrote the key."
}

# OpenSSH ignores the file if its permissions are too open - lock them down.
& icacls @aclArgs | Out-Null
Write-Host 'Permissions fixed.'

Write-Host "---- $target ----"
Get-Content $target
Write-Host '---- self-check done ----'
Write-Host 'Next: tell Victor it is installed. No sshd restart needed; new connections read the file immediately.'

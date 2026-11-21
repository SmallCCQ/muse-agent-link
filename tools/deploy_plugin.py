#!/usr/bin/env python3
"""Deploy plugin files to office-workstation and restart its DSH web host.

Usage: deploy_plugin.py [file1 file2 ...]   (default: package.json index.js client.js)
Transfers via SSH base64 chunks (the SSH command line has a length limit),
then kills the :3080 host tree and relaunches `dsh web` in the interactive
session through schtasks /IT, and waits for the status route to answer.
"""
import base64
import os
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path.home() / "workspace/muse-agent-link/packages/dsh-plugin"
HOST = "100.91.205.57"
TMP = r"C:\Users\Smallsun\AppData\Local\Temp"
DEST = r"C:\Users\Smallsun\.dsh\plugins\muse-agent-link"


def psrun(script):
    b64 = base64.b64encode(script.encode("utf-16-le")).decode()
    r = subprocess.run(
        [
            "ssh",
            "-o", "ProxyCommand=python3 /tmp/tsconnect.py %h %p",
            "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ConnectTimeout=25",
            "-i", os.path.expanduser("~/.ssh/id_ed25519"),
            f"smallsun@{HOST}",
            f"powershell -NoProfile -EncodedCommand {b64}",
        ],
        capture_output=True,
    )
    return r.stdout.decode("utf-8", errors="replace")


def deploy(fname):
    data = base64.b64encode((ROOT / fname).read_bytes()).decode()
    chunks = [data[i : i + 1200] for i in range(0, len(data), 1200)]
    tmp = TMP + "\\" + fname + ".b64"
    psrun(f"Remove-Item '{tmp}' -ErrorAction SilentlyContinue; 'cleared'")
    for c in chunks:
        psrun(f"Add-Content -Path '{tmp}' -Value '{c}' -NoNewline -Encoding Ascii; 'ok'")
    out = psrun(
        f"$b=[IO.File]::ReadAllText('{tmp}'); "
        f"[IO.File]::WriteAllBytes('{DEST}\\{fname}', [Convert]::FromBase64String($b)); "
        f"(Get-Item '{DEST}\\{fname}').Length"
    )
    size = out.strip().splitlines()[-1] if out.strip() else "?"
    print(fname, "size:", size, "expected:", (ROOT / fname).stat().st_size)


def restart():
    script = r"""
$tmp = Join-Path $env:TEMP 'muse-probe'
$c = Get-NetTCPConnection -State Listen -LocalPort 3080 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($c) { taskkill /PID $c.OwningProcess /T /F 2>&1 | Out-Null }
Start-Sleep 3
Remove-Item (Join-Path $tmp 'dsh-web-restart.log') -ErrorAction SilentlyContinue
schtasks /Create /TN MuseDshRestart /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $(Join-Path $tmp 'launch-dsh-web.ps1')" /SC ONCE /ST 23:59 /IT /F 2>&1 | Out-Null
schtasks /Run /TN MuseDshRestart 2>&1 | Out-String
schtasks /Delete /TN MuseDshRestart /F 2>&1 | Out-Null
"""
    print(psrun(script).strip()[-120:])


def wait_status():
    sys.path.insert(0, str(pathlib.Path(__file__).parent))
    import link_client

    for i in range(12):
        time.sleep(10)
        try:
            status, data = link_client.request("GET", "/status")
            if status == 200:
                print("status:", data)
                return True
        except Exception as e:
            print("wait", i, type(e).__name__)
    return False


if __name__ == "__main__":
    files = sys.argv[1:] or ["package.json", "index.js", "client.js"]
    for f in files:
        deploy(f)
    restart()
    wait_status()

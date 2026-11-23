#!/usr/bin/env python3
"""Deploy Muse Hub v2 (Hub + DSH plugin v2 + AGY hooks & pill v2) to office-workstation via SSH.

Run inside Victor (Muse) VM after `git pull`:
    python3 tools/deploy_v2_office.py [--no-restart]

Packs repo files into a zip, transfers over Tailscale SSH to office-workstation
(smallsun@100.91.205.57), runs tools/install-office-v2.ps1 -RestartDshWeb, and
verifies http://100.91.205.57:47616/v2/status.
"""
import argparse
import base64
import io
import json
import os
import pathlib
import subprocess
import sys
import time
import zipfile

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
HOST = os.environ.get("MUSE_OFFICE_HOST", "100.91.205.57")
USER = os.environ.get("MUSE_OFFICE_USER", "smallsun")
REMOTE_DIR = r"C:\Users\Smallsun\AppData\Local\Temp\muse-v2-deploy"

BUNDLE_FILES = [
    ("packages/daemon/store.mjs", "hub/store.mjs"),
    ("packages/daemon/wake.mjs", "hub/wake.mjs"),
    ("packages/daemon/antigravity-adapter.mjs", "hub/antigravity-adapter.mjs"),
    ("packages/daemon/muse-hub.mjs", "hub/muse-hub.mjs"),
    ("packages/daemon/muse-admin.mjs", "hub/muse-admin.mjs"),
    ("packages/daemon/run-hub-hidden.vbs", "hub/run-hub-hidden.vbs"),
    ("packages/dsh-plugin/index.js", "dsh-plugin/index.js"),
    ("packages/dsh-plugin/client.js", "dsh-plugin/client.js"),
    ("packages/dsh-plugin/package.json", "dsh-plugin/package.json"),
    ("packages/dsh-plugin/cordis.patch.yml", "dsh-plugin/cordis.patch.yml"),
    ("packages/dsh-plugin/icon.svg", "dsh-plugin/icon.svg"),
    ("packages/agy-status-pill/hooks.json", "antigravity-plugin/hooks.json"),
    ("packages/agy-status-pill/hooks/muse-hook.cjs", "antigravity-plugin/hooks/muse-hook.cjs"),
    ("packages/agy-status-pill/pill.js", "antigravity-plugin/pill.js"),
    ("packages/agy-status-pill/plugin.json", "antigravity-plugin/plugin.json"),
    ("packages/agy-status-pill/append-pill.cjs", "antigravity-plugin/append-pill.cjs"),
    ("packages/agy-status-pill/install_widget.cjs", "antigravity-plugin/install_widget.cjs"),
    ("packages/agy-status-pill/assets/logo.svg", "antigravity-plugin/assets/logo.svg"),
    ("tools/muse_link_client.py", "muse-client/muse_link_client.py"),
    ("tools/MUSE_LINK_SKILL.md", "muse-client/MUSE_LINK_SKILL.md"),
    ("tools/install-office-v2.ps1", "install-office-v2.ps1"),
]


def psrun(script: str, timeout: int = 120) -> str:
    b64 = base64.b64encode(script.encode("utf-16-le")).decode()
    cmd = [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ConnectTimeout=20",
        "-i", os.path.expanduser("~/.ssh/id_ed25519"),
        f"{USER}@{HOST}",
        f"powershell -NoProfile -EncodedCommand {b64}",
    ]
    if os.path.exists("/tmp/tsconnect.py"):
        cmd[1:1] = ["-o", "ProxyCommand=python3 /tmp/tsconnect.py %h %p"]
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"SSH exit {r.returncode}: {r.stderr.decode('utf-8', 'replace')}")
    return r.stdout.decode("utf-8", errors="replace")


def build_zip_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for rel_src, rel_dst in BUNDLE_FILES:
            p = REPO_ROOT / rel_src
            if not p.exists():
                raise FileNotFoundError(f"Missing repo file: {p}")
            zf.write(p, rel_dst)
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-restart", action="store_true", help="Do not restart DSH web host automatically")
    args = ap.parse_args()

    raw_zip = build_zip_bytes()
    b64_zip = base64.b64encode(raw_zip).decode("ascii")
    print(f"Built office v2 bundle: {len(raw_zip)} bytes ({len(b64_zip)} b64 chars)")

    psrun(
        f"if (Test-Path '{REMOTE_DIR}') {{ Remove-Item '{REMOTE_DIR}' -Recurse -Force }}; "
        f"New-Item -ItemType Directory -Path '{REMOTE_DIR}' -Force | Out-Null; 'ready'"
    )

    chunk_size = 1400
    total = (len(b64_zip) + chunk_size - 1) // chunk_size
    b64_remote = f"{REMOTE_DIR}\\bundle.zip.b64"
    for i in range(total):
        chunk = b64_zip[i * chunk_size : (i + 1) * chunk_size]
        psrun(f"Add-Content -Path '{b64_remote}' -Value '{chunk}' -NoNewline -Encoding Ascii")
        if (i + 1) % 15 == 0 or i + 1 == total:
            print(f"Uploaded {i + 1}/{total} chunks")

    psrun(
        f"$b = [IO.File]::ReadAllText('{b64_remote}'); "
        f"[IO.File]::WriteAllBytes('{REMOTE_DIR}\\bundle.zip', [Convert]::FromBase64String($b)); "
        f"Expand-Archive -Path '{REMOTE_DIR}\\bundle.zip' -DestinationPath '{REMOTE_DIR}\\src' -Force; 'unpacked'"
    )

    flag = "" if args.no_restart else " -RestartDshWeb"
    out = psrun(
        f"powershell -NoProfile -ExecutionPolicy Bypass -File '{REMOTE_DIR}\\src\\install-office-v2.ps1'{flag}",
        timeout=180,
    )
    print(out)

    # Verify via muse_link_client.py status
    sys.path.insert(0, str(REPO_ROOT / "tools"))
    import muse_link_client

    for attempt in range(6):
        try:
            st, data = muse_link_client.http_request(HOST, 47616, "GET", "/v2/status")
            print(f"Verify attempt {attempt + 1}: HTTP {st}", json.dumps(data, ensure_ascii=False))
            if st == 200 and data.get("agents", {}).get("dsh", {}).get("available"):
                print("OFFICE_WORKSTATION_V2_VERIFIED")
                return
        except Exception as e:
            print(f"Verify attempt {attempt + 1} failed: {e}")
        time.sleep(5)


if __name__ == "__main__":
    main()

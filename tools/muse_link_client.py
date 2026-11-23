#!/usr/bin/env python3
"""Muse Agent Link v2 — Zero-dependency Python3 client for Meta Muse VMs.

Features:
  - Routes over Meta Hatch Tailscale tunnel proxy (HTTPS_PROXY host :3130 HTTP CONNECT)
    or direct TCP when HTTPS_PROXY is absent / --direct is set.
  - Strict bounded long-poll slices (<= 18s) to stay safely under Hatch's ~25s proxy cutoff.
  - Account-level multiplexed event cursor persisted per machine (~/.muse-link/state/).
  - Idempotent windowKey reuse so Muse never spams duplicate local DSH/AGY sessions.
  - Auto-reads legacy ../.device-token-<machine> if present for seamless v1 -> v2 upgrade.
"""
import argparse
import base64
import json
import os
import pathlib
import socket
import sys
import time
import urllib.parse

DEFAULT_MACHINES = {
    "cnlt-pf23d7z3": ("100.117.132.86", 47616),
    "office-workstation": ("100.91.205.57", 47616),
}

BASE_DIR = pathlib.Path(os.environ.get("MUSE_LINK_HOME", os.path.expanduser("~/.muse-link")))
CRED_DIR = BASE_DIR / "credentials"
STATE_DIR = BASE_DIR / "state"
MAX_SLICE_SEC = 18


def ensure_dirs():
    CRED_DIR.mkdir(parents=True, exist_ok=True)
    STATE_DIR.mkdir(parents=True, exist_ok=True)


def cred_path(machine: str) -> pathlib.Path:
    return CRED_DIR / f"{machine}.json"


def state_path(machine: str) -> pathlib.Path:
    return STATE_DIR / f"{machine}.json"


def load_cred(machine: str, host_override=None, port_override=None):
    p = cred_path(machine)
    data = {}
    if p.exists():
        data = json.loads(p.read_text(encoding="utf-8"))
    else:
        # Backward-compat: check legacy .device-token-<machine>
        legacy_candidates = [
            pathlib.Path(os.environ["MUSE_LINK_TOKEN_FILE"]) if os.environ.get("MUSE_LINK_TOKEN_FILE") else None,
            pathlib.Path(__file__).resolve().parent.parent / f".device-token-{machine}",
            BASE_DIR / f".device-token-{machine}",
        ]
        for cand in legacy_candidates:
            if cand and cand.exists():
                data = {"token": cand.read_text(encoding="utf-8").strip()}
                break

    default_host, default_port = DEFAULT_MACHINES.get(machine, ("127.0.0.1", 47616))
    host = host_override or os.environ.get("MUSE_LINK_HOST") or data.get("host") or default_host
    port = int(port_override or os.environ.get("MUSE_LINK_PORT") or data.get("port") or default_port)
    return {
        "host": host,
        "port": port,
        "token": data.get("token"),
        "accountId": data.get("accountId"),
        "label": data.get("label"),
        "role": data.get("role"),
    }


def save_cred(machine: str, info: dict):
    ensure_dirs()
    p = cred_path(machine)
    p.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass


def load_state(machine: str) -> dict:
    p = state_path(machine)
    if p.exists():
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(d, dict):
                d.setdefault("cursor", 0)
                d.setdefault("windows", {})
                return d
        except Exception:
            pass
    return {"cursor": 0, "windows": {}}


def save_state(machine: str, st: dict):
    ensure_dirs()
    p = state_path(machine)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)


def _dechunk(raw: bytes) -> bytes:
    out = bytearray()
    rest = raw
    while True:
        idx = rest.find(b"\r\n")
        if idx < 0:
            break
        size_line = rest[:idx].split(b";", 1)[0].strip()
        try:
            n = int(size_line, 16)
        except ValueError:
            break
        rest = rest[idx + 2 :]
        if n == 0:
            break
        out.extend(rest[:n])
        rest = rest[n + 2 :]
    return bytes(out)


def http_request(
    host: str,
    port: int,
    method: str,
    path: str,
    body=None,
    token=None,
    timeout: float = 25.0,
    direct: bool = False,
    raw_response: bool = False,
):
    proxy_url = "" if direct else os.environ.get("HTTPS_PROXY", "")
    if proxy_url and host not in ("127.0.0.1", "localhost", "::1"):
        u = urllib.parse.urlparse(proxy_url)
        tunnel_port = int(os.environ.get("MUSE_TUNNEL_PROXY_PORT", "3130"))
        s = socket.create_connection((u.hostname, tunnel_port), timeout=min(timeout, 20.0))
        auth_line = ""
        if u.username is not None:
            auth = base64.b64encode(f"{u.username}:{u.password or ''}".encode()).decode()
            auth_line = f"Proxy-Authorization: Basic {auth}\r\n"
        s.sendall(
            f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n{auth_line}\r\n".encode()
        )
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = s.recv(1024)
            if not chunk:
                s.close()
                raise RuntimeError("Tunnel proxy closed during CONNECT")
            buf += chunk
        status_line = buf.split(b"\r\n", 1)[0]
        if b" 200 " not in status_line:
            s.close()
            raise RuntimeError(f"Proxy CONNECT failed: {status_line!r}")
    else:
        s = socket.create_connection((host, port), timeout=min(timeout, 20.0))

    try:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else b""
        headers = [
            f"{method} {path} HTTP/1.1",
            f"Host: {host}:{port}",
            "Connection: close",
            "User-Agent: muse-link-client/2.0",
        ]
        if body is not None:
            headers.append("Content-Type: application/json; charset=utf-8")
            headers.append(f"Content-Length: {len(payload)}")
        if token:
            headers.append(f"Authorization: Bearer {token}")
        s.sendall(("\r\n".join(headers) + "\r\n\r\n").encode("utf-8") + payload)

        s.settimeout(timeout)
        chunks = []
        while True:
            try:
                c = s.recv(65536)
                if not c:
                    break
                chunks.append(c)
            except socket.timeout:
                break
        out = b"".join(chunks)
    finally:
        try:
            s.close()
        except Exception:
            pass

    if b"\r\n\r\n" not in out:
        raise RuntimeError(f"Incomplete HTTP response from {host}:{port} ({len(out)} bytes)")
    head_bytes, _, body_bytes = out.partition(b"\r\n\r\n")
    first_line = head_bytes.split(b"\r\n", 1)[0]
    parts = first_line.split(b" ")
    status = int(parts[1]) if len(parts) >= 2 else 0
    if b"transfer-encoding: chunked" in head_bytes.lower():
        body_bytes = _dechunk(body_bytes)
    if raw_response:
        return status, body_bytes
    if not body_bytes.strip():
        return status, {}
    try:
        return status, json.loads(body_bytes.decode("utf-8"))
    except Exception:
        return status, {"raw": body_bytes.decode("utf-8", errors="replace")}


def require_token(cred: dict):
    if not cred.get("token"):
        print(json.dumps({"error": {"code": "not_paired", "message": "No token found for this machine. Run `pair` first."}}, ensure_ascii=False))
        sys.exit(2)
    return cred["token"]


def cmd_status(args):
    cred = load_cred(args.machine, args.host, args.port)
    status, data = http_request(cred["host"], cred["port"], "GET", "/v2/status", direct=args.direct)
    print(json.dumps({"http": status, **data}, ensure_ascii=False, indent=2))


def cmd_pair(args):
    cred = load_cred(args.machine, args.host, args.port)
    payload = {"code": args.code}
    if args.client_name:
        payload["clientName"] = args.client_name
    status, data = http_request(cred["host"], cred["port"], "POST", "/v2/pair", payload, direct=args.direct)
    if status == 200 and data.get("token"):
        save_cred(
            args.machine,
            {
                "host": cred["host"],
                "port": cred["port"],
                "accountId": data.get("accountId"),
                "label": data.get("label"),
                "role": data.get("role"),
                "token": data["token"],
                "machine": data.get("machine", args.machine),
            },
        )
        redacted = {k: v for k, v in data.items() if k != "token"}
        redacted["tokenSavedTo"] = str(cred_path(args.machine))
        print(json.dumps({"http": status, **redacted}, ensure_ascii=False, indent=2))
    else:
        print(json.dumps({"http": status, **data}, ensure_ascii=False, indent=2))
        sys.exit(1)


def cmd_me(args):
    cred = load_cred(args.machine, args.host, args.port)
    tok = require_token(cred)
    status, data = http_request(cred["host"], cred["port"], "GET", "/v2/me", token=tok, direct=args.direct)
    print(json.dumps({"http": status, **data}, ensure_ascii=False, indent=2))


def cmd_open(args):
    cred = load_cred(args.machine, args.host, args.port)
    tok = require_token(cred)
    body = {}
    if args.agent:
        body["agent"] = args.agent
    if args.workspace:
        body["workspace"] = args.workspace
    if args.title:
        body["title"] = args.title
    if args.window_key:
        body["windowKey"] = args.window_key
    if args.model:
        body["model"] = args.model
    if args.preset:
        body["preset"] = args.preset
    status, data = http_request(cred["host"], cred["port"], "POST", "/v2/threads", body, token=tok, direct=args.direct)
    if status in (200, 201) and data.get("thread") and args.window_key:
        st = load_state(args.machine)
        st["windows"][args.window_key] = {
            "threadId": data["thread"]["id"],
            "agent": data["thread"]["agent"],
        }
        save_state(args.machine, st)
    print(json.dumps({"http": status, **data}, ensure_ascii=False, indent=2))


def cmd_threads(args):
    cred = load_cred(args.machine, args.host, args.port)
    tok = require_token(cred)
    qs = f"?scope={urllib.parse.quote(args.scope)}"
    if args.include_closed:
        qs += "&includeClosed=1"
    status, data = http_request(cred["host"], cred["port"], "GET", f"/v2/threads{qs}", token=tok, direct=args.direct)
    print(json.dumps({"http": status, **data}, ensure_ascii=False, indent=2))


def cmd_thread(args):
    cred = load_cred(args.machine, args.host, args.port)
    tok = require_token(cred)
    status, data = http_request(cred["host"], cred["port"], "GET", f"/v2/threads/{urllib.parse.quote(args.thread_id)}", token=tok, direct=args.direct)
    print(json.dumps({"http": status, **data}, ensure_ascii=False, indent=2))


def cmd_send(args):
    cred = load_cred(args.machine, args.host, args.port)
    tok = require_token(cred)
    st = load_state(args.machine)
    body = {"text": args.text, "mode": args.mode}
    status, data = http_request(
        cred["host"],
        cred["port"],
        "POST",
        f"/v2/threads/{urllib.parse.quote(args.thread_id)}/messages",
        body,
        token=tok,
        direct=args.direct,
    )
    if status not in (200, 202) or args.wait <= 0:
        print(json.dumps({"http": status, **data}, ensure_ascii=False, indent=2))
        if status >= 400:
            sys.exit(1)
        return

    turn_id = data.get("turnId")
    cursor = max(int(st.get("cursor", 0)), int(data.get("cursor", 0)))
    deadline = time.monotonic() + args.wait
    collected = []
    local_user_msgs = []
    last_progress = None

    while time.monotonic() < deadline:
        remaining = max(1, int(deadline - time.monotonic()))
        slice_wait = min(MAX_SLICE_SEC, remaining)
        qs = f"?cursor={cursor}&wait={slice_wait}&threadId={urllib.parse.quote(args.thread_id)}"
        try:
            ps, pdata = http_request(
                cred["host"],
                cred["port"],
                "GET",
                f"/v2/events{qs}",
                token=tok,
                timeout=slice_wait + 6.0,
                direct=args.direct,
            )
        except Exception:
            time.sleep(1.0)
            continue

        if ps == 200 and isinstance(pdata, dict):
            new_cursor = int(pdata.get("cursor", cursor))
            if new_cursor > cursor:
                cursor = new_cursor
                st["cursor"] = cursor
                save_state(args.machine, st)
            for ev in pdata.get("events", []):
                collected.append(ev)
                etype = ev.get("type")
                payload = ev.get("payload") or {}
                if etype == "local.user_message":
                    local_user_msgs.append(payload.get("text", ""))
                elif etype == "output.progress":
                    last_progress = payload
                elif etype in ("approval.requested", "approval.hint_local_ui"):
                    print(
                        json.dumps(
                            {
                                "status": "approval_requested",
                                "threadId": args.thread_id,
                                "turnId": turn_id,
                                "cursor": cursor,
                                "approval": payload,
                                "localUserMessages": local_user_msgs,
                            },
                            ensure_ascii=False,
                            indent=2,
                        )
                    )
                    return
                elif etype == "question.asked":
                    print(
                        json.dumps(
                            {
                                "status": "question_asked",
                                "threadId": args.thread_id,
                                "turnId": turn_id,
                                "cursor": cursor,
                                "question": payload,
                                "localUserMessages": local_user_msgs,
                            },
                            ensure_ascii=False,
                            indent=2,
                        )
                    )
                    return
                elif etype == "turn.finished":
                    print(
                        json.dumps(
                            {
                                "status": payload.get("status", "ok"),
                                "threadId": args.thread_id,
                                "turnId": payload.get("turnId") or turn_id,
                                "cursor": cursor,
                                "resultText": payload.get("resultText", ""),
                                "error": payload.get("error"),
                                "media": payload.get("media", []),
                                "localUserMessages": local_user_msgs,
                            },
                            ensure_ascii=False,
                            indent=2,
                        )
                    )
                    return

    print(
        json.dumps(
            {
                "status": "still_running",
                "threadId": args.thread_id,
                "turnId": turn_id,
                "cursor": cursor,
                "lastProgress": last_progress,
                "localUserMessages": local_user_msgs,
                "eventCount": len(collected),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def cmd_poll(args):
    cred = load_cred(args.machine, args.host, args.port)
    tok = require_token(cred)
    st = load_state(args.machine)
    cursor = args.cursor if args.cursor is not None else int(st.get("cursor", 0))
    wait_sec = min(max(int(args.wait), 0), MAX_SLICE_SEC)
    qs = f"?cursor={cursor}&wait={wait_sec}"
    if args.thread_id:
        qs += f"&threadId={urllib.parse.quote(args.thread_id)}"
    status, data = http_request(
        cred["host"],
        cred["port"],
        "GET",
        f"/v2/events{qs}",
        token=tok,
        timeout=wait_sec + 6.0,
        direct=args.direct,
    )
    if status == 200 and isinstance(data, dict) and not args.no_commit:
        new_cursor = int(data.get("cursor", cursor))
        if new_cursor > int(st.get("cursor", 0)):
            st["cursor"] = new_cursor
            save_state(args.machine, st)
    print(json.dumps({"http": status, **data}, ensure_ascii=False, indent=2))


def cmd_simple_post(args, endpoint_fn, body=None):
    cred = load_cred(args.machine, args.host, args.port)
    tok = require_token(cred)
    status, data = http_request(cred["host"], cred["port"], "POST", endpoint_fn(args), body or {}, token=tok, direct=args.direct)
    print(json.dumps({"http": status, **data}, ensure_ascii=False, indent=2))


def cmd_fetch_token(args):
    cred = load_cred(args.machine, args.host, args.port)
    tok = require_token(cred)
    status, raw = http_request(
        cred["host"],
        cred["port"],
        "GET",
        f"/v2/files/{urllib.parse.quote(args.file_token)}",
        token=tok,
        direct=args.direct,
        raw_response=True,
    )
    if status != 200:
        print(json.dumps({"http": status, "error": raw.decode("utf-8", errors="replace")}, ensure_ascii=False))
        sys.exit(1)
    out_path = pathlib.Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(raw)
    print(json.dumps({"http": status, "savedTo": str(out_path), "bytes": len(raw)}, ensure_ascii=False))


def cmd_fetch_file(args):
    cred = load_cred(args.machine, args.host, args.port)
    tok = require_token(cred)
    body = {"workspace": args.workspace, "path": args.path, "encoding": "base64" if args.out else "utf8"}
    status, data = http_request(cred["host"], cred["port"], "POST", "/v2/files/fetch", body, token=tok, direct=args.direct)
    if status == 200 and args.out and data.get("base64"):
        raw = base64.b64decode(data["base64"])
        out_path = pathlib.Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(raw)
        print(json.dumps({"http": status, "savedTo": str(out_path), "bytes": len(raw)}, ensure_ascii=False))
    else:
        print(json.dumps({"http": status, **data}, ensure_ascii=False, indent=2))


def cmd_self_update(args):
    cred = load_cred(args.machine, args.host, args.port)
    tok = require_token(cred)
    status, raw = http_request(cred["host"], cred["port"], "GET", "/v2/client.py", token=tok, direct=args.direct, raw_response=True)
    if status != 200 or b"def http_request" not in raw:
        print(json.dumps({"http": status, "error": "Unexpected client.py payload"}, ensure_ascii=False))
        sys.exit(1)
    me_file = pathlib.Path(__file__).resolve()
    tmp = me_file.with_suffix(".py.tmp")
    tmp.write_bytes(raw)
    os.replace(tmp, me_file)
    try:
        os.chmod(me_file, 0o755)
    except OSError:
        pass
    print(json.dumps({"ok": True, "updated": str(me_file), "bytes": len(raw)}, ensure_ascii=False))


def build_parser():
    p = argparse.ArgumentParser(description="Muse Agent Link v2 client")
    p.add_argument("--machine", default=os.environ.get("MUSE_LINK_MACHINE", "cnlt-pf23d7z3"))
    p.add_argument("--host", default=None)
    p.add_argument("--port", type=int, default=None)
    p.add_argument("--direct", action="store_true", help="Bypass HTTPS_PROXY (direct TCP)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status").set_defaults(func=cmd_status)

    sp = sub.add_parser("pair")
    sp.add_argument("--code", required=True)
    sp.add_argument("--client-name", default=None)
    sp.set_defaults(func=cmd_pair)

    sub.add_parser("me").set_defaults(func=cmd_me)

    so = sub.add_parser("open")
    so.add_argument("--agent", choices=["dsh", "antigravity"], default=None)
    so.add_argument("--workspace", default=None)
    so.add_argument("--title", default=None)
    so.add_argument("--window-key", default=None)
    so.add_argument("--model", default=None)
    so.add_argument("--preset", default=None)
    so.set_defaults(func=cmd_open)

    st = sub.add_parser("threads")
    st.add_argument("--scope", choices=["mine", "owner"], default="mine")
    st.add_argument("--include-closed", action="store_true")
    st.set_defaults(func=cmd_threads)

    sth = sub.add_parser("thread")
    sth.add_argument("thread_id")
    sth.set_defaults(func=cmd_thread)

    ss = sub.add_parser("send")
    ss.add_argument("thread_id")
    ss.add_argument("text")
    ss.add_argument("--mode", choices=["queue", "steer"], default="queue")
    ss.add_argument("--wait", type=int, default=0, help="Total seconds to wait via <=18s slices (e.g. 75)")
    ss.set_defaults(func=cmd_send)

    spl = sub.add_parser("poll")
    spl.add_argument("--wait", type=int, default=0, help="0..18 seconds")
    spl.add_argument("--cursor", type=int, default=None)
    spl.add_argument("--thread-id", default=None)
    spl.add_argument("--no-commit", action="store_true")
    spl.set_defaults(func=cmd_poll)

    sstop = sub.add_parser("stop")
    sstop.add_argument("thread_id")
    sstop.set_defaults(func=lambda a: cmd_simple_post(a, lambda x: f"/v2/threads/{urllib.parse.quote(x.thread_id)}/stop"))

    sclose = sub.add_parser("close")
    sclose.add_argument("thread_id")
    sclose.set_defaults(func=lambda a: cmd_simple_post(a, lambda x: f"/v2/threads/{urllib.parse.quote(x.thread_id)}/close"))

    stake = sub.add_parser("takeover")
    stake.add_argument("thread_id")
    stake.set_defaults(func=lambda a: cmd_simple_post(a, lambda x: f"/v2/threads/{urllib.parse.quote(x.thread_id)}/takeover"))

    sap = sub.add_parser("approve")
    sap.add_argument("approval_id")
    sap.add_argument("decision", choices=["approve_once", "deny"], default="approve_once", nargs="?")
    sap.set_defaults(func=lambda a: cmd_simple_post(a, lambda x: f"/v2/approvals/{urllib.parse.quote(x.approval_id)}", {"decision": a.decision}))

    sft = sub.add_parser("fetch-token")
    sft.add_argument("file_token")
    sft.add_argument("--out", required=True)
    sft.set_defaults(func=cmd_fetch_token)

    sff = sub.add_parser("fetch-file")
    sff.add_argument("--workspace", required=True)
    sff.add_argument("--path", required=True)
    sff.add_argument("--out", default=None)
    sff.set_defaults(func=cmd_fetch_file)

    sub.add_parser("self-update").set_defaults(func=cmd_self_update)
    sub.add_parser("unpair").set_defaults(func=lambda a: cmd_simple_post(a, lambda _x: "/v2/unpair"))
    return p


if __name__ == "__main__":
    args = build_parser().parse_args()
    args.func(args)

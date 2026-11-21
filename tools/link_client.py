#!/usr/bin/env python3
"""Victor-side client for the Muse Agent Link channel (office-workstation pilot).

Talks to the DSH plugin endpoint over Tailscale through the runtime proxy.
Usage:
  link_client.py status
  link_client.py pair <code>
  link_client.py task "<prompt>" [workspace]
  link_client.py job <job-id>
  link_client.py jobs
  link_client.py unpair

The device token is read from ../.device-token-office-workstation (never commit it).
"""
import base64
import json
import os
import socket
import sys
import urllib.parse

HOST = "100.91.205.57"  # office-workstation tailnet IP
PORT = 3080
BASE = "/api/muse-agent-link"
HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN_FILE = os.path.join(HERE, "..", ".device-token-office-workstation")


def request(method, path, body=None, token=None):
    u = urllib.parse.urlparse(os.environ["HTTPS_PROXY"])
    auth = base64.b64encode(f"{u.username}:{u.password}".encode()).decode()
    s = socket.create_connection((u.hostname, 3130), timeout=20)
    s.sendall(
        f"CONNECT {HOST}:{PORT} HTTP/1.1\r\nHost: {HOST}:{PORT}\r\n"
        f"Proxy-Authorization: Basic {auth}\r\n\r\n".encode()
    )
    buf = b""
    while b"\r\n\r\n" not in buf:
        c = s.recv(1024)
        if not c:
            raise RuntimeError("proxy closed during CONNECT")
        buf += c
    if b" 200 " not in buf.split(b"\r\n")[0]:
        raise RuntimeError(f"CONNECT failed: {buf.splitlines()[0]!r}")
    payload = json.dumps(body).encode() if body is not None else b""
    headers = [
        f"{method} {BASE}{path} HTTP/1.1",
        f"Host: {HOST}:{PORT}",
        "Connection: close",
    ]
    if body is not None:
        headers.append("Content-Type: application/json")
        headers.append(f"Content-Length: {len(payload)}")
    if token:
        headers.append(f"Authorization: Bearer {token}")
    s.sendall(("\r\n".join(headers) + "\r\n\r\n").encode() + payload)
    out = b""
    s.settimeout(30)
    try:
        while True:
            c = s.recv(65536)
            if not c:
                break
            out += c
    except socket.timeout:
        pass
    head, _, raw = out.partition(b"\r\n\r\n")
    status = int(head.split(b" ")[1])
    if b"chunked" in head.lower():
        # minimal dechunk
        data = b""
        rest = raw
        while True:
            line, _, rest = rest.partition(b"\r\n")
            try:
                n = int(line.strip(), 16)
            except ValueError:
                break
            if n == 0:
                break
            data += rest[:n]
            rest = rest[n + 2:]
        raw = data
    return status, json.loads(raw.decode("utf-8")) if raw.strip() else {}


def load_token():
    with open(TOKEN_FILE) as f:
        return f.read().strip()


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "status":
        print(json.dumps(request("GET", "/status")[1], ensure_ascii=False, indent=2))
    elif cmd == "pair":
        status, data = request("POST", "/pair", {"code": sys.argv[2]})
        print("HTTP", status)
        if status == 200 and "token" in data:
            with open(TOKEN_FILE, "w") as f:
                f.write(data["token"])
            os.chmod(TOKEN_FILE, 0o600)
            print("paired; token saved to", TOKEN_FILE)
        else:
            print(json.dumps(data, ensure_ascii=False))
    elif cmd == "task":
        body = {"prompt": sys.argv[2]}
        if len(sys.argv) > 3:
            body["workspace"] = sys.argv[3]
        status, data = request("POST", "/tasks", body, load_token())
        print("HTTP", status, json.dumps(data, ensure_ascii=False))
    elif cmd == "job":
        status, data = request("GET", f"/task?id={sys.argv[2]}", None, load_token())
        print("HTTP", status, json.dumps(data, ensure_ascii=False, indent=2))
    elif cmd == "jobs":
        status, data = request("GET", "/tasks", None, load_token())
        print("HTTP", status, json.dumps(data, ensure_ascii=False, indent=2))
    elif cmd == "thread-create":
        body = {}
        if len(sys.argv) > 2:
            body["workspace"] = sys.argv[2]
        status, data = request("POST", "/threads", body, load_token())
        print("HTTP", status, json.dumps(data, ensure_ascii=False, indent=2))
    elif cmd == "threads":
        status, data = request("GET", "/threads", None, load_token())
        print("HTTP", status, json.dumps(data, ensure_ascii=False, indent=2))
    elif cmd == "thread":
        status, data = request("GET", f"/thread?id={sys.argv[2]}", None, load_token())
        print("HTTP", status, json.dumps(data, ensure_ascii=False, indent=2))
    elif cmd == "thread-send":
        body = {"threadId": sys.argv[2], "text": sys.argv[3]}
        if len(sys.argv) > 4:
            body["mode"] = sys.argv[4]
        status, data = request("POST", "/thread-message", body, load_token())
        print("HTTP", status, json.dumps(data, ensure_ascii=False, indent=2))
    elif cmd == "thread-events":
        cursor = sys.argv[3] if len(sys.argv) > 3 else "0"
        status, data = request("GET", f"/thread-events?id={sys.argv[2]}&cursor={cursor}", None, load_token())
        print("HTTP", status, json.dumps(data, ensure_ascii=False, indent=2))
    elif cmd == "thread-stop":
        status, data = request("POST", f"/thread-stop?id={sys.argv[2]}", {}, load_token())
        print("HTTP", status, json.dumps(data, ensure_ascii=False, indent=2))
    elif cmd == "approve":
        decision = sys.argv[3] if len(sys.argv) > 3 else "approve_once"
        status, data = request("POST", "/approvals", {"id": sys.argv[2], "decision": decision}, load_token())
        print("HTTP", status, json.dumps(data, ensure_ascii=False))
    elif cmd == "unpair":
        status, data = request("POST", "/unpair", {}, load_token())
        print("HTTP", status, json.dumps(data, ensure_ascii=False))
    else:
        print(__doc__)


if __name__ == "__main__":
    main()

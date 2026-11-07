#!/usr/bin/env python3
"""serve.py — minimal static server for the second-brain dashboard.

Serves `public/` (or `dist/` if the bundler has run) on localhost, with an
optional password gate backed by auth.json.

Usage:
    python3 server/serve.py                 # http://127.0.0.1:8741
    python3 server/serve.py --port 9000
    python3 server/serve.py --host 0.0.0.0  # expose on LAN (use with a password)
    python3 make_auth.py <password>         # create auth.json first

This is a single-user dashboard. It is NOT hardened for the public internet —
put it behind a reverse proxy with TLS if you expose it.
"""

from __future__ import annotations

import argparse
import functools
import hashlib
import hmac
import http.server
import json
import os
import pathlib
import socketserver
import sys
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
AUTH_FILE = ROOT / "auth.json"


def load_auth() -> dict | None:
    if not AUTH_FILE.exists():
        return None
    try:
        return json.loads(AUTH_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        return None


class Handler(http.server.SimpleHTTPRequestHandler):
    auth: dict | None = None
    serve_dir: pathlib.Path = ROOT / "public"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(self.serve_dir), **kwargs)

    # ---- auth ------------------------------------------------------------
    def _authed(self) -> bool:
        if not self.auth:
            return True
        cookie = self.headers.get("Cookie", "")
        for part in cookie.split(";"):
            name, _, value = part.strip().partition("=")
            if name == "sb_session" and hmac.compare_digest(
                value, self._expected_session()
            ):
                return True
        return False

    def _expected_session(self) -> str:
        secret = str(self.auth.get("secret", ""))
        pw = str(self.auth.get("password", ""))
        return hashlib.sha256((secret + pw).encode()).hexdigest()

    def do_GET(self) -> None:  # noqa: N802
        if not self.auth:
            return super().do_GET()

        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/login":
            return self._login_page()

        if not self._authed():
            self.send_response(302)
            self.send_header("Location", "/login")
            self.end_headers()
            return
        return super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if not self.auth or urllib.parse.urlparse(self.path).path != "/login":
            self.send_error(405)
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(length).decode("utf-8", "ignore")
        fields = urllib.parse.parse_qs(body)
        supplied = (fields.get("password") or [""])[0]
        if hmac.compare_digest(supplied, str(self.auth.get("password", ""))):
            self.send_response(302)
            self.send_header(
                "Set-Cookie",
                f"sb_session={self._expected_session()}; HttpOnly; Path=/; SameSite=Lax",
            )
            self.send_header("Location", "/")
            self.end_headers()
            return
        self.send_response(302)
        self.send_header("Location", "/login?error=1")
        self.end_headers()

    def _login_page(self) -> None:
        err = "Invalid password." if "error=1" in self.path else ""
        html = f"""<!doctype html><meta charset="utf-8">
<title>Second Brain</title>
<style>
 body{{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;
      height:100vh;margin:0;background:#0f1115;color:#e6e6e6}}
 form{{background:#191c23;padding:2rem 2.5rem;border-radius:12px;
      box-shadow:0 8px 32px #0008;min-width:260px}}
 h1{{font-size:1.1rem;margin:0 0 1rem;font-weight:600}}
 input{{width:100%;padding:.6rem .7rem;border-radius:8px;border:1px solid #2e333d;
       background:#0f1115;color:inherit;box-sizing:border-box}}
 button{{margin-top:.9rem;width:100%;padding:.6rem;border-radius:8px;border:0;
        background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}}
 .err{{color:#f87171;font-size:.85rem;margin:.5rem 0 0}}
</style>
<form method="post" action="/login">
  <h1>Second Brain</h1>
  <input type="password" name="password" placeholder="Password" autofocus required>
  <button type="submit">Unlock</button>
  {f'<p class="err">{err}</p>' if err else ''}
</form>"""
        payload = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main() -> int:
    ap = argparse.ArgumentParser(description="Serve the second-brain dashboard.")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8741)
    ap.add_argument("--dir", default=None, help="override the directory to serve")
    args = ap.parse_args()

    serve_dir = pathlib.Path(args.dir) if args.dir else (
        ROOT / "dist" if (ROOT / "dist").exists() else ROOT / "public"
    )
    if not serve_dir.exists():
        print(f"error: nothing to serve at {serve_dir}", file=sys.stderr)
        print("       run `npm run build` first, or keep public/ intact.", file=sys.stderr)
        return 1

    Handler.serve_dir = serve_dir
    Handler.auth = load_auth()

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((args.host, args.port), Handler) as httpd:
        gate = "password-protected" if Handler.auth else "OPEN (no auth.json)"
        print(f"second-brain dashboard → http://{args.host}:{args.port}  [{gate}]")
        print(f"serving {serve_dir}")
        if not Handler.auth and args.host not in ("127.0.0.1", "localhost"):
            print("WARNING: bound to a non-local address with no password!", file=sys.stderr)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

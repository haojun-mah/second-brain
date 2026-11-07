#!/usr/bin/env python3
"""Shared Microsoft Graph helpers for the second-brain scripts.

Import this from other scripts in this directory:

    from _graph import GraphClient, load_env, VaultError

It handles the three things every script needs and gets wrong at least once:

  1. **Fresh access token per request.** Access tokens last ~1 hour, but if several processes
     share one refresh token, a concurrent refresh can invalidate a token you already hold.
     Re-exchanging costs ~200ms; a failed batch costs a whole run.

  2. **Redirect-safe downloads.** Graph's /content endpoint 302-redirects to a pre-authorised
     URL. Python's urllib copies the Authorization header across redirects, and the target
     rejects it with a 401. So downloads shell out to `curl -sL` instead.

  3. **Error-body detection.** Graph can return a JSON error body or an HTML error page with
     a 200-ish status after redirects. Writing one of those into the vault silently corrupts
     a file. Every read is checked before it is trusted.

Credentials come from the environment (or .env): MS_CLIENT_ID, MS_TENANT_ID, MS_REFRESH_TOKEN,
and optionally MS_VAULT_ROOT (default "Obsidian").
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

GRAPH = "https://graph.microsoft.com/v1.0"
SCOPE = "Files.ReadWrite offline_access"
DEFAULT_VAULT_ROOT = "Obsidian"


class VaultError(RuntimeError):
    """Raised when a Graph operation fails in a way the caller should surface."""


def load_env(explicit_path: str | None = None) -> None:
    """Load .env into os.environ without overwriting already-set variables."""
    candidates = []
    if explicit_path:
        candidates.append(Path(explicit_path))
    candidates.append(Path.cwd() / ".env")
    candidates.append(Path(__file__).resolve().parent.parent / ".env")

    for path in candidates:
        if not path.is_file():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
        return


class GraphClient:
    def __init__(self, vault_root: str | None = None) -> None:
        self.client_id = os.environ.get("MS_CLIENT_ID", "").strip()
        self.tenant_id = os.environ.get("MS_TENANT_ID", "").strip() or "common"
        self.refresh_token = os.environ.get("MS_REFRESH_TOKEN", "").strip()
        self.vault_root = (
            vault_root or os.environ.get("MS_VAULT_ROOT", "").strip() or DEFAULT_VAULT_ROOT
        ).strip("/")

        missing = [
            name
            for name, value in (
                ("MS_CLIENT_ID", self.client_id),
                ("MS_REFRESH_TOKEN", self.refresh_token),
            )
            if not value or value.startswith("your_")
        ]
        if missing:
            raise VaultError(
                f"missing or placeholder credential(s): {', '.join(missing)}. "
                "Set them in .env — see docs/CREDENTIALS.md."
            )

    # ---- auth -----------------------------------------------------------------
    def token(self) -> str:
        """Exchange the refresh token for a fresh access token. One call per request."""
        body = urllib.parse.urlencode(
            {
                "client_id": self.client_id,
                "grant_type": "refresh_token",
                "refresh_token": self.refresh_token,
                "scope": SCOPE,
            }
        ).encode()
        req = urllib.request.Request(
            f"https://login.microsoftonline.com/{self.tenant_id}/oauth2/v2.0/token",
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())["access_token"]
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            hint = ""
            if "invalid_grant" in detail:
                hint = (
                    "\n  The refresh token is expired or was revoked. Re-run\n"
                    "  scripts/get_refresh_token.py to get a new one."
                )
            elif "invalid_client" in detail:
                hint = "\n  The client ID is wrong or the app was deleted. Check MS_CLIENT_ID."
            raise VaultError(f"token refresh failed ({e.code}): {detail}{hint}") from e

    # ---- paths ----------------------------------------------------------------
    def content_url(self, vault_path: str) -> str:
        """/content endpoint URL for a vault-relative path."""
        full = f"{self.vault_root}/{vault_path.lstrip('/')}"
        return f"{GRAPH}/me/drive/root:/{urllib.parse.quote(full, safe='')}:/content"

    def item_url(self, vault_path: str) -> str:
        """Metadata endpoint URL (no /content) for a vault-relative path."""
        full = f"{self.vault_root}/{vault_path.lstrip('/')}"
        return f"{GRAPH}/me/drive/root:/{urllib.parse.quote(full, safe='')}:"

    def children_url(self, vault_path: str) -> str:
        """Children listing URL for a vault-relative directory path."""
        if not vault_path.strip("/"):
            return f"{GRAPH}/me/drive/root:/{urllib.parse.quote(self.vault_root, safe='')}:/children"
        full = f"{self.vault_root}/{vault_path.lstrip('/')}"
        return f"{GRAPH}/me/drive/root:/{urllib.parse.quote(full, safe='')}:/children"

    # ---- transfers ------------------------------------------------------------
    @staticmethod
    def _is_error_body(data: bytes) -> bool:
        head = data[:16].lstrip()
        return head.startswith(b'{"error"') or head.startswith(b"<")

    def download(self, vault_path: str, *, attempts: int = 2) -> bytes:
        """Fetch raw bytes. Uses curl so the 302 redirect keeps working."""
        last = b""
        for _ in range(attempts):
            token = self.token()
            proc = subprocess.run(
                ["curl", "-sL", "-H", f"Authorization: Bearer {token}", self.content_url(vault_path)],
                capture_output=True,
                timeout=120,
            )
            last = proc.stdout
            if last and not self._is_error_body(last):
                return last
        raise VaultError(
            f"download failed for {vault_path}: {last[:300].decode(errors='replace')!r}"
        )

    def download_text(self, vault_path: str, **kw) -> str:
        return self.download(vault_path, **kw).decode("utf-8", "replace")

    def download_json(self, vault_path: str, **kw):
        raw = self.download(vault_path, **kw)
        try:
            return json.loads(raw)
        except json.JSONDecodeError as e:
            raise VaultError(
                f"{vault_path} is not valid JSON: {e}\n"
                f"first bytes: {raw[:200].decode(errors='replace')!r}"
            ) from e

    def upload(self, vault_path: str, data: bytes, *, content_type: str = "text/plain",
               attempts: int = 2) -> str:
        """PUT raw bytes. Returns the new eTag."""
        last = b""
        for _ in range(attempts):
            token = self.token()
            proc = subprocess.run(
                [
                    "curl", "-sL", "-X", "PUT",
                    "-H", f"Authorization: Bearer {token}",
                    "-H", f"Content-Type: {content_type}",
                    "--data-binary", "@-",
                    self.content_url(vault_path),
                ],
                input=data,
                capture_output=True,
                timeout=120,
            )
            last = proc.stdout
            try:
                resp = json.loads(last)
            except json.JSONDecodeError:
                continue
            if "eTag" in resp or "name" in resp:
                return resp.get("eTag", "")
        raise VaultError(f"upload failed for {vault_path}: {last[:300].decode(errors='replace')!r}")

    def upload_text(self, vault_path: str, text: str) -> str:
        return self.upload(vault_path, text.encode("utf-8"))

    def upload_json(self, vault_path: str, obj) -> str:
        return self.upload(
            vault_path,
            json.dumps(obj, indent=2, ensure_ascii=False).encode("utf-8"),
            content_type="application/json",
        )

    # ---- metadata -------------------------------------------------------------
    def stat(self, vault_path: str) -> dict:
        """Return {name, size, eTag, lastModifiedDateTime, folder} for one item."""
        token = self.token()
        req = urllib.request.Request(
            self.item_url(vault_path), headers={"Authorization": f"Bearer {token}"}
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            raise VaultError(f"stat failed for {vault_path} ({e.code})") from e

    def list_dir(self, vault_path: str = "") -> list[dict]:
        """List immediate children of a vault directory."""
        token = self.token()
        req = urllib.request.Request(
            self.children_url(vault_path), headers={"Authorization": f"Bearer {token}"}
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read()).get("value", [])
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            raise VaultError(f"list failed for {vault_path} ({e.code}): {detail[:200]}") from e

    def exists(self, vault_path: str) -> bool:
        try:
            self.stat(vault_path)
            return True
        except VaultError:
            return False


def resolve_vault_path(*candidates: str) -> str:
    """Pick the first path that exists locally, for scripts that need a local checkout."""
    for c in candidates:
        if c and Path(c).is_dir():
            return str(Path(c).resolve())
    return ""


if __name__ == "__main__":
    # Smoke test: `python3 scripts/_graph.py`
    load_env()
    try:
        g = GraphClient()
        token = g.token()
        print(f"token OK ({len(token)} chars)")
        print(f"vault root: {g.vault_root}")
        entries = g.list_dir("")
        print(f"top-level entries: {len(entries)}")
        for e in entries[:20]:
            kind = "dir " if "folder" in e else "file"
            print(f"  {kind} {e['name']}")
    except VaultError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)

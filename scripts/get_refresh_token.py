#!/usr/bin/env python3
"""Capture a Microsoft Graph refresh token via the OAuth device-code flow.

This is the one-time dance you do to get MS_REFRESH_TOKEN. It prints a short code, you type
it into a browser, and Microsoft hands back a refresh token that the MCP server can use
indefinitely (refreshing itself from then on).

Usage:
    python3 scripts/get_refresh_token.py
    python3 scripts/get_refresh_token.py --client-id <id> --tenant <tenant>
    python3 scripts/get_refresh_token.py --scope "Files.ReadWrite offline_access User.Read"

Reads MS_CLIENT_ID and MS_TENANT_ID from the environment, or from .env in the repo root.
Never prints the client secret (there isn't one — this is a public client).

Requires: nothing outside the Python standard library.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_SCOPE = "Files.ReadWrite offline_access User.Read"
DEVICECODE_URL = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode"
TOKEN_URL = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"


def load_dotenv() -> None:
    """Minimal .env loader. Only fills vars that are not already set."""
    candidates = [
        Path.cwd() / ".env",
        Path(__file__).resolve().parent.parent / ".env",
    ]
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


def post(url: str, data: dict) -> dict:
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client-id", help="Azure app (client) ID; defaults to $MS_CLIENT_ID")
    parser.add_argument("--tenant", help="Tenant ID or alias; defaults to $MS_TENANT_ID")
    parser.add_argument("--scope", default=DEFAULT_SCOPE, help=f"OAuth scopes (default: {DEFAULT_SCOPE})")
    args = parser.parse_args()

    load_dotenv()

    client_id = args.client_id or os.environ.get("MS_CLIENT_ID", "").strip()
    tenant = args.tenant or os.environ.get("MS_TENANT_ID", "").strip() or "common"

    if not client_id or client_id.startswith("your_"):
        print(
            "error: no client ID.\n"
            "  Set MS_CLIENT_ID in .env, or pass --client-id <guid>.\n"
            "  See docs/SETUP.md step 1 for how to create the app registration.",
            file=sys.stderr,
        )
        return 1

    # ---- 1. request a device code -------------------------------------------------
    try:
        dc = post(
            DEVICECODE_URL.format(tenant=tenant),
            {"client_id": client_id, "scope": args.scope},
        )
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        print(f"error: device code request failed ({e.code})\n{detail}", file=sys.stderr)
        if "AADSTS700016" in detail:
            print("\nhint: the client ID does not exist in tenant "
                  f"'{tenant}'. Check MS_CLIENT_ID and MS_TENANT_ID.", file=sys.stderr)
        return 1

    if "user_code" not in dc:
        print(f"error: unexpected response\n{json.dumps(dc, indent=2)}", file=sys.stderr)
        return 1

    print()
    print("=" * 72)
    print(f"  Open:  {dc['verification_uri']}")
    print(f"  Code:  {dc['user_code']}")
    print("=" * 72)
    print()
    print("Sign in with the Microsoft account that owns your OneDrive, then approve the")
    print("permission request. Waiting for you to authenticate...")
    print()

    # ---- 2. poll for the token ----------------------------------------------------
    interval = int(dc.get("interval", 5))
    deadline = time.time() + int(dc.get("expires_in", 900))
    result: dict | None = None

    while time.time() < deadline:
        time.sleep(interval)
        try:
            result = post(
                TOKEN_URL.format(tenant=tenant),
                {
                    "grant_type": GRANT_TYPE,
                    "client_id": client_id,
                    "device_code": dc["device_code"],
                },
            )
        except urllib.error.HTTPError as e:
            payload = json.loads(e.read().decode(errors="replace") or "{}")
            err = payload.get("error", "")

            if err == "authorization_pending":
                continue
            if err == "slow_down":
                interval += 5
                continue
            if err == "authorization_declined":
                print("error: you declined the consent prompt. Re-run to try again.", file=sys.stderr)
                return 1
            if err == "expired_token":
                print("error: the code expired before you finished. Re-run to get a new one.", file=sys.stderr)
                return 1
            if err == "code_expired":
                print("error: the code expired. Re-run to get a new one.", file=sys.stderr)
                return 1

            desc = payload.get("error_description", "")
            print(f"error: token request failed: {err}\n{desc}", file=sys.stderr)
            if "AADSTS7000218" in desc:
                print(
                    "\nhint: enable 'Allow public client flows' on the app registration\n"
                    "      (Azure Portal -> your app -> Authentication -> Advanced settings).\n"
                    "      See docs/SETUP.md step 1.3.",
                    file=sys.stderr,
                )
            if "AADSTS65001" in desc:
                print(
                    "\nhint: consent was not granted. On a work/school tenant an admin may need\n"
                    "      to grant consent for the app (API permissions -> Grant admin consent).",
                    file=sys.stderr,
                )
            return 1
        else:
            break
    else:
        print("error: timed out waiting for authentication. Re-run to try again.", file=sys.stderr)
        return 1

    refresh_token = (result or {}).get("refresh_token")
    if not refresh_token:
        print(
            "error: no refresh_token in the response.\n"
            "  Most common cause: the 'offline_access' scope was not granted.\n"
            "  Check API permissions in the Azure portal, then re-run.",
            file=sys.stderr,
        )
        return 1

    # ---- 3. report ----------------------------------------------------------------
    print(f"✓ Refresh token captured ({len(refresh_token)} chars)")
    print()
    print("Add this line to your .env:")
    print()
    print(f"MS_REFRESH_TOKEN={refresh_token}")
    print()
    print("Then lock the file down:  chmod 600 .env")
    print()
    print("Note: this token grants read/write access to your OneDrive. Treat it as a")
    print("      password. See docs/CREDENTIALS.md before sharing this machine.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

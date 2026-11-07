#!/usr/bin/env python3
"""Rotate an expired OneDrive delta token.

When `mcp_onedrive_get_changes` returns `400 Invalid version`, the token stored in
`.meta/delta_token.json` has expired. This performs a full delta (no token), reads
`@odata.nextLink` out of the response, and writes a fresh token back in the same
single-field shape the reader expects.

Note the shape: the stored value is the **full nextLink URL**, not the bare `token=` query
parameter. Passing the bare parameter produces `400 Invalid version` on a perfectly valid
token, which looks exactly like an expiry and sends you chasing the wrong bug.

Usage:
    python3 rotate_delta_token.py

Prints DELTA_TOKEN_SAVED <etag> on success.

The delta feed is an optimisation, not the source of truth — file detection always comes from
listing the inbox directory directly. So a dead delta token costs you one rotation call and
nothing else.

Requires: MS_CLIENT_ID, MS_TENANT_ID, MS_REFRESH_TOKEN.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

GRAPH = "https://graph.microsoft.com/v1.0"
DELTA_PATH = ".meta/delta_token.json"


def find_scripts_dir() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "scripts" / "_graph.py"
        if candidate.is_file():
            return candidate.parent
    env_home = os.environ.get("SECOND_BRAIN_HOME", "").strip()
    for base in ([Path(env_home)] if env_home else []) + [Path.home() / ".second-brain"]:
        candidate = base / "scripts" / "_graph.py"
        if candidate.is_file():
            return candidate.parent
    raise SystemExit(
        "error: cannot find scripts/_graph.py. Run scripts/bootstrap.sh, "
        "or set SECOND_BRAIN_HOME to the repo root."
    )


sys.path.insert(0, str(find_scripts_dir()))

from _graph import GraphClient, VaultError, load_env  # noqa: E402

# $select=name keeps the delta payload small; we only need the nextLink, not the item bodies.
DELTA_URL = f"{GRAPH}/me/drive/root/delta?$select=name"


def main() -> int:
    load_env()
    try:
        client = GraphClient()
        token = client.token()
    except VaultError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    # A fresh full delta. This can paginate; we follow nextLink until we get a deltaLink,
    # which only appears on the final page.
    url: str | None = DELTA_URL
    delta_link: str | None = None
    pages = 0

    while url:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                page = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            print(f"error: delta call failed ({e.code}): {detail[:300]}", file=sys.stderr)
            return 1

        pages += 1
        if page.get("@odata.deltaLink"):
            delta_link = page["@odata.deltaLink"]
            break
        url = page.get("@odata.nextLink")
        if not url:
            # No deltaLink and no nextLink — tolerate by using the last nextLink we saw.
            print("warning: response had no deltaLink; nothing saved", file=sys.stderr)
            return 1

    if not delta_link:
        print("error: no @odata.deltaLink in the delta response", file=sys.stderr)
        return 1

    try:
        etag = client.upload_json(DELTA_PATH, {"token": delta_link})
    except VaultError as e:
        print(f"error: could not save token: {e}", file=sys.stderr)
        return 1

    print(f"DELTA_TOKEN_SAVED {etag or 'no-etag'}")
    if pages > 1:
        print(f"(walked {pages} pages)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Byte-exact single-line edits to a vault file, with an occurrence assertion.

For one-line changes on large files — fixing a typo in `wiki/index.md`, bumping an `updated:`
date — rewriting the whole file through an MCP tool is risky. A single mistyped character in a
code fence violates Rule 9; a dropped `![[...]]` violates Rule 8; and neither shows up in a
"success" response.

This does the edit the safe way: GET the raw bytes, assert the old string occurs exactly the
required number of times, PUT with an If-Match guard, GET again, byte-compare.

Usage:
    python3 vault_byte_edit.py /tmp/edits.json

Config: a list of edits, applied in order.

    [
      {"path": "wiki/index.md", "old": "[[First MissingPositive]]", "new": "[[First Missing Positive]]"},
      {"path": "wiki/concepts/Foo.md", "re": "updated: \"\\\\d{4}-\\\\d{2}-\\\\d{2}\"", "sub": "updated: \"2026-05-26\"", "count": 1}
    ]

Keys per edit:
    path   (required) vault path
    old    literal string to replace  ─┐ one of these two
    new    replacement                ─┘
    re     regex pattern              ─┐ or these two
    sub    replacement                ─┘
    count  (optional) expected occurrences, default 1; the edit fails if it doesn't match
    flags  (optional) regex flags string: "i" for case-insensitive, default ""

Prints one line per edit and VERIFY=OK / VERIFY=FAIL at the end. Non-zero exit on any failure.
An edit that fails is skipped; later edits still run, so a batch reports all problems at once.

Requires: MS_CLIENT_ID, MS_TENANT_ID, MS_REFRESH_TOKEN.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path


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


def fetch_with_etag(client: GraphClient, path: str) -> tuple[bytes, str]:
    """GET raw bytes and the item's eTag.

    Note the key: a children listing returns `@microsoft.graph.etag`, but a direct
    GET /me/drive/items/{id} returns `eTag`. Reading the wrong key yields None and the PUT then
    fails with an opaque TypeError about NoneType — the real cause is a missing header.
    """
    token = client.token()
    req = urllib.request.Request(
        client.item_url(path), headers={"Authorization": f"Bearer {token}"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        meta = json.loads(resp.read())
    etag = meta.get("eTag") or meta.get("@microsoft.graph.etag") or ""
    data = client.download(path)
    return data, etag


def put_with_guard(client: GraphClient, path: str, data: bytes, etag: str) -> None:
    token = client.token()
    proc_headers = [
        "-H", f"Authorization: Bearer {token}",
        "-H", "Content-Type: text/plain",
    ]
    if etag:
        # If-Match needs the etag with its literal quotes intact.
        proc_headers += ["-H", f"If-Match: {etag}"]

    import subprocess

    proc = subprocess.run(
        ["curl", "-sL", "-X", "PUT", *proc_headers, "--data-binary", "@-", client.content_url(path)],
        input=data,
        capture_output=True,
        timeout=120,
    )
    try:
        resp = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise VaultError(f"PUT returned non-JSON: {proc.stdout[:200].decode(errors='replace')!r}")
    if "eTag" not in resp and "name" not in resp:
        raise VaultError(f"PUT failed: {json.dumps(resp)[:300]}")


def apply_edit(text: str, edit: dict) -> tuple[str, int]:
    """Apply one edit to text. Returns (new_text, occurrences_replaced)."""
    if "old" in edit:
        old, new = edit["old"], edit.get("new", "")
        return text.replace(old, new), text.count(old)

    pattern = edit.get("re")
    if not pattern:
        raise ValueError("edit needs either 'old'/'new' or 're'/'sub'")
    flags = re.IGNORECASE if "i" in (edit.get("flags") or "") else 0
    matches = list(re.finditer(pattern, text, flags))
    return re.sub(pattern, edit.get("sub", ""), text, flags=flags), len(matches)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: vault_byte_edit.py <edits.json>", file=sys.stderr)
        return 1

    cfg_path = Path(sys.argv[1])
    if not cfg_path.is_file():
        print(f"error: no such config: {cfg_path}", file=sys.stderr)
        return 1

    try:
        edits = json.loads(cfg_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"error: config is not valid JSON: {e}", file=sys.stderr)
        return 1

    if isinstance(edits, dict):
        edits = [edits]
    if not isinstance(edits, list) or not edits:
        print("error: config must be a non-empty list of edits", file=sys.stderr)
        return 1

    load_env()
    try:
        client = GraphClient()
    except VaultError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    ok = True
    for i, edit in enumerate(edits, 1):
        path = edit.get("path", "")
        label = f"[{i}] {path}"
        if not path:
            print(f"{label}: FAIL — no 'path'", file=sys.stderr)
            ok = False
            continue

        try:
            original, etag = fetch_with_etag(client, path)
        except (VaultError, urllib.error.HTTPError) as e:
            print(f"{label}: FAIL — read: {e}", file=sys.stderr)
            ok = False
            continue

        text = original.decode("utf-8", "strict")

        try:
            updated, found = apply_edit(text, edit)
        except ValueError as e:
            print(f"{label}: FAIL — {e}", file=sys.stderr)
            ok = False
            continue

        expected = edit.get("count", 1)
        if found != expected:
            print(
                f"{label}: FAIL — expected {expected} occurrence(s), found {found}. "
                "Refusing to write (the assertion is the whole point).",
                file=sys.stderr,
            )
            ok = False
            continue

        if updated == text:
            print(f"{label}: SKIP — replacement is a no-op")
            continue

        new_bytes = updated.encode("utf-8")
        try:
            put_with_guard(client, path, new_bytes, etag)
        except VaultError as e:
            print(f"{label}: FAIL — write: {e}", file=sys.stderr)
            ok = False
            continue

        try:
            stored = client.download(path)
        except VaultError as e:
            print(f"{label}: FAIL — verify read: {e}", file=sys.stderr)
            ok = False
            continue

        if stored != new_bytes:
            print(f"{label}: FAIL — byte mismatch after write", file=sys.stderr)
            ok = False
            continue

        print(f"{label}: OK — {found} replacement(s), {len(new_bytes)}B byte-verified")

    print("VERIFY=OK" if ok else "VERIFY=FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

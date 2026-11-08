#!/usr/bin/env python3
"""Append a record to .meta/processed.json in the vault.

This is the ingester's step 8. It exists as a script because hand-rewriting processed.json
through an MCP tool is genuinely dangerous: the file is the skip list for every future run,
so one transcription error silently causes a re-ingest or, worse, makes an already-processed
file look unprocessed forever.

Usage:
    python3 append_processed.py < /tmp/record.json        # preferred
    python3 append_processed.py '{"file": "note.md", ...}'

Reading the record from stdin is preferred: a record containing an apostrophe breaks
single-quoted shell arguments (`bash: unexpected EOF while looking for matching "`), and the
failure looks nothing like the cause.

Idempotency: if a record with the same `file` value already exists, the script prints
`SKIP: <file> already in processed.json` and exits 0 without writing. Re-running the same
command is therefore both a no-op and a verification that the record landed.

Requires: MS_CLIENT_ID, MS_TENANT_ID, MS_REFRESH_TOKEN (from .env or the environment).
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

PROCESSED_PATH = ".meta/processed.json"


def find_scripts_dir() -> Path:
    """Locate the shared scripts/ directory holding _graph.py."""
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
        "error: cannot find scripts/_graph.py.\n"
        "  Run scripts/bootstrap.sh once, or set SECOND_BRAIN_HOME to the repo root."
    )


sys.path.insert(0, str(find_scripts_dir()))

from _graph import GraphClient, VaultError, load_env, require_onedrive_backend  # noqa: E402


def read_record() -> dict:
    """Read the record from argv[1] or stdin."""
    raw = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    raw = raw.strip()
    if not raw:
        raise SystemExit("error: no record given. Pass JSON as an argument or on stdin.")

    try:
        record = json.loads(raw)
    except json.JSONDecodeError as e:
        raise SystemExit(f"error: record is not valid JSON: {e}\nreceived: {raw[:200]!r}")

    if not isinstance(record, dict):
        raise SystemExit("error: record must be a JSON object")
    if not record.get("file"):
        raise SystemExit("error: record must have a 'file' key")

    record.setdefault("processed_at", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    return record


def main() -> int:
    load_env()
    require_onedrive_backend()
    record = read_record()

    try:
        client = GraphClient()
        data = client.download_json(PROCESSED_PATH)
    except VaultError as e:
        print(f"error: could not read {PROCESSED_PATH}: {e}", file=sys.stderr)
        return 1

    if not isinstance(data, dict):
        data = {"processed": []}
    data.setdefault("processed", [])

    existing = {r.get("file") for r in data["processed"] if isinstance(r, dict)}
    if record["file"] in existing:
        print(f"SKIP: {record['file']} already in processed.json")
        return 0

    data["processed"].append(record)

    try:
        etag = client.upload_json(PROCESSED_PATH, data)
    except VaultError as e:
        print(f"error: upload failed: {e}", file=sys.stderr)
        return 1

    print(f"UPLOAD_OK {etag or 'no-etag'}")
    print(f"records: {len(data['processed'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

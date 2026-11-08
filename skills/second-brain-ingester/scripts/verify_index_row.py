#!/usr/bin/env python3
"""Byte-verify rows appended to wiki/index.md.

Run this BEFORE appending (to confirm the page isn't already indexed) and AFTER appending
(to confirm the row landed on its own line). Both checks come from one raw re-download of the
file, because the MCP read path normalises trailing newlines and can't be trusted to answer
"did this row merge onto the previous line?".

Usage:
    python3 verify_index_row.py 'Page Name' ['Other Page' ...]

One argument per row you appended in that batch.

Output per row:
    row[Page Name] count=1
    row_own_line=True merge_marker=False

Then a final VERIFY=OK or VERIFY=FAIL, and a non-zero exit on failure.

Why this is a script and not a shell one-liner: the append-and-check cycle happens on every
ingest, and ad-hoc verifiers accumulate typos. There is exactly one implementation.

Requires: MS_CLIENT_ID, MS_TENANT_ID, MS_REFRESH_TOKEN.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

INDEX_PATH = "wiki/index.md"


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

from _graph import GraphClient, VaultError, load_env, require_onedrive_backend  # noqa: E402


def main() -> int:
    titles = [t for t in sys.argv[1:] if t.strip()]
    if not titles:
        print("usage: verify_index_row.py '<page name>' ['<page name>' ...]", file=sys.stderr)
        return 1

    load_env()
    require_onedrive_backend()
    try:
        client = GraphClient()
        raw = client.download(INDEX_PATH)
    except VaultError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    if not raw:
        print("error: index.md is empty", file=sys.stderr)
        return 1

    print(f"total_bytes={len(raw)}")
    print("tail_repr:")
    print(repr(raw[-600:].decode("utf-8", "replace")))
    ends_nl = raw.endswith(b"\n")
    print(f"ends_with_newline={ends_nl}")

    ok = True
    for title in titles:
        needle = title.encode()
        rows = [line for line in raw.split(b"\n") if needle in line]
        count = len(rows)
        print(f"row[{title}] count={count}")

        if count != 1:
            print(
                f"ROW_COUNT_FAIL {title}: expected exactly 1 matching row, found {count}",
                file=sys.stderr,
            )
            ok = False
            continue

        row = rows[0]
        stripped = row.strip()
        own_line = stripped.startswith(b"|") and not stripped.startswith(b"||")
        merged = (b"||" in row) or (b"| |" in row)
        print(f"row_own_line={own_line} merge_marker={merged}")

        if not own_line or merged:
            print(f"ROW_FORMAT_FAIL {title}: {row[:200]!r}", file=sys.stderr)
            ok = False

    print("VERIFY=OK" if ok else "VERIFY=FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

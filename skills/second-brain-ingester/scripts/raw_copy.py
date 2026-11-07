#!/usr/bin/env python3
"""Byte-verified paper-trail copy: sources/_inbox/<file> -> sources/written/<file>.

Ingester step 2a + 2b, as one script. For each file it downloads the raw bytes, uploads them
to sources/written/, downloads the result again, and byte-compares. Stricter than a
write-then-read-back through the MCP layer, because it compares raw bytes rather than
decoded text, and it refuses to upload anything that looks like a Graph error body.

Usage:
    python3 raw_copy.py "sources/_inbox/Note One.md" "sources/_inbox/Note Two.md"

Prints one line per file:
    <name>: <size>B put=<etag> verify=OK

Exits non-zero if any file failed or mismatched. The caller treats a non-OK verify as a hard
gate failure and must not proceed to wiki writes for that file.

Requires: MS_CLIENT_ID, MS_TENANT_ID, MS_REFRESH_TOKEN.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


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

from _graph import GraphClient, VaultError, load_env  # noqa: E402


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: raw_copy.py <sources/_inbox/file.md> [...]", file=sys.stderr)
        return 1

    load_env()
    try:
        client = GraphClient()
    except VaultError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    failures = 0
    for inbox_path in sys.argv[1:]:
        name = inbox_path.rsplit("/", 1)[-1]
        dest = f"sources/written/{name}"

        try:
            original = client.download(inbox_path)
        except VaultError as e:
            print(f"{name}: DOWNLOAD_FAILED — {e}", file=sys.stderr)
            failures += 1
            continue

        if not original:
            print(f"{name}: EMPTY_SOURCE — refusing to write an empty paper trail", file=sys.stderr)
            failures += 1
            continue

        try:
            etag = client.upload(dest, original)
        except VaultError as e:
            print(f"{name}: UPLOAD_FAILED — {e}", file=sys.stderr)
            failures += 1
            continue

        try:
            stored = client.download(dest)
        except VaultError as e:
            print(f"{name}: VERIFY_DOWNLOAD_FAILED — {e}", file=sys.stderr)
            failures += 1
            continue

        ok = stored == original
        status = "OK" if ok else "MISMATCH"
        print(f"{name}: {len(original)}B put={etag or 'no-etag'} verify={status}")
        if not ok:
            print(
                f"  stored={len(stored)}B original={len(original)}B — "
                "content drifted in transit; do not proceed",
                file=sys.stderr,
            )
            failures += 1

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

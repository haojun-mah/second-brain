#!/usr/bin/env python3
"""Label bare code fences in a spliced wiki page without touching the code.

Some notes write fenced code with no language identifier:

    ```
    def f(x): return x
    ```

Rule 9 protects the code body, but the page renders better with the fence labelled, and the
coding-interview template requires the identifier to match the actual language. Adding an
identifier to the opening fence is the single permitted edit to a spliced code block — this
script makes exactly that edit and nothing else.

It refuses to write if any non-fence line would change, and byte-verifies the stored page
afterwards.

Usage:
    python3 fence_fix.py <config.json>

Config keys:
    wiki      (required) vault path of the page to fix
    language  (required) fence language, e.g. "python" or "cpp"
    dry_run   (optional) if true, report what would change without writing

Prints VERIFY=OK on success. Reports `labeled=N` for the number of fences changed.
"""

from __future__ import annotations

import json
import os
import sys
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

from _graph import GraphClient, VaultError, load_env, require_onedrive_backend  # noqa: E402
from splice_wiki import label_bare_fences  # noqa: E402


def non_fence_lines(text: str) -> list[str]:
    """Every line that is not a fence delimiter — the part that must not change."""
    return [l for l in text.split("\n") if l.strip() != "```" and not l.startswith("```")]


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: fence_fix.py <config.json>", file=sys.stderr)
        return 1

    cfg_path = Path(sys.argv[1])
    if not cfg_path.is_file():
        print(f"error: no such config: {cfg_path}", file=sys.stderr)
        return 1

    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"error: config is not valid JSON: {e}", file=sys.stderr)
        return 1

    if not cfg.get("wiki") or not cfg.get("language"):
        print("error: config needs 'wiki' and 'language'", file=sys.stderr)
        return 1

    load_env()
    require_onedrive_backend()
    try:
        client = GraphClient()
        original = client.download_text(cfg["wiki"])
    except VaultError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    fixed, labelled = label_bare_fences(original, cfg["language"])

    if labelled == 0:
        print("labeled=0 — no bare non-empty fences found; nothing to do")
        print("VERIFY=OK")
        return 0

    # Safety guard: every non-fence line must be byte-identical.
    if non_fence_lines(original) != non_fence_lines(fixed):
        print(
            "error: the fence pass would alter non-fence lines — refusing to write.\n"
            "  This is a bug in the fence labelling, not in your note.",
            file=sys.stderr,
        )
        return 1

    if cfg.get("dry_run"):
        print(f"labeled={labelled} (dry run — not written)")
        return 0

    try:
        client.upload_text(cfg["wiki"], fixed)
    except VaultError as e:
        print(f"error: upload failed: {e}", file=sys.stderr)
        return 1

    try:
        stored = client.download_text(cfg["wiki"])
    except VaultError as e:
        print(f"error: verify download failed: {e}", file=sys.stderr)
        return 1

    print(f"labeled={labelled} stored_bytes={len(stored.encode())}")
    if stored != fixed:
        print("VERIFY=MISMATCH", file=sys.stderr)
        return 1

    print("VERIFY=OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())

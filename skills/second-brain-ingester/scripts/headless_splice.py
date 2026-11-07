#!/usr/bin/env python3
"""Splice a note that has no heading at all into a wiki page.

Some notes are just prose — no frontmatter, no `# Title`, nothing to anchor a slice on.
splice_wiki.py needs a marker and can't help. This treats the whole file (minus leading blank
lines) as the body, adds only the frontmatter and a `# Title` heading, and copies the rest
verbatim.

Optionally takes a `summary` line, for the note classes whose house format puts a one-line
authored summary between the heading and the body (e.g. interview write-ups). That summary is
the only authored prose this script inserts.

Usage:
    python3 headless_splice.py /tmp/config.json

Config keys:
    src            (required) vault path of the source note
    wiki           (required) vault path of the page to write
    title          (required) page title
    created        (required) "YYYY-MM-DD"
    updated        (optional) defaults to created
    sources        (required) list of post-move source paths
    type           (optional) default "concept"
    tags           (optional) list, default ["concept"]
    related        (optional) list of wikilinks
    summary        (optional) one authored line placed under the heading
    fence_language (optional) default "python"; set "" to disable fence labelling entirely
    strip_leading_blank (optional) default true

Prints VERIFY=OK on a byte-exact round trip.
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

from _graph import GraphClient, VaultError, load_env  # noqa: E402
from splice_wiki import build_frontmatter, label_bare_fences  # noqa: E402


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: headless_splice.py <config.json>", file=sys.stderr)
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

    for key in ("src", "wiki", "title", "created", "sources"):
        if not cfg.get(key):
            print(f"error: config is missing required key {key!r}", file=sys.stderr)
            return 1

    cfg.setdefault("type", "concept")
    cfg.setdefault("tags", ["concept"])

    load_env()
    try:
        client = GraphClient()
    except VaultError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    try:
        raw_bytes = client.download(cfg["src"])
    except VaultError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    body = raw_bytes.decode("utf-8", "strict")
    if cfg.get("strip_leading_blank", True):
        body = body.lstrip("\n")

    body, labelled = label_bare_fences(body, cfg.get("fence_language", "python"))

    # Compose: frontmatter, blank line, heading, optional summary, blank line, body verbatim.
    parts = [build_frontmatter(cfg), "", f"# {cfg['title']}", ""]
    summary = (cfg.get("summary") or "").strip()
    if summary:
        parts.extend([summary, ""])
    page = "\n".join(parts) + body
    if not page.endswith("\n"):
        page += "\n"

    try:
        client.upload_text(cfg["wiki"], page)
    except VaultError as e:
        print(f"error: upload failed: {e}", file=sys.stderr)
        return 1

    try:
        stored = client.download_text(cfg["wiki"])
    except VaultError as e:
        print(f"error: verify download failed: {e}", file=sys.stderr)
        return 1

    match = stored == page
    # The body must appear verbatim; if this fails, the splice drifted.
    body_present = body.strip() in stored

    print(
        f"source_bytes={len(raw_bytes)} body_bytes={len(body.encode())} "
        f"fences_labeled={labelled} stored_bytes={len(stored.encode())}"
    )
    print(f"body_match={body_present} full_page_match={match}")

    if not match:
        print("VERIFY=MISMATCH", file=sys.stderr)
        if not body_present:
            print("  the source body is not present verbatim in the stored page", file=sys.stderr)
        return 1

    print("VERIFY=OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())

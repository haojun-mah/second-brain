#!/usr/bin/env python3
"""Build a wiki page for a note whose Problem/Examples/Constraints live inside a screenshot.

A common shape for programming-problem notes: the body is an image embed, then the writer's
own approach and solution. There is no `## Approach` marker in the source for
splice_wiki.py to slice from, because the problem text was never typed — it's a picture.

So the problem text has to come from OCR, and the writer's part must be spliced verbatim. This
script does both: you author the header (frontmatter, title, embed, and the OCR-filled
Problem/Examples/Constraints sections), and it appends everything from `marker` to EOF
byte-for-byte.

Usage:
    python3 build_imageonly_wiki.py /tmp/config.json

Config keys:
    src           (required) vault path of the inbox note
    wiki          (required) vault path of the page to write
    title         (required)
    created       (required) "YYYY-MM-DD"
    updated       (optional)
    sources       (required) list of post-move source paths
    embed         (optional) image filename, e.g. "Pasted image 20260527203635.png"
    problem_line  (optional) e.g. "LeetCode 122 — Medium"
    problem       (optional) markdown of the problem statement (from OCR)
    examples      (optional) markdown of the examples
    constraints   (optional) markdown of the constraints
    marker        (optional) where the writer's content starts, default "## Approach"
    tags          (optional) default ["coding-interview", "leetcode"]
    type          (optional) default "coding-interview"
    fence_language(optional) default "python"
    summary       (optional) one authored line under the heading

Multi-line markdown values must be single JSON strings with \\n escapes. Write the config
with a file-writing tool, not shell arguments.

Prints VERIFY=OK on a byte-exact round trip of the whole page.
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
from splice_wiki import build_frontmatter, label_bare_fences  # noqa: E402


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: build_imageonly_wiki.py <config.json>", file=sys.stderr)
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

    cfg.setdefault("type", "coding-interview")
    cfg.setdefault("tags", ["coding-interview", "leetcode"])

    load_env()
    require_onedrive_backend()
    try:
        client = GraphClient()
    except VaultError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    # ---- 1. fetch the raw source ---------------------------------------------
    try:
        raw_bytes = client.download(cfg["src"])
    except VaultError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    raw = raw_bytes.decode("utf-8", "strict")

    # ---- 2. locate the splice point -----------------------------------------
    marker = cfg.get("marker") or "## Approach"
    count = raw.count(marker)
    if count == 0:
        raise SystemExit(
            f"error: MARKER_NOT_FOUND — {marker!r} does not appear in the source.\n"
            "  If the note has no such section, this isn't an image-only-problem shape.\n"
            "  Use splice_wiki.py (has a # heading) or headless_splice.py (plain prose)."
        )
    if count > 1:
        raise SystemExit(f"error: marker {marker!r} appears {count} times; be more specific")

    body = raw[raw.index(marker):]
    body, labelled = label_bare_fences(body, cfg.get("fence_language", "python"))

    # ---- 3. compose the header ----------------------------------------------
    parts: list[str] = [build_frontmatter(cfg), "", f"# {cfg['title']}", ""]

    summary = (cfg.get("summary") or "").strip()
    if summary:
        parts.extend([summary, ""])

    # Rule 8: the screenshot embed goes immediately after the # Title heading.
    embed = (cfg.get("embed") or "").strip()
    if embed:
        parts.extend([f"![[{embed}]]", ""])

    problem_line = (cfg.get("problem_line") or "").strip()
    if problem_line:
        parts.extend([problem_line, ""])

    for heading, key in (
        ("## Problem", "problem"),
        ("## Examples", "examples"),
        ("## Constraints", "constraints"),
    ):
        value = (cfg.get(key) or "").rstrip()
        if value:
            parts.extend([heading, "", value, ""])

    page = "\n".join(parts) + body
    if not page.endswith("\n"):
        page += "\n"

    # ---- 4. upload ----------------------------------------------------------
    try:
        client.upload_text(cfg["wiki"], page)
    except VaultError as e:
        print(f"error: upload failed: {e}", file=sys.stderr)
        return 1

    # ---- 5. verify ----------------------------------------------------------
    try:
        stored = client.download_text(cfg["wiki"])
    except VaultError as e:
        print(f"error: verify download failed: {e}", file=sys.stderr)
        return 1

    match = stored == page
    body_present = body.strip() in stored
    embed_present = (not embed) or (f"![[{embed}]]" in stored)

    print(
        f"source_bytes={len(raw_bytes)} body_bytes={len(body.encode())} "
        f"fences_labeled={labelled} stored_bytes={len(stored.encode())}"
    )
    print(f"embed_present={embed_present} body_match={body_present} full_page_match={match}")

    if not match:
        print("VERIFY=MISMATCH", file=sys.stderr)
        if not embed_present:
            print("  RULE 8 VIOLATION: the screenshot embed is missing", file=sys.stderr)
        if not body_present:
            print("  the writer's content is not present verbatim", file=sys.stderr)
        return 1

    print("VERIFY=OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())

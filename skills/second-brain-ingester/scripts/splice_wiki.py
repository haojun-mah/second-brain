#!/usr/bin/env python3
"""Splice a source note's body verbatim into a new wiki page.

The problem this solves: retyping a long note into a wiki page introduces silent transcription
drift. A renamed variable, a dropped bullet, a "fixed" typo — all violate the discipline rules,
and none of them are visible in a diff-free write.

So don't retype. Download the raw source bytes, slice out the body from a marker heading to
EOF, author only the frontmatter, and put the page back. Then re-download and byte-compare the
whole page. Zero drift is structurally guaranteed because you never handled the body text.

Usage:
    python3 splice_wiki.py /tmp/config.json

Config keys:
    src           (required) vault path of the source note, e.g. "sources/_inbox/Note.md"
    wiki          (required) vault path of the page to write, e.g. "wiki/concepts/Note.md"
    title         (required) page title; must match the filename without .md
    created       (required) "YYYY-MM-DD"
    updated       (optional) defaults to created
    tags          (optional) list, default []
    type          (optional) default "concept"
    sources       (required) list of post-move source paths to cite
    related       (optional) list of wikilink strings; omitted from frontmatter if absent
    marker        (optional) heading to splice from, default "# {title}"
    fence_language(optional) label bare opening fences with this language; "" disables

Write the config with a file-writing tool rather than inline shell arguments — multi-line
markdown values contain quotes and apostrophes that break shell quoting.

Prints VERIFY=OK on a byte-exact round trip, VERIFY=MISMATCH (exit 1) otherwise.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
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


# ---------------------------------------------------------------------------
# frontmatter
# ---------------------------------------------------------------------------
def yaml_str(value: str) -> str:
    """Quote a YAML scalar, escaping internal double quotes."""
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def yaml_list(values: list[str]) -> str:
    return "[" + ", ".join(yaml_str(v) for v in values) + "]"


def build_frontmatter(cfg: dict) -> str:
    """Emit frontmatter in the mandatory field order.

    Order is title -> created -> updated -> tags -> type -> sources -> related. `related` is
    omitted entirely when empty; writing `related: []` is a schema violation.
    """
    title = cfg["title"]
    created = cfg["created"]
    updated = cfg.get("updated") or created
    tags = cfg.get("tags") or []
    page_type = cfg.get("type") or "concept"
    sources = cfg.get("sources") or []
    related = cfg.get("related")

    if not sources:
        raise SystemExit("error: config must include at least one entry in 'sources'")
    if page_type not in {
        "concept", "person", "project", "question", "synthesis", "article", "coding-interview",
    }:
        raise SystemExit(f"error: invalid type {page_type!r}")

    lines = [
        "---",
        f"title: {yaml_str(title)}",
        f"created: {yaml_str(created)}",
        f"updated: {yaml_str(updated)}",
        f"tags: {yaml_list(tags)}",
        f"type: {page_type}",
        f"sources: {yaml_list(sources)}",
    ]
    if related:
        lines.append(f"related: {yaml_list(related)}")
    lines.append("---")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# fence handling
# ---------------------------------------------------------------------------
FENCE_OPEN = re.compile(r"^```\s*$")


def label_bare_fences(body: str, language: str) -> tuple[str, int]:
    """Label bare opening fences that enclose non-empty code.

    Adding a language identifier to a bare fence is explicitly permitted: Rule 9 protects the
    code *body*, and an unlabelled fence renders as plain text instead of highlighted code.
    Empty fences (stub blocks a note left for you to fill) stay bare.

    Math fences are left alone by passing language="" in the config.
    """
    if not language:
        return body, 0

    lines = body.split("\n")
    out: list[str] = []
    labelled = 0
    in_fence = False
    fence_start = -1

    for i, line in enumerate(lines):
        if FENCE_OPEN.match(line):
            if not in_fence:
                in_fence = True
                fence_start = len(out)
                out.append(line)
            else:
                # Closing fence: decide whether to label the opening one.
                interior = out[fence_start + 1:]
                if any(l.strip() for l in interior) and out[fence_start] == "```":
                    out[fence_start] = f"```{language}"
                    labelled += 1
                in_fence = False
                out.append(line)
        else:
            out.append(line)

    return "\n".join(out), labelled


def splice_body(raw: str, marker: str) -> str:
    """Return everything from `marker` to EOF. Marker must appear exactly once."""
    count = raw.count(marker)
    if count == 0:
        raise SystemExit(
            f"error: marker not found in source: {marker!r}\n"
            "  This note has no such heading. If it has no heading at all, use\n"
            "  headless_splice.py instead (whole file becomes the body)."
        )
    if count > 1:
        raise SystemExit(
            f"error: marker appears {count} times in source: {marker!r}\n"
            "  Pick a more specific marker so the splice point is unambiguous."
        )
    return raw[raw.index(marker):]


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: splice_wiki.py <config.json>", file=sys.stderr)
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

    marker = cfg.get("marker") or f"# {cfg['title']}"
    body = splice_body(raw, marker)

    # ---- 2. label bare fences (the only permitted edit to the body) ----------
    body, labelled = label_bare_fences(body, cfg.get("fence_language", "python"))

    # ---- 3. compose the page -------------------------------------------------
    page = build_frontmatter(cfg) + "\n" + body
    if not page.endswith("\n"):
        page += "\n"

    # ---- 4. upload -----------------------------------------------------------
    try:
        client.upload_text(cfg["wiki"], page)
    except VaultError as e:
        print(f"error: upload failed: {e}", file=sys.stderr)
        return 1

    # ---- 5. verify by re-downloading ----------------------------------------
    try:
        stored = client.download_text(cfg["wiki"])
    except VaultError as e:
        print(f"error: verify download failed: {e}", file=sys.stderr)
        return 1

    match = stored == page
    body_match = body.strip() in stored
    fm_match = stored.startswith(build_frontmatter(cfg))

    print(
        f"source_bytes={len(raw_bytes)} body_bytes={len(body.encode())} "
        f"fences_labeled={labelled} stored_bytes={len(stored.encode())}"
    )
    print(f"frontmatter_match={fm_match} body_match={body_match} full_page_match={match}")

    if not match:
        print("VERIFY=MISMATCH", file=sys.stderr)
        if not body_match:
            print("  the spliced body is not present in the stored page", file=sys.stderr)
        if not fm_match:
            print("  the frontmatter differs from what was sent", file=sys.stderr)
        return 1

    print("VERIFY=OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())

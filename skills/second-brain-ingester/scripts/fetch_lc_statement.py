#!/usr/bin/env python3
"""Fetch a canonical programming-problem statement as plain text.

Used by the ingester when OCR of a screenshot is ambiguous — particularly the constraint block,
where RapidOCR reliably loses superscripts and minus signs.

No API key, no browser automation. Tries a small set of static mirrors that serve the statement
as plain HTML, strips markup, and prints readable text.

Usage:
    python3 fetch_lc_statement.py 493
    python3 fetch_lc_statement.py 493 --json
    python3 fetch_lc_statement.py --url https://example.com/some/problem

Output (text mode): the statement, examples, and constraints, in reading order.
Output (--json): {"number": 493, "title": "...", "difficulty": "...", "statement": "...",
                  "examples": ["..."], "constraints": ["..."]}

Exits non-zero if every route fails — the caller should then keep the OCR text verbatim and mark
the cut-off rather than guessing.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import subprocess
import sys

# Static, curl-friendly mirrors. Tried in order. Each takes the problem number.
MIRRORS = [
    "https://leetcode.doocs.org/en/lc/{n}/",
    "https://leetcode.ca/all/{n}.html",
    "https://www.trysmudford.com/blog/leetcode-{n}/",
]

TIMEOUT = 25


def fetch(url: str) -> str:
    """Fetch a URL with curl (handles redirects and TLS without extra deps)."""
    proc = subprocess.run(
        [
            "curl", "-sL", "--max-time", str(TIMEOUT),
            "-A", "Mozilla/5.0 (compatible; second-brain-ingester/1.0)",
            url,
        ],
        capture_output=True,
        timeout=TIMEOUT + 5,
    )
    return proc.stdout.decode("utf-8", "replace")


def strip_html(raw: str) -> str:
    """Reduce an HTML page to readable plain text, preserving block boundaries."""
    # Drop script/style/nav/header/footer wholesale — they carry no statement content.
    text = re.sub(r"(?is)<(script|style|nav|header|footer|svg)[^>]*>.*?</\1>", " ", raw)
    # Block-level tags become newlines so paragraphs don't run together.
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|li|h[1-6]|pre|tr|table|section|article)>", "\n", text)
    text = re.sub(r"(?i)<li[^>]*>", "- ", text)
    # Everything else: drop the tag.
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    # Collapse runs of blank lines and trailing spaces.
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    return text.strip()


def find_section(text: str, heading: str, stop_headings: list[str]) -> str:
    """Extract the body of a named section, up to the next known heading."""
    pattern = re.compile(rf"(?im)^\s*#*\s*{re.escape(heading)}\s*:?\s*$")
    m = pattern.search(text)
    if not m:
        return ""
    start = m.end()
    end = len(text)
    for stop in stop_headings:
        sm = re.search(rf"(?im)^\s*#*\s*{re.escape(stop)}\s*:?\s*$", text[start:])
        if sm:
            end = min(end, start + sm.start())
    return text[start:end].strip()


def parse_statement(text: str, number: int | None) -> dict:
    """Pull the pieces we care about out of the stripped text."""
    lines = text.split("\n")

    # Title and difficulty usually appear near the top as "493. Reverse Pairs" / "Hard".
    title = ""
    difficulty = ""
    for line in lines[:40]:
        stripped = line.strip()
        if not title:
            m = re.match(r"^(\d+)\.\s+(.+)$", stripped)
            if m and (number is None or int(m.group(1)) == number):
                title = m.group(2).strip()
                continue
        if not difficulty and re.fullmatch(r"(?i)(easy|medium|hard)", stripped):
            difficulty = stripped.capitalize()

    constraints_raw = find_section(
        text, "Constraints", ["Follow up", "Follow-up", "Hints", "Companies", "Related Topics"]
    )
    constraints = [
        re.sub(r"^[-•*]\s*", "", l).strip()
        for l in constraints_raw.split("\n")
        if l.strip() and not re.fullmatch(r"[-•*]", l.strip())
    ]

    examples_raw = find_section(
        text, "Examples", ["Constraints", "Follow up", "Follow-up", "Hints"]
    ) or find_section(text, "Example 1", ["Constraints", "Follow up", "Follow-up"])

    statement = find_section(
        text, "Description", ["Example", "Examples", "Constraints", "Follow up"]
    )
    if not statement:
        # Many mirrors don't label the description — take everything before Example 1.
        m = re.search(r"(?im)^\s*#*\s*Example", text)
        statement = text[: m.start()].strip() if m else ""

    # Trim any leading navigation junk from the statement.
    if statement:
        parts = statement.split("\n")
        while parts and (
            len(parts[0]) < 4
            or re.fullmatch(r"(?i)(description|problem|leetcode \d+)", parts[0].strip())
        ):
            parts.pop(0)
        statement = "\n".join(parts).strip()

    return {
        "number": number,
        "title": title,
        "difficulty": difficulty,
        "statement": statement,
        "examples": [examples_raw] if examples_raw else [],
        "constraints": constraints,
    }


def looks_like_block_page(text: str) -> bool:
    """Detect bot-block / error pages so we don't return garbage as a statement."""
    low = text.lower()
    markers = [
        "just a moment",
        "enable javascript",
        "access denied",
        "are you a robot",
        "cloudflare",
        "403 forbidden",
        "404 not found",
        "page not found",
    ]
    return any(m in low for m in markers) or len(text.strip()) < 200


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("number", nargs="?", type=int, help="Problem number")
    parser.add_argument("--url", help="Fetch an arbitrary URL instead of a problem number")
    parser.add_argument("--json", action="store_true", help="Emit structured JSON")
    args = parser.parse_args()

    if not args.number and not args.url:
        parser.error("give a problem number or --url")

    urls = [args.url] if args.url else [m.format(n=args.number) for m in MIRRORS]

    text = ""
    used = ""
    for url in urls:
        print(f"trying {url}", file=sys.stderr)
        raw = fetch(url)
        candidate = strip_html(raw)
        if looks_like_block_page(candidate):
            print("  blocked or empty; next", file=sys.stderr)
            continue
        text = candidate
        used = url
        break

    if not text:
        print(
            "error: every route failed. Keep the OCR text verbatim and mark the cut-off\n"
            "       rather than guessing at the missing values.",
            file=sys.stderr,
        )
        return 1

    parsed = parse_statement(text, args.number)
    print(f"source: {used}", file=sys.stderr)

    if args.json:
        print(json.dumps(parsed, indent=2, ensure_ascii=False))
        return 0

    if parsed["title"]:
        header = f"{parsed['number']}. {parsed['title']}" if parsed["number"] else parsed["title"]
        if parsed["difficulty"]:
            header += f"  [{parsed['difficulty']}]"
        print(header)
        print("=" * len(header))
        print()

    if parsed["statement"]:
        print(parsed["statement"])
        print()

    for ex in parsed["examples"]:
        print("## Examples")
        print(ex)
        print()

    if parsed["constraints"]:
        print("## Constraints")
        for c in parsed["constraints"]:
            print(f"- {c}")
        print()

    if not any([parsed["statement"], parsed["examples"], parsed["constraints"]]):
        print("(could not parse sections — raw text follows)")
        print()
        print(text[:4000])

    return 0


if __name__ == "__main__":
    sys.exit(main())

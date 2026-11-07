#!/usr/bin/env python3
"""Scaffold a vault from vault-template/ — either locally or directly into OneDrive.

Two modes:

  Local (default)   Copy vault-template/ into a directory you name. Use this when you have a
                    OneDrive client syncing to disk and want the files to appear there.

  --upload          Create every folder and file in your OneDrive via the Graph API. Use this
                    when you have no local OneDrive client. Graph cannot create empty folders,
                    so each gets a .gitkeep placeholder.

Usage:
    python3 scripts/init_vault.py --local ~/OneDrive/Obsidian
    python3 scripts/init_vault.py --upload
    python3 scripts/init_vault.py --upload --dry-run
    python3 scripts/init_vault.py --upload --force     # overwrite existing files

The --upload mode is idempotent: existing files are skipped unless --force is given, so it is
safe to re-run after a failure partway through.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = REPO_ROOT / "vault-template"

# Directories that must exist even though git only tracks them via .gitkeep.
REQUIRED_DIRS = [
    "sources/_inbox",
    "sources/written",
    "sources/articles",
    "sources/coding",
    "sources/concepts",
    "sources/interview-experience",
    "sources/school-work",
    "sources/syntax",
    "sources/voice-notes",
    "sources/conversations",
    "sources/books",
    "sources/drafts",
    "sources/assets",
    "wiki/concepts",
    "wiki/people",
    "wiki/projects",
    "wiki/questions",
    "wiki/syntheses",
    "wiki/articles",
    "wiki/coding-interview",
    ".meta",
]


def copy_local(dest: Path, force: bool) -> int:
    import shutil

    if not TEMPLATE.is_dir():
        print(f"error: template not found at {TEMPLATE}", file=sys.stderr)
        return 1

    dest.mkdir(parents=True, exist_ok=True)
    created = 0
    skipped = 0

    for src in sorted(TEMPLATE.rglob("*")):
        rel = src.relative_to(TEMPLATE)
        target = dest / rel

        if src.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue

        if target.exists() and not force:
            skipped += 1
            continue

        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
        created += 1

    # Make sure every required directory exists even if the template lost a .gitkeep.
    for d in REQUIRED_DIRS:
        (dest / d).mkdir(parents=True, exist_ok=True)

    print(f"vault scaffolded at {dest}")
    print(f"  {created} files written, {skipped} already present (use --force to overwrite)")
    print()
    print("Next:")
    print("  1. Open the folder as a vault in Obsidian")
    print("  2. Settings -> Files & Links -> attachment folder = sources/assets")
    print("  3. Drop a file into sources/_inbox/ and run the ingester")
    return 0


def upload(dry_run: bool, force: bool) -> int:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from _graph import GraphClient, VaultError, load_env

    load_env()
    try:
        client = GraphClient()
        client.token()
    except VaultError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    print(f"uploading to vault root '{client.vault_root}' {'(dry run)' if dry_run else ''}")

    created = skipped = 0

    def ensure_dir(path: str) -> bool:
        """Create a directory by writing a placeholder file into it."""
        nonlocal created, skipped
        keep = f"{path}/.gitkeep"
        if not dry_run and client.exists(keep):
            skipped += 1
            return True
        if dry_run:
            print(f"  dir  {path}/")
            created += 1
            return True
        try:
            client.upload_text(keep, "")
            created += 1
            return True
        except VaultError as e:
            print(f"  FAIL dir {path}: {e}", file=sys.stderr)
            return False

    for d in REQUIRED_DIRS:
        ensure_dir(d)

    # Upload the template's real files (AGENTS.md, index.md, log.md, processed.json, examples).
    for src in sorted(TEMPLATE.rglob("*")):
        if not src.is_file():
            continue
        rel = src.relative_to(TEMPLATE).as_posix()
        if src.name == ".gitkeep":
            continue

        if not dry_run and client.exists(rel) and not force:
            print(f"  skip {rel} (exists)")
            skipped += 1
            continue

        if dry_run:
            print(f"  file {rel}")
            created += 1
            continue

        try:
            client.upload(rel, src.read_bytes())
            print(f"  file {rel}")
            created += 1
        except VaultError as e:
            print(f"  FAIL {rel}: {e}", file=sys.stderr)
            return 1

    print()
    if dry_run:
        print(f"dry run: would create {created} items")
    else:
        print(f"done: {created} items uploaded, {skipped} already present")
        print()
        print("The .gitkeep placeholders stay in your vault — Graph can't create empty")
        print("folders. Delete them once Obsidian has materialised the folders locally;")
        print("nothing depends on them.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local", metavar="DIR", help="Scaffold into a local directory")
    parser.add_argument("--upload", action="store_true", help="Scaffold directly into OneDrive")
    parser.add_argument("--dry-run", action="store_true", help="Show what would happen")
    parser.add_argument("--force", action="store_true", help="Overwrite existing files")
    args = parser.parse_args()

    if args.local and args.upload:
        parser.error("choose one of --local or --upload")
    if not args.local and not args.upload:
        parser.error("give --local <dir> or --upload")

    if args.local:
        return copy_local(Path(args.local).expanduser().resolve(), args.force)
    return upload(args.dry_run, args.force)


if __name__ == "__main__":
    sys.exit(main())

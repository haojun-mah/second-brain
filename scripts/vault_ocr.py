#!/usr/bin/env python3
"""Download an image from the vault and extract its text with local OCR.

The ingester uses this to read screenshots — a pasted LeetCode problem, a whiteboard photo,
a diagram — without sending the image to any external service. OCR runs entirely on your
machine via RapidOCR (an ONNX port of PaddleOCR's models).

Usage:
    python3 scripts/vault_ocr.py "sources/assets/Pasted image 20260527203635.png"
    python3 scripts/vault_ocr.py "sources/assets/diagram.png" --json
    python3 scripts/vault_ocr.py --local /path/to/image.png

Output: plain text to stdout, one line per detected text region, in reading order.
With --json: [{"text": "...", "score": 0.97, "box": [[x,y],...]}, ...]

Setup:
    python3 -m venv ~/.second-brain/ocrvenv
    ~/.second-brain/ocrvenv/bin/pip install rapidocr-onnxruntime

Then either run this script with that interpreter, or set SECOND_BRAIN_OCR_VENV so the
script can find it.

Requires: MS_CLIENT_ID, MS_TENANT_ID, MS_REFRESH_TOKEN for vault downloads (not needed with
--local).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def ensure_rapidocr() -> None:
    """Import RapidOCR, or explain precisely how to install it."""
    try:
        import rapidocr_onnxruntime  # noqa: F401
    except ImportError:
        venv = os.environ.get("SECOND_BRAIN_OCR_VENV", "").strip() or str(
            Path.home() / ".second-brain" / "ocrvenv"
        )
        venv_python = Path(venv) / "bin" / "python"
        if venv_python.is_file() and Path(sys.executable).resolve() != venv_python.resolve():
            print(f"re-executing under {venv_python}", file=sys.stderr)
            os.execv(str(venv_python), [str(venv_python), *sys.argv])

        print(
            "error: rapidocr-onnxruntime is not installed.\n\n"
            "  python3 -m venv ~/.second-brain/ocrvenv\n"
            "  ~/.second-brain/ocrvenv/bin/pip install rapidocr-onnxruntime\n\n"
            "Then re-run this script. If the venv lives elsewhere, set\n"
            "SECOND_BRAIN_OCR_VENV to its path.",
            file=sys.stderr,
        )
        sys.exit(1)


def run_ocr(image_path: str) -> list[dict]:
    """Run RapidOCR on a local file. Returns structured results."""
    from rapidocr_onnxruntime import RapidOCR

    engine = RapidOCR()
    result, _ = engine(image_path)
    if not result:
        return []

    out = []
    for box, text, score in result:
        out.append(
            {
                "text": text,
                "score": round(float(score), 4),
                "box": [[round(float(x), 1), round(float(y), 1)] for x, y in box],
            }
        )
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vault_path", nargs="?", help="Image path relative to the vault root")
    parser.add_argument("--local", help="OCR a local file instead of downloading from the vault")
    parser.add_argument("--json", action="store_true", help="Emit structured JSON instead of text")
    parser.add_argument("--min-score", type=float, default=0.0,
                        help="Drop regions below this confidence (default: keep all)")
    args = parser.parse_args()

    if not args.vault_path and not args.local:
        parser.error("give a vault path or --local <file>")

    ensure_rapidocr()

    tmp_path = None
    if args.local:
        image_path = str(Path(args.local).expanduser())
        if not Path(image_path).is_file():
            print(f"error: no such file: {image_path}", file=sys.stderr)
            return 1
    else:
        from _graph import GraphClient, VaultError, load_env

        load_env()
        try:
            client = GraphClient()
            print(f"downloading {args.vault_path} ...", file=sys.stderr)
            data = client.download(args.vault_path)
        except VaultError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1

        suffix = Path(args.vault_path).suffix or ".png"
        fd, tmp_path = tempfile.mkstemp(suffix=suffix)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        image_path = tmp_path
        print(f"downloaded {len(data)} bytes", file=sys.stderr)

    try:
        regions = run_ocr(image_path)
    except Exception as e:  # noqa: BLE001 - surface any OCR failure plainly
        print(f"error: OCR failed: {e}", file=sys.stderr)
        return 1
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    if args.min_score > 0:
        regions = [r for r in regions if r["score"] >= args.min_score]

    if args.json:
        print(json.dumps(regions, indent=2, ensure_ascii=False))
    else:
        if not regions:
            print("(no text detected)")
        else:
            for r in regions:
                print(r["text"])

    return 0


if __name__ == "__main__":
    sys.exit(main())

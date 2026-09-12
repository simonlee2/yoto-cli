#!/usr/bin/env python3
"""Upload audio files to a Yoto MYO card from a JSON manifest.

Expected manifest rows can use any of these keys:
- title / clean_title / yoto_title
- file / local_file / path

Audio files are intentionally not stored in this repo; paths normally point to a
local download directory.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
try:
    from .yoto_cli import run_yoto
except ImportError:  # direct script execution: python scripts/upload_audio_manifest.py
    from yoto_cli import run_yoto

TITLE_KEYS = ("title", "clean_title", "yoto_title", "name")
FILE_KEYS = ("file", "local_file", "path", "audio_file")


def pick(row: dict, keys: tuple[str, ...]) -> str | None:
    for key in keys:
        val = row.get(key)
        if val:
            return str(val)
    return None


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("card_id")
    p.add_argument("manifest", type=pathlib.Path)
    p.add_argument("--base-dir", type=pathlib.Path, help="resolve relative audio paths against this directory")
    p.add_argument("--dry-run", action="store_true")
    ns = p.parse_args()

    rows = json.loads(ns.manifest.read_text())
    if not isinstance(rows, list):
        raise SystemExit("manifest must be a JSON list")

    uploaded = []
    for i, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            raise SystemExit(f"row {i} must be an object")
        title = pick(row, TITLE_KEYS)
        file_s = pick(row, FILE_KEYS)
        if not title or not file_s:
            raise SystemExit(f"row {i} missing title/file: {row}")
        path = pathlib.Path(file_s)
        if not path.is_absolute() and ns.base_dir:
            path = ns.base_dir / path
        path = path.expanduser().resolve()
        if not path.is_file():
            raise SystemExit(f"missing audio file: {path}")
        if path.suffix.lower() not in {".mp3", ".m4a"}:
            raise SystemExit(f"unsupported audio extension for row {i}: {path.suffix or '<none>'}")
        print(f"{i:02d}. {title} <- {path}")
        if not ns.dry_run:
            out = run_yoto(["entry", "add", ns.card_id, title, "--file", str(path), "--json"], json_output=True)
            uploaded.append({"title": title, "file": str(path), "result": out})
            print(json.dumps(out, ensure_ascii=False))

    if not ns.dry_run:
        print(json.dumps({"uploaded": len(uploaded)}, indent=2))


if __name__ == "__main__":
    main()

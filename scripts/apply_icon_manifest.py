#!/usr/bin/env python3
"""Apply a manifest of Yoto icon assignments to a MYO card.

Manifest rows must contain either:
- {"idx": 42, "mediaId": "..."}         # 1-based chapter index
- {"index": 41, "icon16x16": "yoto:#..."} # 0-based entry index

This script uses the real Yoto CLI update endpoint via @lizozom/yoto and
verifies the resulting card with `playlist show`.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
try:
    from .yoto_cli import run_yoto
except ImportError:  # direct script execution: python scripts/apply_icon_manifest.py
    from yoto_cli import run_yoto


def icon_from_row(row: dict) -> str:
    if row.get("icon16x16"):
        return str(row["icon16x16"])
    if row.get("mediaId"):
        return "yoto:#" + str(row["mediaId"]).removeprefix("yoto:#")
    raise ValueError(f"row has no icon16x16/mediaId: {row}")


def index_from_row(row: dict) -> int:
    if "index" in row:
        return int(row["index"])
    if "idx" in row:
        return int(row["idx"]) - 1
    raise ValueError(f"row has no index/idx: {row}")


def build_plan(rows: list[object]) -> list[dict[str, object]]:
    plan: list[dict[str, object]] = []
    seen_indexes: set[int] = set()
    for position, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            raise ValueError(f"row {position} must be an object")
        index = index_from_row(row)
        if index < 0:
            raise ValueError(f"row {position} resolves to a negative entry index")
        if index in seen_indexes:
            raise ValueError(f"row {position} duplicates entry index {index}")
        seen_indexes.add(index)
        plan.append(
            {
                "index": index,
                "icon": icon_from_row(row),
                "label": row.get("concept") or row.get("title") or "",
            }
        )
    return plan


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("card_id")
    p.add_argument("manifest", type=pathlib.Path)
    p.add_argument("--dry-run", action="store_true")
    ns = p.parse_args()

    rows = json.loads(ns.manifest.read_text())
    if not isinstance(rows, list):
        raise SystemExit("manifest must be a JSON list")

    try:
        plan = build_plan(rows)
    except ValueError as error:
        raise SystemExit(str(error)) from error

    for item in plan:
        print(f"{item['index']}: {item['icon']} {item['label']}")

    if ns.dry_run:
        return

    before = run_yoto(["playlist", "show", ns.card_id, "--json"], json_output=True)
    chapters_before = before.get("content", {}).get("chapters", [])
    invalid_indexes = [item["index"] for item in plan if item["index"] >= len(chapters_before)]
    if invalid_indexes:
        raise SystemExit(
            f"entry indexes outside current card range 0..{len(chapters_before) - 1}: {invalid_indexes}"
        )

    for item in plan:
        print(
            run_yoto(
                ["entry", "update", ns.card_id, str(item["index"]), "--icon", str(item["icon"])]
            ).rstrip()
        )

    card = run_yoto(["playlist", "show", ns.card_id, "--json"], json_output=True)
    chapters = card.get("content", {}).get("chapters", [])
    failures = []
    for item in plan:
        idx = int(item["index"])
        expected = str(item["icon"])
        ch = chapters[idx]
        got_ch = ch.get("display", {}).get("icon16x16")
        tracks = ch.get("tracks") or []
        got_track = tracks[0].get("display", {}).get("icon16x16") if tracks else None
        if got_ch != expected or got_track != expected:
            failures.append({"index": idx, "expected": expected, "chapter": got_ch, "track": got_track})
    if failures:
        print(json.dumps({"verification_failed": failures}, indent=2), file=sys.stderr)
        raise SystemExit(2)
    print(json.dumps({"ok": True, "verified": len(plan)}, indent=2))


if __name__ == "__main__":
    main()

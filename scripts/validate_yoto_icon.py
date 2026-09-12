#!/usr/bin/env python3
"""Validate a Yoto icon and render a nearest-neighbor preview on black."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image


def validate_icon(source: Path, preview: Path) -> dict[str, object]:
    with Image.open(source) as opened:
        original_mode = opened.mode
        original_size = opened.size
        image = opened.convert("RGBA")

    errors: list[str] = []
    warnings: list[str] = []

    if original_size != (16, 16):
        errors.append(f"size is {original_size}, expected (16, 16)")
    if original_mode != "RGBA":
        errors.append(f"mode is {original_mode}, expected RGBA")

    pixels = list(image.getdata())
    visible = [pixel for pixel in pixels if pixel[3] > 0]
    transparent = sum(1 for pixel in pixels if pixel[3] == 0)
    pure_black = sum(1 for pixel in visible if pixel[:3] == (0, 0, 0))

    if not visible:
        errors.append("icon has no visible pixels")
    if transparent == 0:
        errors.append("icon has no transparent background pixels")
    if pure_black:
        errors.append(f"icon has {pure_black} visible pure-black pixels")

    unique_colors = len(set(visible))
    if unique_colors > 8:
        warnings.append(f"icon uses {unique_colors} visible RGBA colors; review at display scale")

    edge_points = {
        *((x, 0) for x in range(16)),
        *((x, 15) for x in range(16)),
        *((0, y) for y in range(16)),
        *((15, y) for y in range(16)),
    }
    edge_visible = sum(image.getpixel(point)[3] > 0 for point in edge_points)
    if edge_visible:
        warnings.append(f"{edge_visible} visible edge pixels; verify the subject is not clipped")

    preview.parent.mkdir(parents=True, exist_ok=True)
    background = Image.new("RGBA", (256, 256), (0, 0, 0, 255))
    background.alpha_composite(image.resize((256, 256), Image.Resampling.NEAREST))
    background.convert("RGB").save(preview)

    return {
        "ok": not errors,
        "icon": str(source),
        "preview": str(preview),
        "size": list(original_size),
        "mode": original_mode,
        "visible_pixels": len(visible),
        "transparent_pixels": transparent,
        "unique_visible_colors": unique_colors,
        "errors": errors,
        "warnings": warnings,
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("icon", type=Path)
    parser.add_argument("--preview", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    if not args.icon.is_file():
        parser.error(f"icon does not exist: {args.icon}")

    preview = args.preview or args.icon.with_name(f"{args.icon.stem}_preview_black_256.png")
    result = validate_icon(args.icon, preview)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"icon: {result['icon']}")
        print(f"preview: {result['preview']}")
        for warning in result["warnings"]:
            print(f"WARNING: {warning}")
        for error in result["errors"]:
            print(f"ERROR: {error}")

    if not result["ok"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Generate deterministic 16x16 Yoto-safe pixel icons from track concepts.

Process for each track:
1. Choose a simple noun/symbol from the title (bus, shark, duck, elephant, etc.).
2. Draw on a 16x16 canvas with <= ~8 flat colors, transparent background.
3. Save native 16x16 PNG for Yoto.
4. Save 256x256 nearest-neighbor preview for human review.
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path('generated-icons')
OUT.mkdir(parents=True, exist_ok=True)

PALETTE = {
    'transparent': (0, 0, 0, 0),
    'outline': (42, 36, 48, 255),
    'yellow': (255, 204, 68, 255),
    'yellow_dark': (219, 145, 45, 255),
    'blue': (89, 173, 246, 255),
    'blue_dark': (44, 107, 181, 255),
    'white': (250, 250, 245, 255),
    'gray': (92, 92, 104, 255),
}

def px(draw, xy, fill):
    draw.point(xy, fill=fill)

def rect(draw, xy, fill):
    draw.rectangle(xy, fill=fill)

def make_bus_icon():
    im = Image.new('RGBA', (16, 16), PALETTE['transparent'])
    d = ImageDraw.Draw(im)

    # Side-view school bus: exaggerated wheels + segmented windows read better at 16px.
    # Outer silhouette
    rect(d, (1, 5, 14, 11), PALETTE['outline'])
    rect(d, (2, 4, 13, 10), PALETTE['yellow'])
    rect(d, (2, 9, 13, 11), PALETTE['yellow_dark'])

    # Front nose / bumper
    px(d, (14, 8), PALETTE['yellow'])
    px(d, (14, 9), PALETTE['white'])
    px(d, (14, 10), PALETTE['outline'])

    # Three separate windows with yellow dividers.
    rect(d, (3, 5, 5, 7), PALETTE['blue'])
    rect(d, (7, 5, 9, 7), PALETTE['blue'])
    rect(d, (11, 5, 12, 7), PALETTE['blue'])
    px(d, (3, 5), PALETTE['white'])
    px(d, (7, 5), PALETTE['white'])
    px(d, (11, 5), PALETTE['white'])

    # Door line and small handle.
    rect(d, (11, 8, 12, 10), PALETTE['blue_dark'])
    px(d, (12, 9), PALETTE['yellow'])

    # Wheels, pushed outside body for readability.
    rect(d, (3, 11, 5, 13), PALETTE['outline'])
    rect(d, (10, 11, 12, 13), PALETTE['outline'])
    px(d, (4, 12), PALETTE['gray'])
    px(d, (11, 12), PALETTE['gray'])

    # Road baseline helps communicate vehicle motion but remains non-distracting.
    rect(d, (2, 14, 13, 14), PALETTE['gray'])
    return im

def save_icon(name, im):
    icon_path = OUT / f'{name}_16.png'
    preview_path = OUT / f'{name}_preview_256.png'
    im.save(icon_path)
    im.resize((256, 256), Image.Resampling.NEAREST).save(preview_path)
    return icon_path, preview_path

if __name__ == '__main__':
    icon, preview = save_icon('01_bus', make_bus_icon())
    print(icon)
    print(preview)

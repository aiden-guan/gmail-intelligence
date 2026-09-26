"""Derive the extension icons from the idle pigeon in the sprite sheet.

Chrome and the Chrome Web Store need real 16, 48 and 128 px icons. They are
cut from the first (idle) cell of public/brand/pigeon-sprites.png, trimmed to
the bird, centred on a transparent square and downscaled.

Usage: python3 scripts/make-icons.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SHEET = ROOT / 'public/brand/pigeon-sprites.png'
OUT = ROOT / 'public/icons'
CELL_W, CELL_H = 320, 256  # Matches scripts/pack-pigeon.py
MARGIN = 0.06  # Transparent border as a fraction of the icon size.

cell = Image.open(SHEET).convert('RGBA').crop((0, 0, CELL_W, CELL_H))
bird = cell.crop(cell.getchannel('A').point(lambda a: 255 if a > 24 else 0).getbbox())
side = int(max(bird.size) * (1 + 2 * MARGIN))
square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
square.paste(bird, ((side - bird.width) // 2, (side - bird.height) // 2), bird)

for size in (16, 48, 128):
    square.resize((size, size), Image.LANCZOS).save(OUT / f'icon{size}.png', optimize=True)
    print(f'wrote icons/icon{size}.png')

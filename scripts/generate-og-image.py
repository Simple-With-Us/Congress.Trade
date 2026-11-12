#!/usr/bin/env python3
"""DEPRECATED — superseded by scripts/render-og-cards.sh.

This produces the pre-2026-08-10 card design (silver plate, stacked
CONGRESS / TRADE, no product graphic) and writes it straight over
app/public/og-image.png, so running it now silently REVERTS the current
social cards. It also only ever generated the default card, never the
Trends / Company / Politician variants.

Use instead:
  scripts/render-og-cards.sh              # all four cards -> app/public/
  scripts/render-og-cards.sh /tmp/proof   # render to a scratch dir first

Kept only as a record of the old Pillow pipeline.

Requires: Pillow, and a Zilla Slab Bold TTF (or pass --font).

Usage (from repo root):
  python3 scripts/generate-og-image.py --font /path/to/ZillaSlab-Bold.ttf
"""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EAGLE = ROOT / "docs/brand/assets/source-owner-mark-hires-2026-08-09.png"
DEFAULT_OUT = ROOT / "app/public/og-image.png"
DEFAULT_MASTER = ROOT / "docs/brand/assets/og-image-light-1200x630.png"
TAGLINE = "STOCK Act disclosures from the House, Senate, and Executive Branch"
W, H = 1200, 630


def text_size(font: ImageFont.FreeTypeFont, text: str) -> tuple[int, int]:
    b = font.getbbox(text)
    return b[2] - b[0], b[3] - b[1]


def build(font_path: Path, eagle_path: Path) -> Image.Image:
    bg_center = (243, 243, 245)
    bg_edge = (228, 228, 232)
    canvas = Image.new("RGB", (W, H), bg_center)
    vignette = Image.new("RGB", (W, H), bg_edge)
    mask = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse((-100, -120, W + 100, H + 120), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(90))
    canvas = Image.composite(canvas, vignette, mask)

    eagle = Image.open(eagle_path).convert("RGBA")
    eagle = eagle.crop(eagle.getbbox())
    eagle_h = 390
    eagle = eagle.resize(
        (int(eagle.width * eagle_h / eagle.height), eagle_h),
        Image.Resampling.LANCZOS,
    )
    eagle_w, eagle_h = eagle.size

    word_font = ImageFont.truetype(str(font_path), 100)
    # Prefer a clean sans for the tagline; fall back to Zilla.
    tagline_font = word_font
    for cand in (
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        if Path(cand).exists():
            tagline_font = ImageFont.truetype(cand, 30)
            break
    else:
        tagline_font = ImageFont.truetype(str(font_path), 28)

    cw, ch = text_size(word_font, "CONGRESS")
    tw, th = text_size(word_font, "TRADE")
    line_gap = 6
    word_block_w = max(cw, tw)
    word_block_h = ch + line_gap + th
    tlw, tlh = text_size(tagline_font, TAGLINE)

    pad_between = 48
    content_w = eagle_w + pad_between + word_block_w
    content_h = max(eagle_h, word_block_h)
    gap_tag = 44
    total_h = content_h + gap_tag + tlh
    origin_y = (H - total_h) // 2 - 6
    origin_x = (W - content_w) // 2

    canvas_rgba = canvas.convert("RGBA")
    canvas_rgba.alpha_composite(
        eagle, (origin_x, origin_y + (content_h - eagle_h) // 2)
    )

    text_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    td = ImageDraw.Draw(text_layer)
    text_color = (14, 18, 28, 255)
    word_x = origin_x + eagle_w + pad_between
    word_y = origin_y + (content_h - word_block_h) // 2
    td.text((word_x, word_y), "CONGRESS", font=word_font, fill=text_color)
    td.text((word_x, word_y + ch + line_gap), "TRADE", font=word_font, fill=text_color)
    td.text(
        ((W - tlw) // 2, origin_y + content_h + gap_tag),
        TAGLINE,
        font=tagline_font,
        fill=(55, 66, 86, 255),
    )
    return Image.alpha_composite(canvas_rgba, text_layer).convert("RGB")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--font", type=Path, required=True, help="Path to Zilla Slab Bold TTF")
    p.add_argument("--eagle", type=Path, default=DEFAULT_EAGLE)
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    p.add_argument("--master", type=Path, default=DEFAULT_MASTER)
    args = p.parse_args()
    img = build(args.font, args.eagle)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    img.save(args.out, "PNG", optimize=True)
    if args.master:
        args.master.parent.mkdir(parents=True, exist_ok=True)
        img.save(args.master, "PNG", optimize=True)
    print(f"wrote {args.out} ({args.out.stat().st_size} bytes)")
    if args.master:
        print(f"wrote {args.master}")


if __name__ == "__main__":
    main()

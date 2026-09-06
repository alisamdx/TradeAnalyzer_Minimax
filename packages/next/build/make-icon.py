# -*- coding: utf-8 -*-
"""Generates TradeAnalyzer 2's app icon — `icon.ico` plus a `icon.png` for dev.

    python packages/next/build/make-icon.py

The mark is a candlestick whose body is punched through with binary digits:
market data made of bits. Amber on near-black, chosen so it can never be
mistaken for the existing app (which uses the default Electron icon) in a
taskbar.

**Each size is drawn, not scaled.** A 16px icon downsampled from a 256px drawing
is mush; the digits in particular disappear into grey. So detail is chosen from
the target size — digits appear at 48px and above, three of them only at 96px
and above, and the body/wick proportions thicken as the icon shrinks so the
silhouette still reads as a candlestick rather than a lozenge. Below 48px the
mark is a clean candle and nothing else, which is the right thing to see at
taskbar size.

Committed as a script rather than only as its output so the icon can be
regenerated — a binary asset with no source is a dead end the first time
anything about it needs to change.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

FONT_BOLD = r"C:\Windows\Fonts\consolab.ttf"

INK_TOP    = (20, 27, 37, 255)     # tile gradient, top
INK_BOTTOM = (10, 14, 20, 255)     # tile gradient, bottom
AMBER      = (245, 176, 66, 255)

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
SUPERSAMPLE = 4


def _tile(S: int) -> Image.Image:
    """Rounded square with a subtle vertical gradient."""
    grad = Image.new("RGBA", (1, S))
    for y in range(S):
        t = y / max(1, S - 1)
        grad.putpixel((0, y), tuple(int(INK_TOP[i] + (INK_BOTTOM[i] - INK_TOP[i]) * t) for i in range(4)))
    grad = grad.resize((S, S))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def _fit(text: str, target_px: float) -> ImageFont.FreeTypeFont:
    """Largest font size whose rendered height fits `target_px`."""
    lo, hi, best = 4, max(8, int(target_px * 3)), 4
    while lo <= hi:
        mid = (lo + hi) // 2
        box = ImageFont.truetype(FONT_BOLD, mid).getbbox(text)
        if (box[3] - box[1]) <= target_px:
            best, lo = mid, mid + 1
        else:
            hi = mid - 1
    return ImageFont.truetype(FONT_BOLD, best)


def _centred(d, text, font, cx, cy, fill):
    b = font.getbbox(text)
    d.text((cx - (b[2] - b[0]) / 2 - b[0], cy - (b[3] - b[1]) / 2 - b[1]), text, font=font, fill=fill)


def render(size: int) -> Image.Image:
    S = size * SUPERSAMPLE
    img = _tile(S)
    d = ImageDraw.Draw(img)
    cx = S / 2

    # The candle thickens as the icon shrinks: at 256 a slim body reads as a
    # candlestick, at 16 the same proportions read as a stick.
    if size >= 96:
        body_w, wick_w, top, bot = 0.36, 0.030, 0.27, 0.73
    elif size >= 48:
        body_w, wick_w, top, bot = 0.40, 0.038, 0.26, 0.74
    else:
        body_w, wick_w, top, bot = 0.46, 0.055, 0.25, 0.75

    d.rounded_rectangle([cx - S * wick_w, S * 0.12, cx + S * wick_w, S * 0.88],
                        radius=S * wick_w, fill=AMBER)
    d.rounded_rectangle([cx - S * body_w / 2, S * top, cx + S * body_w / 2, S * bot],
                        radius=S * 0.07, fill=AMBER)

    if size >= 48:
        digits = ["10", "01", "11"] if size >= 96 else ["10", "01"]
        inset = (bot - top) * 0.04
        y0, y1 = S * (top + inset), S * (bot - inset)
        cell = (y1 - y0) / len(digits)
        font = _fit("0", cell * 0.68)
        for i, text in enumerate(digits):
            _centred(d, text, font, cx, y0 + (i + 0.5) * cell, INK_BOTTOM)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    here = Path(__file__).resolve().parent
    frames = [render(s) for s in ICO_SIZES]

    # Pillow's ICO writer resamples from one image; passing the pre-rendered
    # frames via append_images keeps each size the drawing made for it.
    largest = frames[-1]
    largest.save(here / "icon.ico", format="ICO",
                 sizes=[(s, s) for s in ICO_SIZES],
                 append_images=frames[:-1])
    largest.save(here / "icon.png", format="PNG")
    print(f"wrote {here / 'icon.ico'} ({', '.join(str(s) for s in ICO_SIZES)}) and icon.png")


if __name__ == "__main__":
    main()

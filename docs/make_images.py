#!/usr/bin/env python3
"""Build the README graphics from raw app screenshots (390×844 CSS px, device scale 2).

    python3 docs/make_images.py <screenshot-dir>

Expects s-choose.png, s-detail.png, s-stores.png, s-menu.png, s-shop.png, s-prep.png, s-feedback.png
in <screenshot-dir>. Writes WebP files to docs/img/ (+ a PNG social preview for GitHub settings).
Needs Pillow. Fonts (Fraunces, Inter — SIL OFL) are downloaded to docs/.fonts on first run.
"""
import sys
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

DOCS = Path(__file__).resolve().parent
OUT = DOCS / "img"
FONTS = DOCS / ".fonts"
FONT_URLS = {
    "Fraunces.ttf": "https://github.com/google/fonts/raw/main/ofl/fraunces/Fraunces%5BSOFT%2CWONK%2Copsz%2Cwght%5D.ttf",
    "Inter.ttf": "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf",
}
GREEN, DEEP, LIME, CREAM, INK, PUMPKIN = "#0f3d2e", "#0a2b20", "#8cc63f", "#f7f3ea", "#1d2a24", "#e8792b"


def font(name: str, size: int, weight: str) -> ImageFont.FreeTypeFont:
    path = FONTS / name
    if not path.exists():
        FONTS.mkdir(exist_ok=True)
        urllib.request.urlretrieve(FONT_URLS[name], path)
    f = ImageFont.truetype(str(path), size)
    f.set_variation_by_name(weight)
    return f


def rounded(im: Image.Image, r: int) -> Image.Image:
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, *im.size), r, fill=255)
    out = Image.new("RGBA", im.size)
    out.paste(im, (0, 0), mask)
    return out


def phone(shot: Path, width: int) -> Image.Image:
    """Screenshot inside a simple modern phone frame, with soft shadow (RGBA)."""
    raw = Image.open(shot).convert("RGB")
    # add a status-bar strip on top so the camera island never covers app content
    bar = raw.width // 9
    scr = Image.new("RGB", (raw.width, raw.height + bar), raw.getpixel((4, 4)))
    scr.paste(raw, (0, bar))
    sw = width - width // 14
    scr = scr.resize((sw, round(scr.height * sw / scr.width)), Image.LANCZOS)
    bezel = (width - sw) // 2
    body = Image.new("RGBA", (width, scr.height + 2 * bezel), (0, 0, 0, 0))
    d = ImageDraw.Draw(body, "RGBA")
    d.rounded_rectangle((0, 0, body.width - 1, body.height - 1), width // 7, fill=INK)
    d.rounded_rectangle((2, 2, body.width - 3, body.height - 3), width // 7 - 2, outline="#3a4a42", width=2)
    body.alpha_composite(rounded(scr, width // 8), (bezel, bezel))
    island = width // 4
    d.rounded_rectangle(((width - island) // 2, bezel + 10, (width + island) // 2, bezel + 10 + width // 17), 99, fill=INK)
    pad = width // 6
    out = Image.new("RGBA", (body.width + 2 * pad, body.height + 2 * pad), (0, 0, 0, 0))
    shadow = Image.new("RGBA", out.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((pad, pad + pad // 3, pad + body.width, pad + body.height + pad // 3),
                                             width // 7, fill=(0, 0, 0, 110))
    out.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(pad // 2.5)))
    out.alpha_composite(body, (pad, pad))
    return out


def background(w: int, h: int) -> Image.Image:
    bg = Image.new("RGBA", (w, h), GREEN)
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse((int(w * .55), -int(h * .6), int(w * 1.4), int(h * .9)), fill=(140, 198, 63, 70))
    g.ellipse((-int(w * .3), int(h * .45), int(w * .45), int(h * 1.6)), fill=(232, 121, 43, 45))
    bg.alpha_composite(glow.filter(ImageFilter.GaussianBlur(h // 5)))
    bg = bg.convert("RGB")  # draw on RGB with an RGBA pen = real alpha blending
    dots = ImageDraw.Draw(bg, "RGBA")
    for x in range(0, w, 28):
        for y in range(0, h, 28):
            dots.ellipse((x, y, x + 2, y + 2), fill=(255, 255, 255, 14))
    return bg


def pill(d: ImageDraw.ImageDraw, xy, text, f, fill, color):
    x, y = xy
    tw = d.textlength(text, font=f)
    h = f.size + 18
    d.rounded_rectangle((x, y, x + tw + 32, y + h), h // 2, fill=fill)
    d.text((x + 16, y + h / 2), text, font=f, fill=color, anchor="lm")
    return x + tw + 32 + 10


def banner(shots: Path, w=1600, h=820) -> Image.Image:
    bg = background(w, h)
    d = ImageDraw.Draw(bg, "RGBA")
    x0 = 96
    d.text((x0, 150), "MEAL PREP, PLANNED WITH CLAUDE", font=font("Inter.ttf", 24, "Bold"), fill=LIME)
    title = font("Fraunces.ttf", 112, "Black")
    d.text((x0, 196), "Meal Prep", font=title, fill=CREAM)
    d.text((x0, 316), "Studio", font=title, fill=LIME)
    body = font("Inter.ttf", 32, "Regular")
    for i, line in enumerate(["Pick your week like a meal kit.", "Claude plans it for your household,",
                              "priced at the supermarkets near you."]):
        d.text((x0, 470 + i * 46), line, font=body, fill=(247, 243, 234, 225))
    f = font("Inter.ttf", 21, "SemiBold")
    x = x0
    for t in ("Per-person portions", "Real macros", "Store comparison"):
        x = pill(d, (x, 640), t, f, (255, 255, 255, 38), CREAM)
    ph = 330
    back_l, back_r, front = phone(shots / "s-menu.png", ph), phone(shots / "s-stores.png", ph), phone(shots / "s-choose.png", ph + 30)
    bx = 900
    for im, pos in ((back_l.rotate(6, Image.BICUBIC, expand=True), (bx - 110, 90)),
                    (back_r.rotate(-6, Image.BICUBIC, expand=True), (bx + 250, 90)), (front, (bx + 50, 30))):
        bg.paste(im, pos, im)
    return bg


def strip(shots: Path, items, w=1600, title=None, start=1) -> Image.Image:
    ph = 300
    phones = [phone(shots / f"s-{n}.png", ph) for n, _, _ in items]
    pw, phh = phones[0].size
    gap = (w - len(items) * pw) // (len(items) + 1)
    h = phh + 100 + (90 if title else 0)
    bg = Image.new("RGB", (w, h), CREAM)
    d = ImageDraw.Draw(bg, "RGBA")
    top = 0
    if title:
        d.text((w // 2, 70), title, font=font("Fraunces.ttf", 44, "Black"), fill=GREEN, anchor="mm")
        top = 90
    num, cap, sub = font("Fraunces.ttf", 26, "Black"), font("Inter.ttf", 25, "Bold"), font("Inter.ttf", 19, "Regular")
    for i, (p, (_, c, s)) in enumerate(zip(phones, items)):
        x = gap + i * (pw + gap)
        bg.paste(p, (x, top), p)
        cx, y = x + pw // 2, top + phh - 18
        d.ellipse((cx - 19, y - 19, cx + 19, y + 19), fill=LIME)
        d.text((cx, y), str(start + i), font=num, fill=DEEP, anchor="mm")
        d.text((cx, y + 44), c, font=cap, fill=INK, anchor="mm")
        d.text((cx, y + 78), s, font=sub, fill="#6b7a72", anchor="mm")
    return bg


def save(im: Image.Image, name: str):
    OUT.mkdir(exist_ok=True)
    im.convert("RGB").save(OUT / f"{name}.webp", "WEBP", quality=86, method=6)
    print(OUT / f"{name}.webp", im.size)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    shots = Path(sys.argv[1])
    b = banner(shots)
    save(b, "banner")
    b.convert("RGB").resize((1280, 656), Image.LANCZOS).crop((0, 8, 1280, 648)).save(OUT / "social-preview.png", optimize=True)
    save(strip(shots, [("choose", "Choose", "thumbs, notes, wishes"), ("detail", "Look closer", "why it fits, risks, amounts"),
                       ("stores", "Shop smart", "every store near you"), ("menu", "Cook", "the week at a glance")]), "flow")
    save(strip(shots, [("shop", "Shopping list", "priced, by aisle, tick off"), ("prep", "Prep timeline", "parallel steps + timers"),
                       ("feedback", "Rate the week", "per person, tags, facts")], start=5), "after")
    for n in ("choose", "detail", "stores", "menu", "shop", "prep", "feedback"):
        save(phone(shots / f"s-{n}.png", 420), f"phone-{n}")


if __name__ == "__main__":
    main()

"""M4: simple test characters for the character dialogue layout (self-made, no external art).

Each character folder gets, for every face in FACES:
  <face>.png        mouth closed
  <face>-half.png   mouth half open
  <face>-talk.png   mouth open
  <face>-blink.png  eyes closed, mouth closed
All images share one canvas (800 x 1000, transparent) and one body position, as real character
art must, so swapping images never makes the character jump.

Usage (from tts-server/): uv run --frozen python ../experiments/m4/make_characters.py <out dir>
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw

W, H = 800, 1000
SS = 2  # supersampling for smooth edges
FACES = ["neutral", "happy", "sad", "angry", "surprised"]
MOUTHS = ["closed", "half", "talk"]
SKIN = (255, 224, 196)
LINE = (60, 40, 40)
MOUTH_IN = (150, 50, 60)


@dataclass
class Look:
    hair: tuple[int, int, int]
    shirt: tuple[int, int, int]
    style: str  # long | short | bob
    look_x: int = 0  # face features shifted toward where the character looks (+ = right)


CHARACTERS = {
    "sohee": Look(hair=(70, 45, 35), shirt=(37, 99, 235), style="long"),
    "minsu": Look(hair=(30, 30, 35), shirt=(234, 88, 12), style="short", look_x=22),
    "jiwoo": Look(hair=(150, 85, 50), shirt=(22, 163, 74), style="bob"),
}


def s(*v: float) -> list[float]:
    return [x * SS for x in v]


def draw(look: Look, face: str, mouth: str, blink: bool) -> Image.Image:
    img = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = 400 + look.look_x // 3, 400  # head center
    fx = 400 + look.look_x  # features center

    # body + neck
    d.rounded_rectangle(s(150, 700, 650, 1100), radius=140 * SS, fill=look.shirt)
    d.rectangle(s(355, 600, 445, 720), fill=SKIN)
    d.polygon(s(330, 700, 400, 790, 470, 700), fill=(250, 250, 250))

    # back hair
    if look.style == "long":
        d.rounded_rectangle(s(225, 230, 575, 780), radius=150 * SS, fill=look.hair)
    elif look.style == "bob":
        d.rounded_rectangle(s(220, 230, 580, 610), radius=150 * SS, fill=look.hair)

    # head
    d.ellipse(s(cx - 165, cy - 190, cx + 165, cy + 200), fill=SKIN)
    # ears
    d.ellipse(s(cx - 185, cy - 10, cx - 140, cy + 60), fill=SKIN)
    d.ellipse(s(cx + 140, cy - 10, cx + 185, cy + 60), fill=SKIN)

    # front hair
    if look.style == "short":
        d.chord(s(cx - 175, cy - 215, cx + 175, cy + 60), 180, 360, fill=look.hair)
        d.polygon(s(cx - 175, cy - 70, cx - 120, cy - 40, cx - 60, cy - 90, cx - 175, cy - 120), fill=look.hair)
    else:
        d.chord(s(cx - 180, cy - 215, cx + 180, cy + 40), 180, 360, fill=look.hair)
        d.polygon(s(cx - 150, cy - 90, cx - 40, cy - 55, cx + 20, cy - 95, cx - 150, cy - 140), fill=look.hair)
        d.polygon(s(cx + 150, cy - 90, cx + 60, cy - 60, cx + 10, cy - 100, cx + 150, cy - 140), fill=look.hair)

    # cheeks
    blush = (255, 170, 170) if face in ("happy", "surprised") else (255, 200, 190)
    d.ellipse(s(fx - 125, cy + 55, fx - 75, cy + 85), fill=blush)
    d.ellipse(s(fx + 75, cy + 55, fx + 125, cy + 85), fill=blush)

    # eyebrows (angle per face)
    brow = {"neutral": 0, "happy": -6, "sad": 14, "angry": -18, "surprised": -14}[face]
    by = cy - 70 - (14 if face == "surprised" else 0)
    for side in (-1, 1):
        x0, x1 = fx + side * 40, fx + side * 105
        inner, outer = by + (brow if face in ("sad", "angry") else 0), by - (0 if face in ("sad", "angry") else -brow)
        if face == "sad":
            inner, outer = by - 10, by + 8
        if face == "angry":
            inner, outer = by + 12, by - 8
        d.line(s(x0, inner, x1, outer), fill=LINE, width=9 * SS)

    # eyes
    ey = cy - 10
    for side in (-1, 1):
        ex = fx + side * 72
        if blink:
            d.arc(s(ex - 30, ey - 12, ex + 30, ey + 22), 20, 160, fill=LINE, width=7 * SS)
        elif face == "happy":
            d.arc(s(ex - 30, ey - 8, ex + 30, ey + 30), 200, 340, fill=LINE, width=8 * SS)
        else:
            r = 24 if face == "surprised" else 20
            d.ellipse(s(ex - r, ey - r * 1.3, ex + r, ey + r * 1.3), fill=LINE)
            d.ellipse(s(ex - 6 + 4, ey - r, ex + 6 + 4, ey - r + 12), fill=(255, 255, 255))

    # mouth
    my = cy + 100
    if mouth == "closed":
        if face == "happy":
            d.arc(s(fx - 45, my - 30, fx + 45, my + 20), 20, 160, fill=LINE, width=7 * SS)
        elif face == "sad":
            d.arc(s(fx - 35, my, fx + 35, my + 40), 200, 340, fill=LINE, width=7 * SS)
        elif face == "surprised":
            d.ellipse(s(fx - 14, my - 10, fx + 14, my + 18), fill=MOUTH_IN, outline=LINE, width=4 * SS)
        elif face == "angry":
            d.line(s(fx - 35, my + 8, fx + 35, my + 2), fill=LINE, width=7 * SS)
        else:
            d.arc(s(fx - 35, my - 18, fx + 35, my + 14), 30, 150, fill=LINE, width=7 * SS)
    else:
        w, h = (30, 18) if mouth == "half" else (40, 38)
        if face == "surprised":
            w, h = w * 0.8, h * 1.3
        if face == "happy":
            d.chord(s(fx - w - 8, my - h, fx + w + 8, my + h), 0, 180, fill=MOUTH_IN, outline=LINE, width=4 * SS)
        else:
            d.ellipse(s(fx - w, my - h / 2, fx + w, my + h), fill=MOUTH_IN, outline=LINE, width=4 * SS)
        if mouth == "talk":
            d.ellipse(s(fx - w * 0.5, my + h * 0.35, fx + w * 0.5, my + h * 0.9), fill=(230, 110, 120))

    if face == "sad":  # a small tear
        d.ellipse(s(fx + 92, ey + 30, fx + 108, ey + 56), fill=(120, 180, 255))
    if face == "angry":  # anger mark
        ax, ay = cx + 130, cy - 150
        for dx, dy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
            d.arc(s(ax + dx * 14 - 14, ay + dy * 14 - 14, ax + dx * 14 + 14, ay + dy * 14 + 14), 0, 360, fill=(220, 40, 40), width=5 * SS)

    return img.resize((W, H), Image.LANCZOS)


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "characters")
    for name, look in CHARACTERS.items():
        folder = out / name
        folder.mkdir(parents=True, exist_ok=True)
        for face in FACES:
            for mouth in MOUTHS:
                suffix = "" if mouth == "closed" else f"-{mouth}"
                draw(look, face, mouth, blink=False).save(folder / f"{face}{suffix}.png")
            draw(look, face, "closed", blink=True).save(folder / f"{face}-blink.png")
        print(folder, len(list(folder.glob("*.png"))), "images")


if __name__ == "__main__":
    main()

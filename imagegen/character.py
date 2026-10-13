"""Image steps of character generation (plan 4.3, 4.4, C19): background removal, checks, layers.

No MLX here: numpy, Pillow and scipy only, so it runs in a few seconds with little memory.

    python character.py post <job.json>     # cutouts + checks of freshly generated images (review)
    python character.py derive <job.json>   # layers and derived values from approved sources

The CLI builds the job files (which images, which parents) and reads the JSON printed on stdout.
"""

from __future__ import annotations

import itertools
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

# Background removal (C19). Distances are RGB euclidean to the border color.
LOW, HIGH = 18.0, 60.0  # <= LOW background, >= HIGH character, between: 2 px soft edge
ENCLOSED_MIN = 400  # background-colored closed areas (between arm and body) at least this big
SHADOW_CHROMA, SHADOW_MIN_LUM = 14.0, 110.0
SHADOW_BAND = 0.15  # shadows are removed only in the lowest 15 % of the character
# Difference masks (4.3 step 1).
DIFF_T, MIN_BLOB = 24, 150
# Smallest change that counts as a part, per framing: a full-length figure's face is small (a
# half-open mouth of a seven-heads-tall figure is under 150 px at 640x800).
PART_MIN_BLOB = {"full": 40, "upper": 80, "head": 150}
CROSS = ndimage.generate_binary_structure(2, 1)


# ---------- basic image helpers ----------


def load_rgb(path: str | Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)


def load_rgba(path: str | Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGBA"), dtype=np.float32)


# Layer files edited by hand (their hash differs from the one recorded when they were written):
# derive never overwrites or deletes them (C16). Set from the derive job.
PROTECT: set[str] = set()


def save_rgba(arr: np.ndarray, path: str | Path) -> None:
    path = Path(path)
    if str(path) in PROTECT:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.stem + ".tmp.png")
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA").save(tmp)
    tmp.replace(path)


def grow(m: np.ndarray, n: int) -> np.ndarray:
    return ndimage.binary_dilation(m, CROSS, iterations=n) if n > 0 else m.copy()


def shrink(m: np.ndarray, n: int) -> np.ndarray:
    return ndimage.binary_erosion(m, CROSS, iterations=n, border_value=0) if n > 0 else m.copy()


def fill_holes(m: np.ndarray) -> np.ndarray:
    return ndimage.binary_fill_holes(m)


def blobs(m: np.ndarray) -> list[np.ndarray]:
    lab, n = ndimage.label(m, CROSS)
    return [lab == i for i in range(1, n + 1)]


def feather(m: np.ndarray, r: int) -> np.ndarray:
    """Soft edge outside the mask (the core stays opaque), in 0..1."""
    a = ndimage.uniform_filter(m.astype(np.float32), size=2 * r + 1, mode="nearest")
    return np.maximum(a, m.astype(np.float32))


def iou(a: np.ndarray, b: np.ndarray) -> float:
    u = (a | b).sum()
    return float((a & b).sum() / u) if u else 1.0


# ---------- background removal ----------


def cutout(rgb: np.ndarray, bottom_open: bool = False) -> tuple[np.ndarray, dict]:
    """RGBA (0..255 floats) with the background removed, and its stats.

    bottom_open: close-ups are cut off by the bottom edge, so the fill does not start there.
    """
    h, w, _ = rgb.shape
    border = np.zeros((h, w), bool)
    border[0], border[:, 0], border[:, -1] = True, True, True
    if not bottom_open:
        border[-1] = True
    bg = np.median(rgb[border], axis=0)
    dist = np.sqrt(((rgb - bg) ** 2).sum(axis=2))
    near = dist < LOW
    lab, _ = ndimage.label(near, CROSS)
    touching = np.unique(lab[border & near])
    core = np.isin(lab, touching[touching > 0])
    # Closed background-colored areas (between an arm and the body) are background too.
    sizes = ndimage.sum(near, lab, index=np.arange(lab.max() + 1))
    core |= near & (sizes[lab] >= ENCLOSED_MIN)
    band = grow(core, 2) & ~core & (dist < HIGH)
    alpha = np.ones((h, w), np.float32)
    alpha[core] = 0
    alpha[band] = np.clip((dist[band] - LOW) / (HIGH - LOW), 0, 1)
    shadow = np.zeros((h, w), bool)
    lum = rgb.mean(axis=2)
    chroma = rgb.max(axis=2) - rgb.min(axis=2)
    grayish = (chroma < SHADOW_CHROMA) & (lum > SHADOW_MIN_LUM) & (lum <= bg.mean() + 4)
    # The character's extent: its largest solid part without shadow-like pixels (specks at the
    # image edge or the shadow itself must not move the band).
    body = largest(~core & ~grayish)
    if body.any():
        ys = np.nonzero(body.any(axis=1))[0]
        top, bottom = ys.min(), ys.max()
        zone = np.zeros((h, w), bool)
        zone[int(bottom - (bottom - top) * SHADOW_BAND) :] = True
        lab2, _ = ndimage.label(grayish & zone, CROSS)
        hit = np.unique(lab2[grow(alpha < 0.5, 1) & (lab2 > 0)])
        shadow = np.isin(lab2, hit[hit > 0])
        alpha[grow(shadow, 2) & grayish] = 0
    a = alpha[..., None]
    fg = np.where(a > 0.01, (rgb - (1 - a) * bg) / np.maximum(a, 0.01), 0)
    rgba = np.dstack([np.clip(fg, 0, 255), alpha * 255])
    opaque = alpha > 0.5
    edge = np.concatenate([opaque[0], opaque[:, 0], opaque[:, -1]] + ([] if bottom_open else [opaque[-1]]))
    stats = {
        "bg": [round(float(x)) for x in bg],
        "background": round(float((alpha < 0.5).mean()), 3),
        "edge_opaque": int(edge.sum()),
        "shadow_left": round(float((grayish_rest(rgb, bg, alpha, bottom_open)).mean()), 4),
        "bg_std": round(float(rgb[core].std()) if core.any() else 0.0, 2),
    }
    return rgba, stats


def largest(m: np.ndarray) -> np.ndarray:
    lab, n = ndimage.label(m, CROSS)
    if n == 0:
        return m
    sizes = ndimage.sum(m, lab, index=np.arange(1, n + 1))
    return lab == int(np.argmax(sizes)) + 1


def grayish_rest(rgb: np.ndarray, bg: np.ndarray, alpha: np.ndarray, bottom_open: bool) -> np.ndarray:
    """Shadow-like pixels left visible just below the character (a residue check)."""
    solid = alpha > 0.5
    if not solid.any() or bottom_open:
        return np.zeros(alpha.shape, bool)
    bottom = np.nonzero(solid.any(axis=1))[0].max()
    lum = rgb.mean(axis=2)
    chroma = rgb.max(axis=2) - rgb.min(axis=2)
    rest = solid & (chroma < SHADOW_CHROMA) & (lum > SHADOW_MIN_LUM) & (np.abs(lum - bg.mean()) < 30)
    rest[: max(0, bottom - 6)] = False
    return rest


# ---------- difference masks ----------


def diff_mask(a: np.ndarray, b: np.ndarray, inside: np.ndarray, min_blob: int = MIN_BLOB) -> np.ndarray:
    """Pixels that changed between two RGB images, as solid areas (4.3 step 1)."""
    d = np.abs(a - b).max(axis=2) > DIFF_T
    m = (feather(d, 2) > 0.6) & inside
    lab, n = ndimage.label(m, CROSS)
    if n == 0:
        return m
    sizes = ndimage.sum(m, lab, index=np.arange(n + 1))
    return sizes[lab] >= min_blob


def part_region(mask: np.ndarray, limit: np.ndarray) -> np.ndarray:
    """A part's alpha (0..1): grown 6 px, holes filled, 3 px soft edge, cut by the head alpha."""
    return feather(fill_holes(grow(mask, 6)), 3) * limit


def eye_blobs(
    still: np.ndarray, blink: np.ndarray, inside: np.ndarray, min_blob: int = MIN_BLOB, top: float = 1.0
) -> list[np.ndarray]:
    """The two eyes a blink closed: of the six largest changed blobs (within the top `top` share
    of `inside`), the best pair side by side: farther apart across than up and down and than half
    an eye's width (not an eye and its eyebrow), level (a tilted head allowed), and alike in size, scored by the smaller
    size times the size ratio (a hair lock or a hand beside the face at eye height is not alike
    an eye); else []."""
    rows = np.nonzero(inside.any(axis=1))[0]
    if top < 1 and rows.size:
        inside = inside.copy()
        inside[int(rows[0] + top * (rows[-1] - rows[0])) + 1 :] = False
    bl = sorted(blobs(diff_mask(still, blink, inside, min_blob)), key=lambda b: -int(b.sum()))[:6]
    best: list[np.ndarray] = []
    score = 0.0
    for i, a in enumerate(bl):
        for b in bl[i + 1 :]:
            ratio = b.sum() / a.sum()  # b is the smaller
            if ratio < 0.4 or b.sum() * ratio <= score:
                continue
            (y1, x1), (y2, x2) = (np.argwhere(x).mean(axis=0) for x in (a, b))
            width = np.mean([np.ptp(np.nonzero(x)[1]) + 1 for x in (a, b)])
            height = np.mean([np.ptp(np.nonzero(x)[0]) + 1 for x in (a, b)])
            dx, dy = abs(x2 - x1), abs(y2 - y1)
            if dx > max(1.2 * dy, 0.5 * width) and dy < max(0.5 * height, 0.35 * dx):
                best, score = [a, b], float(b.sum() * ratio)
    return best


# Without a head region, the eyes are looked for in this top share of the drawing (a full-length
# figure's hands and hem stay out; a head close-up is all head).
# Measured: a two-heads-tall figure's eyes reach 33 % of its height (test r6), so not less.
EYE_TOP = {"full": 0.45, "upper": 0.6, "head": 1.0}


def eye_inside(
    img: np.ndarray, bo: bool, head: np.ndarray | None = None, framing: str = "full"
) -> tuple[np.ndarray, float]:
    """Where post and derive look for the eyes: the drawing 2 px in from its outline, within the
    head region when there is one, else its top share (EYE_TOP)."""
    m = shrink(cutout(img, bo)[0][..., 3] > 128, 2)
    return (m & grow(head, 8), 1.0) if head is not None else (m, EYE_TOP[framing])


def first_eyes(pairs, inside_of, min_blob: int = MIN_BLOB) -> tuple[list[np.ndarray], bool]:
    """The eyes of the first (still, blink) pair that has them, and whether that is the first pair
    (the group's own blink, when it has one). The caller orders the pairs: own, the same head,
    the rest of the view (a closed-eye smile has no blink of its own)."""
    for i, (still, blink) in enumerate(pairs):
        inside, top = inside_of(still)
        eyes = eye_blobs(still, blink, inside, min_blob, top)
        if eyes:
            return eyes, i == 0
    return [], False


def mouth_box(eyes: list[np.ndarray], shape: tuple[int, ...]) -> np.ndarray:
    """Where the mouth can be: below the eyes, up to one eye distance down, as wide as the face.
    Keeps eyebrows, the chin line, the collar and hands out of the mouth part."""
    (y1, x1), (y2, x2) = (np.argwhere(b).mean(axis=0) for b in eyes)
    # Eye distance, at least an eye and a half wide (a turned face brings the eyes close).
    d = max(abs(x2 - x1), 1.5 * np.mean([np.ptp(np.nonzero(b)[1]) + 1 for b in eyes]))
    ey, cx = (y1 + y2) / 2, (x1 + x2) / 2
    box = np.zeros(shape[:2], bool)
    box[max(0, int(ey + 0.25 * d)) : int(ey + 1.0 * d) + 1, max(0, int(cx - 0.8 * d)) : int(cx + 0.8 * d) + 1] = True
    return box


def mouth_mask(
    still: np.ndarray,
    frames: list[np.ndarray],
    inside: np.ndarray,
    box: np.ndarray | None = None,
    min_blob: int = MIN_BLOB,
) -> np.ndarray:
    """The mouth over the mouth frames (shared by half/open), plus blobs within 12 px.

    With a mouth box (from the eyes): the blob overlapping it most, joined only by blobs near the
    box (not a chin or collar change next to it); nothing when none overlaps. Without: the lowest
    blob of at least 20 % of the biggest. Not simply the biggest: the edit may also move the
    eyebrows, which can outweigh a half-open mouth (test r6)."""
    m = np.zeros(inside.shape, bool)
    for f in frames:
        m |= diff_mask(still, f, inside, min_blob)
    bl = blobs(m)
    if not bl:
        return m
    if box is not None:
        hit = [b for b in bl if (b & box).any()]
        if not hit:
            return np.zeros(inside.shape, bool)
        first = max(hit, key=lambda b: int((b & box).sum()))
        bl = [b for b in bl if (b & grow(box, 6)).any()]
    else:
        big = max(int(b.sum()) for b in bl)
        first = max((b for b in bl if b.sum() >= 0.2 * big), key=lambda b: float(np.nonzero(b)[0].mean()))
    out = first.copy()
    rest = [b for b in bl if b is not first]
    while True:  # blobs joined through other blobs count too
        near = [b for b in rest if (b & grow(out, 12)).any()]
        if not near:
            return out
        for b in near:
            out |= b
        rest = [b for b in rest if not any(b is n for n in near)]


def group_parts(
    still: np.ndarray,
    frames: dict[str, np.ndarray],
    inside: np.ndarray,
    eyes: list[np.ndarray],
    min_blob: int = MIN_BLOB,
    own_eyes: bool = False,
) -> tuple[np.ndarray, np.ndarray]:
    """The mouth mask (half/open) and the eye mask (blink and every gaze) of a group, as derive
    pastes them; post judges frames with the same masks. `eyes` place the mouth and keep the eye
    mask on the eyes: tightly when they are the group's own (`own_eyes`), loosely when borrowed
    from another expression or head. Without eyes, the eye mask is every change away from the
    mouth."""
    box = mouth_box(eyes, still.shape) if eyes else None
    mouth_src = [frames[f] for f in ("half", "open") if f in frames]
    m = mouth_mask(still, mouth_src, inside, box, min_blob) if mouth_src else np.zeros(inside.shape, bool)
    eyes_all = np.zeros(inside.shape, bool)
    for f, img in frames.items():
        if f == "blink" or f.startswith("gaze-"):
            eyes_all |= diff_mask(still, img, inside, min_blob) & ~grow(m, 10)
    if eyes:
        (_, x1), (_, x2) = (np.argwhere(b).mean(axis=0) for b in eyes)
        d = abs(x2 - x1)
        # Whole changes only, kept or dropped: cutting a change at a mask edge leaves a sliver
        # (an eyebrow piece under the still's eyebrow, test r6 turn).
        if own_eyes:
            # Changes mostly on the eyes: a blink edit may also lower the eyebrows (test r6, turn),
            # which would then jump at every blink. Gaze pupils move inside the eyes.
            on = grow(eyes[0] | eyes[1], 4)
            kept = [b for b in blobs(eyes_all) if (b & on).sum() >= 0.3 * b.sum()]
        else:
            # Borrowed eyes sit a little elsewhere: changes near them, not hair, collar or hands.
            near = grow(eyes[0] | eyes[1], max(4, int(0.25 * d)))
            kept = [b for b in blobs(eyes_all) if (b & near).any()]
        eyes_all = np.logical_or.reduce(kept) if kept else np.zeros(inside.shape, bool)
    return m, eyes_all


# ---------- layers (4.3) ----------


def head_region(ref: np.ndarray, headless: np.ndarray, ref_alpha: np.ndarray) -> tuple[np.ndarray, list[int]]:
    """Head = what the headless edit removed (grown 4, holes filled) inside the reference; pivot =
    the horizontal center of its lowest 12 px rows and its lowest row."""
    inside = ref_alpha > 128
    region = fill_holes(grow(diff_mask(ref, headless, inside), 4)) & inside
    if not region.any():
        raise ValueError("the headless edit removed nothing: no head region")
    ys, xs = np.nonzero(region)
    py = int(ys.max())
    px = int(round(float(xs[ys >= py - 12].mean())))
    return region, [px, py]


def front_blobs(ref: np.ndarray, edit: np.ndarray, inside: np.ndarray, head: np.ndarray) -> np.ndarray:
    """Front layer: changed blobs that cross the head boundary (a hand in front of the head)."""
    out = np.zeros(head.shape, bool)
    near = grow(head, 2)
    for b in blobs(diff_mask(ref, edit, inside)):
        if (b & head).any() and (b & ~near).any():
            out |= b & near
    return out


def band_offset(still: np.ndarray, ref: np.ndarray, py: int, search: int = 8) -> tuple[list[int], float]:
    """Group offset: align the neck/shoulder band (pivot y+4 .. +24) of the still to the reference."""
    h, w, _ = still.shape
    y0, y1 = py + 4, min(h, py + 24)
    if y1 - y0 < 4:
        return [0, 0], 0.0
    best, err = (0, 0), float("inf")
    target = ref[y0:y1, search : w - search]
    for dy in range(-search, search + 1):
        for dx in range(-search, search + 1):
            ys, ye = y0 - dy, y1 - dy
            if ys < 0 or ye > h:
                continue
            cand = still[ys:ye, search - dx : w - search - dx]
            e = float(((cand - target) ** 2).mean())
            if e < err:
                best, err = (dx, dy), e
    return [int(best[0]), int(best[1])], round(err, 1)


def shift(arr: np.ndarray, dx: int, dy: int) -> np.ndarray:
    out = np.zeros_like(arr)
    h, w = arr.shape[:2]
    ys, yd = (slice(0, h - dy), slice(dy, h)) if dy >= 0 else (slice(-dy, h), slice(0, h + dy))
    xs, xd = (slice(0, w - dx), slice(dx, w)) if dx >= 0 else (slice(-dx, w), slice(0, w + dx))
    out[yd, xd] = arr[ys, xs]
    return out


def over(dst: np.ndarray, src: np.ndarray) -> np.ndarray:
    """Straight-alpha 'over' of RGBA float arrays (0..255)."""
    sa, da = src[..., 3:] / 255, dst[..., 3:] / 255
    oa = sa + da * (1 - sa)
    rgb = np.where(oa > 0, (src[..., :3] * sa + dst[..., :3] * da * (1 - sa)) / np.maximum(oa, 1e-6), 0)
    return np.dstack([rgb, oa * 255])


def seam_error(comp: np.ndarray, still: np.ndarray, solid: np.ndarray, row: int, band: int = 6) -> float:
    """Join seam: the composite (headless body + head layer) against the still it should look like,
    in a band of rows around the head cut. Edges the drawing has (a collar line) cancel out."""
    y0, y1 = max(0, row - band), min(comp.shape[0], row + band + 1)
    both = solid[y0:y1] & (still[y0:y1, :, 3] > 128)
    if not both.any():
        return 0.0
    return float(np.abs(comp[y0:y1, :, :3] - still[y0:y1, :, :3]).mean(axis=2)[both].mean())


# ---------- post: checks of generated images (4.4) ----------


def grain(rgb: np.ndarray) -> np.ndarray:
    """High-frequency detail per pixel (distance from the 3x3 mean of the gray image)."""
    g = rgb.mean(axis=2)
    return np.abs(g - ndimage.uniform_filter(g, 3))


def part_grain(raw: np.ndarray, still: np.ndarray, part: np.ndarray, changed: np.ndarray) -> tuple[float, int]:
    """Grain a frame brings into its part, on areas flat in the still away from the drawn change
    (test r6: a grainy close-up frame 0.95, clean frames ≤ 0.46), and how many pixels that is."""
    flat = ndimage.maximum_filter(grain(still), 5) < 2
    reg = part & flat & ~grow(changed, 2)
    n = int(reg.sum())
    return (float(grain(raw)[reg].mean() - grain(still)[reg].mean()) if n else 0.0), n


def check(value: float, ok: bool, limit: str) -> dict:
    return {"value": value, "ok": bool(ok), "limit": limit}


FRAMING_BG = {"full": (0.3, 0.95), "upper": (0.15, 0.9), "head": (0.05, 0.9)}
PART_AREA = {"full": (0.002, 0.08), "upper": (0.005, 0.15), "head": (0.01, 0.30)}


def post_item(item: dict) -> dict:
    """Cutout and checks for one generated image. item: id, kind, image, cutout, bottom_open,
    input (the edited image: noise), and by kind: ref (headless, body), still (stills, frames),
    plus for frames: frames {name: image} of the group, eyes [{still, blink}] (approved blinks of
    other groups, in eye_order, placing the mouth when the group's own has no eyes), head_region
    and pivot_y (split views), composite (output)."""
    if item["kind"] == "frame":
        return post_frame(item)
    rgb = load_rgb(item["image"])
    kind = item["kind"]
    rgba, st = cutout(rgb, item.get("bottom_open", False))
    save_rgba(rgba, item["cutout"])
    inside = rgba[..., 3] > 128
    area = rgb.shape[0] * rgb.shape[1]
    checks = base_checks(st, item)
    if item.get("input"):
        _, ist = cutout(load_rgb(item["input"]), item.get("input_bottom_open", False))
        inc = st["bg_std"] - ist["bg_std"]
        checks["noise"] = check(round(inc, 2), inc <= 2, "≤ 2")
    if kind == "headless":
        ref = load_rgb(item["ref"])
        ref_alpha = cutout(ref, item.get("bottom_open", False))[0][..., 3]
        region, pivot = head_region(ref, rgb, ref_alpha)
        body = (ref_alpha > 128) & ~grow(region, 8)
        body[: pivot[1]] = False
        d = float(np.abs(rgb - ref).mean(axis=2)[body].mean()) if body.any() else 0.0
        checks["body_kept"] = check(round(d, 1), d <= 15, "≤ 15")
    if kind == "body":
        ref = load_rgb(item["ref"])
        head = np.asarray(Image.open(item["head_region"])) > 0
        (dx, dy), _ = band_offset_region(rgb, ref, head)
        checks["head_shift"] = check(max(abs(dx), abs(dy)), max(abs(dx), abs(dy)) <= 1, "≤ 1 px")
    if kind == "still":
        still = load_rgb(item["still"])
        still_alpha = cutout(still, item.get("bottom_open", False))[0][..., 3] > 128
        ratio = float(diff_mask(still, rgb, shrink(still_alpha & inside, 6)).sum() / area)
        checks["change"] = check(round(ratio, 4), ratio >= 0.005, "≥ 0.005")  # plan 4.4
    return {"id": item["id"], "stats": st, "checks": checks, "ok": all(c["ok"] for c in checks.values())}


def base_checks(st: dict, item: dict) -> dict:
    # Close-ups fill the picture: less background is expected.
    lo, hi = FRAMING_BG[item.get("framing", "full")]
    return {
        "background": check(st["background"], lo <= st["background"] <= hi, f"{lo}–{hi}"),
        "edge": check(st["edge_opaque"], st["edge_opaque"] == 0, "0"),
        "shadow": check(st["shadow_left"], st["shadow_left"] < 0.001, "< 0.001"),
    }


def post_frame(item: dict) -> dict:
    """A frame is used only for its part, which derive pastes on the still; an edit of an edited
    still comes back with faint blotches everywhere (test r6, every seed). So the frame is judged
    on what is rendered: the still with the part, masks made as derive makes them (group_parts).
    Only outside_part reads the raw frame (a drifting pose)."""
    raw = load_rgb(item["image"])
    still = load_rgb(item["still"])
    bo = item.get("bottom_open", False)
    mb = PART_MIN_BLOB[item.get("framing", "full")]
    still_alpha = cutout(still, bo)[0][..., 3] > 128
    body = shrink(still_alpha, 6)
    # Parts are found where derive finds them: in the head region of a split view.
    head = np.asarray(Image.open(item["head_region"])) > 0 if item.get("head_region") else None
    interior = body & grow(head, 8) if head is not None else body
    if item.get("pivot_y") is not None:  # derive cuts the head layer below pivot y + 4
        interior = interior.copy()
        interior[int(item["pivot_y"]) + 5 :] = False
    name = item.get("frame", "")
    frames = {f: load_rgb(p) for f, p in item.get("frames", {}).items() if f != name}
    frames[name] = raw
    own_pair = [(still, frames["blink"])] if "blink" in frames else []
    # Borrowed pairs load only when needed (each is two full images).
    pairs = itertools.chain(own_pair, ((load_rgb(e["still"]), load_rgb(e["blink"])) for e in item.get("eyes", [])))
    framing = item.get("framing", "full")
    eyes, first = first_eyes(pairs, lambda img: eye_inside(img, bo, head, framing), mb)
    m, eyes_all = group_parts(still, frames, interior, eyes, mb, first and "blink" in frames)
    mouth = name in ("half", "open")
    used = m if mouth else eyes_all
    own = diff_mask(still, raw, interior, mb) & grow(used, 1)  # what this frame changes in its part
    changed = diff_mask(still, raw, body)  # the usual blob size: specks stay "outside the part"
    a = part_region(used, still_alpha.astype(np.float32))[..., None]
    comp = still * (1 - a) + raw * a
    if item.get("composite"):
        Image.fromarray(np.clip(comp + 0.5, 0, 255).astype(np.uint8), "RGB").save(item["composite"])
    rgba, st = cutout(comp, bo)
    save_rgba(rgba, item["cutout"])
    area = raw.shape[0] * raw.shape[1]
    checks = base_checks(st, item)
    ratio = float(own.sum() / area)
    # Plan 4.4: open mouth and blink ≥ 0.3 %; a half-open mouth changes less. A blink of eyes
    # already closed (a closed-eye smile) changes nothing: approve it by name (not with --all).
    need = 0.001 if name == "half" else 0.003
    hint = " (0 for eyes already closed: approve by name)" if name == "blink" else ""
    checks["change"] = check(round(ratio, 4), ratio >= need, f"≥ {need}{hint}")
    if mouth and not m.any():
        checks["mouth_found"] = check(0, False, "a change below the eyes")
    part = grow(fill_holes(grow(changed, 6)), 3)
    rest = body & ~part
    d = float(np.abs(raw - still).mean(axis=2)[rest].mean()) if rest.any() else 0.0
    checks["outside_part"] = check(round(d, 2), d <= 5, "≤ 5")
    region = grow(fill_holes(grow(used, 6)), 3) & still_alpha
    gr, n = part_grain(raw, still, region, changed | own)
    # Too few flat pixels around a small part: report the value, do not judge it.
    checks["part_grain"] = check(round(gr, 2), gr <= 0.5 or n < 200, "≤ 0.5")
    pa = float(region.sum() / area)
    lo, hi = PART_AREA[item.get("framing", "full")]
    if name == "half":  # half and open share the mouth part, but a half-open mouth is small
        lo /= 2
    checks["part_area"] = check(round(pa, 4), lo <= pa <= hi or ratio == 0, f"{lo}–{hi}")
    return {"id": item["id"], "stats": st, "checks": checks, "ok": all(c["ok"] for c in checks.values())}


def post_safe(item: dict) -> dict:
    """post_item, but a broken image (e.g. a headless edit that removed nothing) fails its own
    item instead of the whole round."""
    try:
        return post_item(item)
    except (ValueError, OSError) as e:
        bad = {"error": {"value": 0, "ok": False, "limit": str(e)[:200]}}
        return {"id": item["id"], "stats": {}, "checks": bad, "ok": False}


def band_offset_region(edit: np.ndarray, ref: np.ndarray, head: np.ndarray, search: int = 4) -> tuple[list[int], float]:
    """How far the head moved in a body edit (min squared error inside the head box)."""
    ys, xs = np.nonzero(head)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    h, w = head.shape
    target = ref[y0:y1, x0:x1]
    best, err = (0, 0), float("inf")
    for dy in range(-search, search + 1):
        for dx in range(-search, search + 1):
            a, b, c, d = y0 + dy, y1 + dy, x0 + dx, x1 + dx
            if a < 0 or c < 0 or b > h or d > w:
                continue
            e = float(((edit[a:b, c:d] - target) ** 2).mean())
            if e < err:
                best, err = (dx, dy), e
    return [int(best[0]), int(best[1])], err


# ---------- derive: layers from approved sources ----------


def part_seam(head: np.ndarray, part: np.ndarray, frame: np.ndarray, alpha: np.ndarray) -> float:
    """Part seam (4.4): head + part vs the real edit, in the part's soft edge band."""
    band = (alpha > 5) & (alpha < 250) & (head[..., 3] > 128)
    if not band.any():
        return 0.0
    comp = over(head, part)
    return float(np.abs(comp[..., :3] - frame).mean(axis=2)[band].mean())


def still_name(h: str, e: str) -> str:
    return "ref.png" if (h, e) == ("base", "neutral") else f"still-{h}-{e}.png"


def eye_order(groups: list[tuple[str, str]], h: str, e: str) -> list[tuple[str, str]]:
    """Blinks to find a group's eyes in, in order: its own, the same head's, the rest (each sorted
    by name). TS (frameContext) passes post the same order."""
    own = [k for k in groups if k == (h, e)]
    same = sorted(k for k in groups if k[0] == h and k != (h, e))
    return own + same + sorted(k for k in groups if k[0] != h)


def view_eyes(src: Path, groups: list[dict], bo: bool, framing: str, head: np.ndarray | None):
    """Eyes per group for derive, as post finds them (`first_eyes` over `eye_order`)."""
    blinks = [(g["head"], g["expr"]) for g in groups if "blink" in g.get("frames", [])]
    found: dict[tuple[str, str], list[np.ndarray]] = {}  # eyes per blink (not the images)

    def eyes_in(k: tuple[str, str]) -> list[np.ndarray]:
        if k not in found:
            still = load_rgb(src / still_name(*k))
            blink = load_rgb(src / f"frame-{k[0]}-{k[1]}-blink.png")
            inside, top = eye_inside(still, bo, head, framing)
            found[k] = eye_blobs(still, blink, inside, PART_MIN_BLOB[framing], top)
        return found[k]

    def of(h: str, e: str) -> tuple[list[np.ndarray], bool]:
        # As first_eyes over eye_order.
        for i, k in enumerate(eye_order(blinks, h, e)):
            if eyes := eyes_in(k):
                return eyes, i == 0 and k == (h, e)
        return [], False

    return of


def derive_view(job: dict) -> dict:
    """Layers of one view (plan 3.1) from approved `_src` images.

    job: src (dir with ref.png, headless.png, body-<b>.png, still-<h>-<e>.png, frame-<h>-<e>-<f>.png),
    out (the view dir), split, bottom_open, bodies [names], groups [{head, expr, frames: [...]}].
    Returns pivot, group offsets, body offsets proposed, checks.
    """
    src, out = Path(job["src"]), Path(job["out"])
    bo = job.get("bottom_open", False)
    ref = load_rgb(src / "ref.png")
    ref_rgba, _ = cutout(ref, bo)
    ref_alpha = ref_rgba[..., 3]
    result: dict = {"pivot": None, "groups": {}, "bodies": {}, "checks": {}}
    region = None
    fronts: dict[str, np.ndarray] = {}
    if job["split"]:
        headless = load_rgb(src / "headless.png")
        region, pivot = head_region(ref, headless, ref_alpha)
        result["pivot"] = pivot
        hl_rgba, _ = cutout(headless, bo)
        save_rgba(hl_rgba, out / "body" / "stand.png")
        if job.get("region_out"):  # for the head-shift check of later pose edits
            Path(job["region_out"]).parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray((region * 255).astype(np.uint8)).save(job["region_out"])
        for b in job.get("bodies", []):
            edit = load_rgb(src / f"body-{b}.png")
            e_rgba, _ = cutout(edit, bo)
            patch = grow(region, 2)
            save_rgba(np.where(patch[..., None], hl_rgba, e_rgba), out / "body" / f"{b}.png")
            # Body patch seam (4.4): the pose edit vs the headless body just outside the patch,
            # where the pose did not change the body (a raised arm is meant to differ).
            moved_parts = diff_mask(ref, edit, (e_rgba[..., 3] > 128) | (ref_alpha > 128))
            ring = grow(patch, 3) & ~patch & (e_rgba[..., 3] > 128) & (hl_rgba[..., 3] > 128) & ~grow(moved_parts, 2)
            seam = float(np.abs(e_rgba[..., :3] - hl_rgba[..., :3]).mean(axis=2)[ring].mean()) if ring.any() else 0.0
            fr = front_blobs(ref, edit, (e_rgba[..., 3] > 128) | (ref_alpha > 128), region)
            fronts[b] = fr
            result["bodies"][b] = {"patch_seam": check(round(seam, 1), seam <= 20, "≤ 20")}
            if fr.any():
                save_rgba(np.dstack([e_rgba[..., :3], feather(fr, 1) * e_rgba[..., 3]]), out / "front" / f"{b}.png")
            elif str(out / "front" / f"{b}.png") not in PROTECT:
                (out / "front" / f"{b}.png").unlink(missing_ok=True)
    mb = PART_MIN_BLOB[job.get("framing", "full")]
    eyes_of = view_eyes(src, job.get("groups", []), bo, job.get("framing", "full"), region)
    if region is None and job.get("region_out"):
        # A view that became single (one image) has no head region: post must not use an old one.
        Path(job["region_out"]).unlink(missing_ok=True)
    for g in job.get("groups", []):
        h, e = g["head"], g["expr"]
        still_p = src / still_name(h, e)
        still = load_rgb(still_p)
        s_rgba, _ = cutout(still, bo)
        s_alpha = s_rgba[..., 3]
        inside = s_alpha > 128
        key = f"{h}/{e}"
        if region is not None:
            py = result["pivot"][1]
            extra = np.zeros_like(region)
            if still_p.name != "ref.png":
                for b in blobs(diff_mask(still, ref, inside)):
                    if (b & grow(region, 6)).any():
                        extra |= b
            hreg = fill_holes(grow(region | extra, 2)) & inside
            hreg[py + 5 :] = False  # cut below pivot y + 4: the collar does not turn
            head_alpha = feather(hreg, 2) * s_alpha
            offset, err = band_offset(still, ref, py) if still_p.name != "ref.png" else ([0, 0], 0.0)
            result["groups"][key] = {"offset": offset, "band_error": err}
            # Join check, inside the composite the renderer makes: stand body + head moved by the offset.
            head_layer = shift(np.dstack([s_rgba[..., :3], head_alpha]), offset[0], offset[1])
            comp = over(load_rgba(out / "body" / "stand.png"), head_layer)
            ca = comp[..., 3] > 128
            moved = shift(inside[..., None], offset[0], offset[1])[..., 0]
            # Holes the join opened: transparent in the composite where the still was solid
            # (gaps the drawing has, e.g. between an arm and the body, are not counted).
            holes = int((fill_holes(ca) & ~ca & moved).sum())
            seam = seam_error(comp, shift(np.dstack([still, s_alpha]), offset[0], offset[1]), ca, py + 4 + offset[1])
            v = iou(ca, moved)
            result["checks"][key] = {
                "seam": check(round(seam, 1), seam <= 15, "≤ 15"),
                "holes": check(holes, holes == 0, "0"),
                "silhouette": check(round(v, 4), v >= 0.95, "≥ 0.95"),
            }
        else:
            head_alpha = s_alpha
        save_rgba(np.dstack([s_rgba[..., :3], head_alpha]), out / "face" / h / e / "head.png")
        limit = head_alpha / 255
        frames = {f: load_rgb(src / f"frame-{h}-{e}-{f}.png") for f in g.get("frames", [])}
        face = out / "face" / h / e
        # Parts of frames not approved (e.g. after the still was made again) must not stay next
        # to a new head image.
        keep = {"head.png"}
        keep |= {n for f, n in (("open", "mouth.png"), ("half", "mouth.1.png"), ("blink", "eyes.0.png")) if f in frames}
        keep |= {f"eyes@{f[len('gaze-') :]}.png" for f in frames if f.startswith("gaze-")}
        if face.exists():
            for old in face.glob("*.png"):
                if old.name not in keep and str(old) not in PROTECT:
                    old.unlink()
        eyes, own = eyes_of(h, e)
        m, eyes_all = group_parts(still, frames, limit > 0.5, eyes, mb, own)
        # Empty parts would never move: say so (post fails such frames; approving one by name
        # is the only way here).
        if ("half" in frames or "open" in frames) and not m.any():
            result["checks"].setdefault(key, {})["mouth_found"] = check(0, False, "a change below the eyes")
        eye_frames = [img for f, img in frames.items() if f == "blink" or f.startswith("gaze-")]
        away = ~grow(m, 10)  # as group_parts: part-size changes away from the mouth
        if any((diff_mask(still, img, limit > 0.5, mb) & away).any() for img in eye_frames) and not eyes_all.any():
            result["checks"].setdefault(key, {})["eyes_found"] = check(0, False, "the blink / gaze change on the eyes")
        a_m = part_region(m, limit) * 255
        seams = []
        for f, name in (("open", "mouth.png"), ("half", "mouth.1.png")):
            if f in frames:
                part = np.dstack([frames[f], a_m])
                save_rgba(part, face / name)
                seams.append(part_seam(np.dstack([s_rgba[..., :3], head_alpha]), part, frames[f], a_m))
        if seams:
            ps = max(seams)
            result["checks"].setdefault(key, {})["part_seam"] = check(round(ps, 1), ps <= 10, "≤ 10")
        gaze = {f: frames[f] for f in frames if f.startswith("gaze-")}
        # One eye mask for blink and every gaze part: eyes.0 must cover the gaze eyes (C11).
        a_e = part_region(eyes_all, limit) * 255
        # A hand in front of the face would hide these parts (plan 4.3: a warning).
        parts = (a_m > 128) | (a_e > 128)
        for b, fr in fronts.items():
            hit = int((fr & parts).sum())
            if hit:
                result["bodies"][b]["front_on_parts"] = check(hit, False, f"0 ({key})")
        if "blink" in frames:
            save_rgba(np.dstack([frames["blink"], a_e]), face / "eyes.0.png")
        for f, img in gaze.items():
            save_rgba(np.dstack([img, a_e]), face / f"eyes@{f[len('gaze-') :]}.png")
    return result


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in ("post", "derive"):
        print("usage: character.py post|derive <job.json>", file=sys.stderr)
        return 2
    job = json.loads(Path(sys.argv[2]).read_text())
    if sys.argv[1] == "post":
        out = [post_safe(i) for i in job["items"]]
    else:
        PROTECT.update(job.get("protect", []))
        out = {}
        for v in job["views"]:
            try:
                out[v["key"]] = derive_view(v)
            except (ValueError, OSError) as e:
                out[v["key"]] = {"error": str(e)}
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

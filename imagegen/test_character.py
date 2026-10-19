"""Image-step tests on synthetic drawings (needs numpy, Pillow, scipy; no MLX):
uv run --no-project --python 3.12 --with numpy==2.5.4 --with pillow==12.3.0 --with scipy==1.18.1 \\
  python -m unittest discover -s imagegen
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

try:
    import numpy as np
    from PIL import Image

    import character as C
except ImportError:  # the stdlib-only CI step
    np = None

BG = (222, 221, 220)
W, H = 160, 200


def drawing(head=True, mouth=0, blink=False, shadow=True, dx=0, dy=0, hole=False) -> np.ndarray:
    """A simple character: outlined head (skin) on a blue body with legs, an optional drop shadow."""
    img = np.zeros((H, W, 3), np.float32)
    img[:] = BG
    yy, xx = np.mgrid[0:H, 0:W]
    if shadow:
        sh = ((xx - 80) / 40) ** 2 + ((yy - 186) / 6) ** 2 <= 1
        img[sh] = (184, 182, 181)
    body = (yy >= 90) & (yy < 170) & (xx >= 50) & (xx < 110)
    img[grow_box(body, 2)] = (40, 35, 30)
    img[body] = (120, 190, 200)
    if hole:
        img[(yy >= 118) & (yy < 142) & (xx >= 68) & (xx < 92)] = BG
    legs = ((yy >= 170) & (yy < 185)) & (((xx >= 60) & (xx < 75)) | ((xx >= 85) & (xx < 100)))
    img[grow_box(legs, 2)] = (40, 35, 30)
    img[legs] = (250, 210, 190)
    if head:
        cx, cy = 80 + dx, 55 + dy
        circle = (xx - cx) ** 2 + (yy - cy) ** 2 <= 36**2
        img[circle] = (40, 35, 30)
        img[(xx - cx) ** 2 + (yy - cy) ** 2 <= 33**2] = (250, 215, 195)
        for ex in (cx - 12, cx + 12):
            eye = (
                ((xx - ex) ** 2 + (yy - cy + 5) ** 2 <= 5**2)
                if not blink
                else ((abs(yy - cy + 5) <= 1) & (abs(xx - ex) <= 6))
            )
            img[eye] = (30, 25, 20)
        if mouth:
            img[(abs(xx - cx) <= 8) & (yy >= cy + 14) & (yy < cy + 14 + 3 * mouth)] = (150, 40, 50)
    return img


def big_eyes(img: np.ndarray, closed: bool = False) -> np.ndarray:
    """Eyes large enough to count at the full-framing blob size: open discs or closed lines."""
    img = img.copy()
    yy, xx = np.mgrid[0:H, 0:W]
    for ex in (66, 94):
        disc = (xx - ex) ** 2 + (yy - 50) ** 2 <= 7**2
        img[disc] = (250, 215, 195) if closed else (30, 25, 20)
        if closed:
            img[(abs(yy - 52) <= 1) & (abs(xx - ex) <= 7)] = (30, 25, 20)
    return img


def anime_eyes(img: np.ndarray, state: str = "open", dx: int = 4) -> np.ndarray:
    """Eyes with whites: a white disc with a dark pupil `dx` px off centre ("open"), or a closed
    eyelid line on skin ("closed")."""
    img = img.copy()
    yy, xx = np.mgrid[0:H, 0:W]
    for ex in (66, 94):
        disc = (xx - ex) ** 2 + (yy - 50) ** 2 <= 10**2
        img[disc] = (30, 25, 20)
        if state == "closed":
            img[disc] = (250, 215, 195)
            img[(abs(yy - 52) <= 1) & (abs(xx - ex) <= 9)] = (30, 25, 20)
        else:
            img[(xx - ex) ** 2 + (yy - 50) ** 2 <= 8**2] = (252, 252, 252)
            img[(xx - ex - dx) ** 2 + (yy - 50) ** 2 <= 4**2] = (30, 25, 20)
    return img


def grow_box(m, n):
    return C.grow(m, n)


def save(arr, path):
    Image.fromarray(arr.astype(np.uint8), "RGB").save(path)


@unittest.skipIf(np is None, "numpy / Pillow / scipy not installed")
class CutoutTest(unittest.TestCase):
    def test_removes_background_shadow_and_enclosed_gaps(self) -> None:
        rgba, st = C.cutout(drawing(hole=True))
        a = rgba[..., 3]
        self.assertEqual(a[186, 80], 0)  # the drop shadow
        self.assertEqual(a[130, 80], 0)  # a closed background-colored gap
        self.assertEqual(a[55, 80], 255)
        self.assertEqual(st["edge_opaque"], 0)
        self.assertEqual(st["shadow_left"], 0.0)

    def test_bottom_open_keeps_a_character_cut_by_the_bottom_edge(self) -> None:
        img = drawing(shadow=False)[:150]
        a = C.cutout(img, bottom_open=True)[0][..., 3]
        self.assertEqual(a[149, 80], 255)


@unittest.skipIf(np is None, "numpy / Pillow / scipy not installed")
class LayerTest(unittest.TestCase):
    def test_head_region_and_pivot(self) -> None:
        ref = drawing()
        alpha = C.cutout(ref)[0][..., 3]
        region, (px, py) = C.head_region(ref, drawing(head=False), alpha)
        self.assertTrue(region[55, 80])
        self.assertFalse(region[150, 80])
        self.assertEqual(px, 80)
        self.assertGreater(py, 85)

    def test_band_offset_finds_a_moved_body(self) -> None:
        ref = drawing()
        moved = C.shift(drawing(), 3, -2)
        offset, _ = C.band_offset(moved, ref, 80)
        self.assertEqual(offset, [-3, 2])

    def test_derive_writes_layers_parts_and_checks(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            src, out = Path(d, "src"), Path(d, "out")
            src.mkdir()
            save(drawing(), src / "ref.png")
            save(drawing(head=False), src / "headless.png")
            save(drawing(mouth=1), src / "frame-base-neutral-half.png")
            save(drawing(mouth=3), src / "frame-base-neutral-open.png")
            save(drawing(blink=True), src / "frame-base-neutral-blink.png")
            job = {
                "src": str(src),
                "out": str(out),
                "split": True,
                "bodies": [],
                "groups": [{"head": "base", "expr": "neutral", "frames": ["half", "open", "blink"]}],
            }
            r = C.derive_view(job)
            face = out / "face" / "base" / "neutral"
            for f in ("head.png", "mouth.png", "mouth.1.png", "eyes.0.png"):
                self.assertTrue((face / f).exists(), f)
            self.assertTrue((out / "body" / "stand.png").exists())
            self.assertEqual(r["pivot"][0], 80)
            checks = r["checks"]["base/neutral"]
            self.assertTrue(all(c["ok"] for c in checks.values()), checks)
            mouth = np.asarray(Image.open(face / "mouth.png"))[..., 3]
            self.assertGreater(mouth[55 + 16, 80], 200)  # the mouth part covers the mouth
            self.assertEqual(mouth[40, 80], 0)  # and not the eyes

    def test_post_flags_a_frame_that_did_not_change(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            save(drawing(), Path(d, "ref.png"))
            save(drawing(), Path(d, "same.png"))
            job = {
                "items": [
                    {
                        "id": "x",
                        "kind": "frame",
                        "frame": "open",
                        "image": str(Path(d, "same.png")),
                        "still": str(Path(d, "ref.png")),
                        "cutout": str(Path(d, "cut.png")),
                    }
                ]
            }
            Path(d, "job.json").write_text(json.dumps(job))
            res = subprocess.run(
                [sys.executable, str(HERE / "character.py"), "post", str(Path(d, "job.json"))],
                capture_output=True,
                text=True,
                check=True,
            )
            r = json.loads(res.stdout)[0]
            self.assertFalse(r["checks"]["change"]["ok"])
            self.assertFalse(r["ok"])

    def test_mouth_mask_takes_the_mouth_over_bigger_eyebrow_changes(self) -> None:
        still = drawing()
        frame = drawing(mouth=3)
        frame[24:36, 56:104] = (60, 40, 30)  # the edit also moved the eyebrows: a bigger change
        inside = C.cutout(still)[0][..., 3] > 128
        m = C.mouth_mask(still, [frame], inside)
        self.assertTrue(m[55 + 15, 80])
        self.assertFalse(m[32, 80])

    def test_the_mouth_part_leaves_out_a_redrawn_nose_and_jaw_line(self) -> None:
        still = big_eyes(drawing())
        frame = big_eyes(drawing(mouth=3))
        frame[58:65, 77:84] = (40, 35, 30)  # the edit redrew the nose above the mouth
        frame[80:84, 62:99] = (40, 35, 30)  # and a jaw line right below it
        frame[68:71, 93:114] = (40, 35, 30)  # and a cheek line beside it
        inside = C.cutout(still)[0][..., 3] > 128
        mb = C.PART_MIN_BLOB["full"]
        eyes = C.eye_blobs(still, big_eyes(drawing(), closed=True), inside, mb)
        m, _, keep_out = C.group_parts(still, {"open": frame}, inside, eyes, mb)
        self.assertTrue(m[55 + 15, 80])
        self.assertFalse(m[61, 80])
        self.assertFalse(m[82, 64])
        self.assertFalse(m[80, 80])  # not even right under the mouth: the jaw is a line apart
        self.assertFalse(m[69, 104])
        # Not pasted either: the part's grown edge must not bring the nose or the jaw back.
        a = C.part_region(m, inside.astype(np.float32), keep_out)
        self.assertLess(a[61, 80], 0.05)
        self.assertLess(a[82, 66], 0.05)
        self.assertGreaterEqual(float(a[m].min()), 0.95)  # the soft edge stays off the mouth

    def test_the_mouth_keeps_its_thin_corners_level_with_it(self) -> None:
        still = drawing()
        still[72:76, 60:101] = (150, 40, 50)  # a smile line wider than the open mouth
        frame = drawing()
        frame[64:87, 70:91] = (150, 40, 50)  # open: the line's ends are erased
        frame[60:66, 63:71] = (150, 40, 50)  # with an upturned corner
        inside = C.cutout(still)[0][..., 3] > 128
        m, _, keep_out = C.group_parts(still, {"open": frame}, inside, [], C.PART_MIN_BLOB["full"])
        # Left out, the still's line would show as dashes beside the open mouth.
        self.assertTrue(m[74, 62])
        self.assertTrue(m[74, 98])
        self.assertTrue(m[62, 66])
        a = C.part_region(m, inside.astype(np.float32), keep_out)
        self.assertGreaterEqual(float(a[m].min()), 0.95)

    def test_a_jaw_the_open_mouth_reaches_moves_whole(self) -> None:
        still = drawing()
        still[80:83, 56:105] = (40, 35, 30)  # a jaw line
        frame = drawing()
        frame[82:85, 56:105] = (40, 35, 30)  # pushed 2 px down by a mouth open to it
        frame[64:83, 70:91] = (150, 40, 50)
        inside = C.cutout(still)[0][..., 3] > 128
        m = C.mouth_mask(still, [frame], inside, min_blob=C.PART_MIN_BLOB["full"])
        # Cut at the part's edge, the jaw would step there.
        self.assertTrue(m[83, 64])
        self.assertTrue(m[83, 96])

    def test_the_erased_ends_of_a_smile_far_wider_than_the_mouth_stay(self) -> None:
        still = drawing()
        still[72:76, 55:106] = (150, 40, 50)  # a closed smile, much wider than the open mouth
        frame = drawing()
        frame[64:87, 70:91] = (150, 40, 50)  # a small open mouth; the smile's ends are erased
        inside = C.cutout(still)[0][..., 3] > 128
        m = C.mouth_mask(still, [frame], inside, min_blob=C.PART_MIN_BLOB["full"])
        self.assertTrue(m[74, 57])
        self.assertTrue(m[74, 103])

    def test_mouth_body_keeps_lines_going_on_from_the_mouth_but_not_the_nose(self) -> None:
        out = np.zeros((200, 200), bool)
        out[100:130, 80:120] = True  # the open mouth
        out[130:132, 62:138] = True  # a jaw line it reaches, running past its sides
        out[80:100, 109:111] = True  # a nose joined to it, off its centre (a glance)
        out[92:100, 80:82] = True  # an upturned corner
        body = C.mouth_body(out, out.copy(), 3)
        self.assertTrue(body[131, 63])
        self.assertTrue(body[131, 136])
        self.assertFalse(body[85, 110])
        self.assertTrue(body[93, 80])
        # A face outline the mouth touches, far wider than the mouth: not carried along.
        out[130:132, 20:180] = True
        self.assertFalse(C.mouth_body(out, out.copy(), 3)[131, 25])

    def test_a_line_moved_beside_the_mouth_is_not_taken_for_an_erased_one(self) -> None:
        still = drawing()
        still[72:76, 55:106] = (150, 40, 50)
        frame = drawing()
        frame[64:87, 70:91] = (150, 40, 50)
        frame[65:69, 55:65] = (150, 40, 50)  # the smile's ends moved up, not erased
        frame[65:69, 96:106] = (150, 40, 50)
        inside = C.cutout(still)[0][..., 3] > 128
        m = C.mouth_mask(still, [frame], inside, min_blob=C.PART_MIN_BLOB["full"])
        # Half pasted (the erased old place only), the line would vanish there: both or neither.
        self.assertEqual(m[74, 57], m[67, 57])

    def test_the_small_top_of_a_mouth_dropped_open_below_the_still_line_stays(self) -> None:
        out = np.zeros((200, 200), bool)
        out[89:100, 80:120] = True  # 11 rows above the still's mouth line (unchanged there)
        out[103:137, 80:120] = True  # 34 below it
        first = out.copy()
        first[:101] = False  # the mouth blob chosen: the big lower part
        body = C.mouth_body(out, first, 3)
        self.assertTrue(body[94, 100])
        self.assertTrue(body[120, 100])

    def test_a_nose_or_chin_shadow_close_to_the_mouth_is_not_its_top(self) -> None:
        out = np.zeros((200, 200), bool)
        out[100:134, 80:120] = True  # an open mouth
        out[83:97, 93:107] = True  # a redrawn nose 3 px above it
        out[137:147, 90:110] = True  # a chin shadow 3 px below
        body = C.mouth_body(out, out.copy(), 3)
        self.assertFalse(body[90, 100])
        self.assertFalse(body[142, 100])
        out[97:100, 99:101] = True  # joined to the mouth by a philtrum line
        self.assertFalse(C.mouth_body(out, out.copy(), 3)[90, 100])

    def test_a_bigger_change_joined_to_the_mouth_is_not_taken_for_it(self) -> None:
        still = drawing()
        frame = drawing(mouth=3)
        frame[58:73, 52:67] = (230, 150, 150)  # a redrawn blush, bigger than the mouth, within 12 px
        inside = C.cutout(still)[0][..., 3] > 128
        m = C.mouth_mask(still, [frame], inside)  # no eyes: no mouth box
        self.assertTrue(m[55 + 15, 80])
        self.assertFalse(m[64, 58])

    def test_a_small_mouth_of_a_full_length_figure_stays(self) -> None:
        still = drawing()
        frame = drawing(mouth=1)
        inside = C.cutout(still)[0][..., 3] > 128
        m = C.mouth_mask(still, [frame], inside, min_blob=C.PART_MIN_BLOB["full"])
        self.assertTrue(m[55 + 14, 80])

    def test_an_open_mouth_split_by_the_still_mouth_line_keeps_both_halves(self) -> None:
        still = drawing()
        still[74:77, 66:95] = (150, 40, 50)  # the still's closed mouth: a line
        frame = drawing()
        frame[66:85, 66:95] = (150, 40, 50)  # open, the same colour on the line: two blobs
        inside = C.cutout(still)[0][..., 3] > 128
        m = C.mouth_mask(still, [frame], inside)
        self.assertTrue(m[69, 80])
        self.assertTrue(m[81, 80])

    def post_frame(self, d: str, still: np.ndarray, frame: np.ndarray, name: str = "open") -> dict:
        save(still, Path(d, "still.png"))
        save(frame, Path(d, "frame.png"))
        return C.post_item(
            {
                "id": "x",
                "kind": "frame",
                "frame": name,
                "image": str(Path(d, "frame.png")),
                "still": str(Path(d, "still.png")),
                "input": str(Path(d, "still.png")),
                "cutout": str(Path(d, "cut.png")),
            }
        )

    def test_post_judges_a_frame_by_its_part_on_the_still(self) -> None:
        rng = np.random.default_rng(1)
        with tempfile.TemporaryDirectory() as d:
            # Faint blotches on the background are not rendered: only the part is pasted.
            frame = drawing(mouth=3)
            bg = (np.abs(frame - BG).max(axis=2) < 3)[..., None]
            blotched = frame + bg * rng.normal(0, 6, frame.shape)
            r = self.post_frame(d, drawing(), np.clip(blotched, 0, 255))
            self.assertTrue(r["ok"], r["checks"])
            # Grain on the skin around the new mouth is.
            grainy = np.clip(frame + rng.normal(0, 12, frame.shape), 0, 255)
            r = self.post_frame(d, drawing(), grainy)
            self.assertFalse(r["checks"]["part_grain"]["ok"], r["checks"])

    def test_post_leaves_a_blink_of_closed_eyes_to_the_reviewer(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            r = self.post_frame(d, drawing(blink=True), drawing(blink=True), "blink")
            self.assertFalse(r["checks"]["change"]["ok"])
            self.assertIn("approve by name", r["checks"]["change"]["limit"])

    def test_the_eyes_place_the_mouth_above_a_moved_collar(self) -> None:
        still = big_eyes(drawing())
        frame = big_eyes(drawing(mouth=3))
        frame[95:110, 55:105] = (60, 40, 30)  # a collar change, bigger and lower than the mouth
        inside = C.cutout(still)[0][..., 3] > 128
        # Small eyes, as on a full-length figure: the full-framing blob size finds them.
        mb = C.PART_MIN_BLOB["full"]
        blink = big_eyes(drawing(), closed=True)
        eyes = C.eye_blobs(still, blink, inside, mb)
        self.assertEqual(len(eyes), 2)
        self.assertEqual(C.eye_blobs(still, blink, inside), [])  # at 150 px they are lost
        m, _, _ = C.group_parts(still, {"open": frame}, inside, eyes, mb)
        self.assertTrue(m[55 + 15, 80])
        self.assertFalse(m[100, 80])

    def test_an_eye_and_its_eyebrow_are_not_a_pair_of_eyes(self) -> None:
        still = drawing()
        frame = drawing()
        frame[44:52, 60:76] = (60, 40, 30)  # one eye's change
        frame[30:37, 60:76] = (90, 60, 40)  # and its eyebrow's, right above it
        inside = C.cutout(still)[0][..., 3] > 128
        self.assertEqual(len(C.blobs(C.diff_mask(still, frame, inside, 30))), 2)
        self.assertEqual(C.eye_blobs(still, frame, inside, 30), [])

    def test_a_nudged_hand_does_not_hide_the_eyes(self) -> None:
        still = big_eyes(drawing())
        blink = big_eyes(drawing(), closed=True)
        blink[120:160, 50:70] = (60, 40, 30)  # the edit also moved a hand: a bigger blob
        alpha = C.cutout(still)[0][..., 3] > 128
        eyes = C.eye_blobs(still, blink, alpha, 40)
        self.assertEqual(len(eyes), 2)
        self.assertTrue(all(np.argwhere(e)[:, 0].mean() < 60 for e in eyes))

    def test_the_blink_part_keeps_the_eyes_not_the_eyebrows(self) -> None:
        still = big_eyes(drawing())
        blink = big_eyes(drawing(), closed=True)
        eyes = C.eye_blobs(still, blink, C.cutout(still)[0][..., 3] > 128, 40)
        blink[28:36, 60:100] = (60, 40, 30)  # the edit also lowered the eyebrows
        inside = C.cutout(still)[0][..., 3] > 128
        _, e, _ = C.group_parts(still, {"blink": blink}, inside, eyes, 40, own_eyes=True)
        self.assertTrue(e[50, 66])
        self.assertFalse(e[32, 80])

    def test_post_counts_a_blink_change_only_on_the_eyes(self) -> None:
        still = big_eyes(drawing())
        with tempfile.TemporaryDirectory() as d:
            hair_only = still.copy()
            hair_only[22:34, 70:90] = (60, 40, 30)  # a strand of hair moved, the eyes did not close
            frames = {"blink": str(Path(d, "blink.png"))}
            save(big_eyes(drawing(), closed=True), Path(d, "eyes-blink.png"))
            save(still, Path(d, "eyes-still.png"))
            save(hair_only, Path(d, "blink.png"))
            save(still, Path(d, "still.png"))
            r = C.post_item(
                {
                    "id": "x",
                    "kind": "frame",
                    "frame": "blink",
                    "framing": "full",
                    "image": frames["blink"],
                    "still": str(Path(d, "still.png")),
                    "cutout": str(Path(d, "cut.png")),
                    "eyes": [{"still": str(Path(d, "eyes-still.png")), "blink": str(Path(d, "eyes-blink.png"))}],
                }
            )
            self.assertFalse(r["checks"]["change"]["ok"], r["checks"])

    def test_a_close_up_looks_for_the_eyes_in_the_whole_drawing(self) -> None:
        # A head close-up cut at the shoulders: the eyes sit low, below the full-length band.
        still = big_eyes(drawing(shadow=False))[:75]
        blink = big_eyes(drawing(shadow=False), closed=True)[:75]
        self.assertEqual(C.eye_inside(still, True, framing="full")[1], C.EYE_TOP["full"])
        inside, top = C.eye_inside(still, True, framing="head")
        self.assertEqual(len(C.eye_blobs(still, blink, inside, 40, top)), 2)
        inside, top = C.eye_inside(still, True, framing="full")
        self.assertEqual(C.eye_blobs(still, blink, inside, 40, top), [])

    def test_a_hair_lock_at_eye_height_is_not_an_eye(self) -> None:
        still = big_eyes(drawing())
        blink = big_eyes(drawing(), closed=True)
        blink[38:64, 104:114] = (60, 40, 30)  # a lock of hair beside the face, bigger than an eye
        eyes = C.eye_blobs(still, blink, C.cutout(still)[0][..., 3] > 128, 40)
        self.assertEqual(len(eyes), 2)
        self.assertEqual(sorted(round(np.argwhere(e)[:, 1].mean()) for e in eyes), [66, 94])

    def test_eye_order_own_then_same_head_then_the_rest(self) -> None:
        groups = [("glance", "neutral"), ("base", "sad"), ("glance", "happy"), ("base", "neutral"), ("base", "happy")]
        self.assertEqual(
            C.eye_order(groups, "base", "neutral"),
            [("base", "neutral"), ("base", "happy"), ("base", "sad"), ("glance", "happy"), ("glance", "neutral")],
        )

    def test_post_looks_for_parts_in_the_head_region(self) -> None:
        # No eyes known: the lowest change would be a collar change, but it is outside the head.
        still = drawing()
        frame = drawing(mouth=3)
        frame[93:110, 55:105] = (60, 40, 30)  # touches the grown head region, below the pivot
        yy, xx = np.mgrid[0:H, 0:W]
        head = ((xx - 80) ** 2 + (yy - 55) ** 2 <= 36**2).astype(np.uint8) * 255
        with tempfile.TemporaryDirectory() as d:
            for name, img in (("still", still), ("frame", frame)):
                save(img, Path(d, f"{name}.png"))
            Image.fromarray(head).save(Path(d, "head.png"))
            item = {
                "id": "x",
                "kind": "frame",
                "frame": "open",
                "image": str(Path(d, "frame.png")),
                "still": str(Path(d, "still.png")),
                "cutout": str(Path(d, "cut.png")),
                "composite": str(Path(d, "comp.png")),
                "head_region": str(Path(d, "head.png")),
                "pivot_y": 86,
            }
            C.post_item(item)
            comp = np.asarray(Image.open(Path(d, "comp.png"))).astype(np.float32)
            self.assertLess(np.abs(comp[100, 80] - still[100, 80]).max(), 2)  # collar not pasted
            self.assertGreater(np.abs(comp[55 + 16, 80] - still[55 + 16, 80]).max(), 50)  # mouth pasted

    def test_eye_pairs_are_side_by_side_and_level(self) -> None:
        still = drawing()
        inside = C.cutout(still)[0][..., 3] > 128

        def pair(*boxes: tuple[int, int, int, int]) -> list:
            frame = still.copy()
            for y0, y1, x0, x1 in boxes:
                frame[y0:y1, x0:x1] = (60, 40, 30)
            return C.eye_blobs(still, frame, inside, 30)

        self.assertEqual(len(pair((44, 52, 58, 72), (44, 52, 88, 102))), 2)  # level eyes
        self.assertEqual(len(pair((44, 52, 58, 72), (50, 58, 88, 102))), 2)  # a tilted head
        self.assertEqual(pair((44, 52, 60, 74), (30, 38, 70, 84)), [])  # eye and eyebrow, diagonal
        self.assertEqual(pair((44, 52, 58, 72), (44, 52, 64, 78)), [])  # overlapping: one wide eye

    def test_post_ignores_changes_outside_the_head_above_the_pivot(self) -> None:
        still = drawing()
        frame = drawing(mouth=3)
        frame[100:112, 54:64] = (60, 40, 30)  # on the body, outside the head, above the pivot
        yy, xx = np.mgrid[0:H, 0:W]
        head = ((xx - 80) ** 2 + (yy - 55) ** 2 <= 36**2).astype(np.uint8) * 255
        with tempfile.TemporaryDirectory() as d:
            save(still, Path(d, "still.png"))
            save(frame, Path(d, "frame.png"))
            Image.fromarray(head).save(Path(d, "head.png"))
            item = {
                "id": "x",
                "kind": "frame",
                "frame": "open",
                "image": str(Path(d, "frame.png")),
                "still": str(Path(d, "still.png")),
                "cutout": str(Path(d, "cut.png")),
                "composite": str(Path(d, "comp.png")),
                "head_region": str(Path(d, "head.png")),
                "pivot_y": 120,
            }
            C.post_item(item)
            comp = np.asarray(Image.open(Path(d, "comp.png"))).astype(np.float32)
            self.assertLess(np.abs(comp[106, 59] - still[106, 59]).max(), 2)
            self.assertGreater(np.abs(comp[55 + 16, 80] - still[55 + 16, 80]).max(), 50)

    def test_a_tall_eye_never_becomes_part_of_the_mouth(self) -> None:
        # A turned head's far eye is tall and reaches below 0.25 x the eye distance under the eye
        # centres; the mouth frames also redrew it a little (test r6 glance: that eye joined the
        # mouth and was dropped from the blink, so only one eye blinked).
        still = big_eyes(drawing())
        still[40:66, 90:98] = (30, 25, 20)  # the right eye, tall
        blink = still.copy()
        blink[40:66, 90:98] = (250, 215, 195)
        blink[52:53, 88:100] = (30, 25, 20)
        blink[43:58, 59:73] = (250, 215, 195)
        blink[50:51, 59:73] = (30, 25, 20)
        frame = big_eyes(drawing(mouth=3))
        frame[40:66, 90:98] = (30, 25, 20)
        frame[60:66, 90:98] = (60, 40, 30)  # the open-mouth edit touched the bottom of that eye
        inside = C.cutout(still)[0][..., 3] > 128
        eyes = C.eye_blobs(still, blink, inside, 40)
        self.assertEqual(len(eyes), 2)
        m, e, _ = C.group_parts(still, {"open": frame, "blink": blink}, inside, eyes, 40, own_eyes=True)
        self.assertFalse(m[62, 94])  # the eye is not in the mouth part
        self.assertTrue(m[55 + 15, 80])  # the mouth is
        self.assertTrue(e[50, 66] and e[52, 94])  # both eyes blink

    def test_eye_white_tells_whether_a_blink_closes_the_eyes(self) -> None:
        still = anime_eyes(drawing())
        inside = C.cutout(still)[0][..., 3] > 128
        closed = anime_eyes(drawing(), "closed")
        eyes = C.eye_blobs(still, closed, inside, 40)
        self.assertEqual(len(eyes), 2)
        self.assertEqual(C.eyes_closed(still, closed, eyes, inside), ("closed", 0.0))
        # Redrawn eyes, pupils moved: the change finds the eyes, but their white stays (sora r6).
        redrawn = anime_eyes(drawing(), dx=-4)
        eyes = C.eye_blobs(still, redrawn, inside, 40)
        self.assertEqual(len(eyes), 2)
        self.assertEqual(C.eyes_closed(still, redrawn, eyes, inside)[0], "open")
        # Dark eyes without white cannot be judged (as before: approved on the change alone).
        dots, shut = big_eyes(drawing()), big_eyes(drawing(), closed=True)
        eyes = C.eye_blobs(dots, shut, inside, 40)
        self.assertEqual(C.eyes_closed(dots, shut, eyes, inside), ("unknown", 0.0))
        # The zone stays in the drawing: a bright background next to closed eyes is not eye white.
        eyes = C.eye_blobs(still, closed, inside, 40)
        # (a face outline just left of the eye: beyond it, bright background inside the zone)
        face = inside.copy()
        face[30:70, 40:54] = False
        lit_still, lit_closed = still.copy(), closed.copy()
        for img in (lit_still, lit_closed):
            img[30:70, 40:54] = 250
        self.assertEqual(C.eyes_closed(lit_still, lit_closed, eyes, face)[0], "closed")

    def test_choose_eyes_prefers_a_closing_blink_of_the_same_head(self) -> None:
        a, b, c = ([np.eye(2, dtype=bool)] * 2 for _ in range(3))
        calls = []

        def cand(key, same, eyes, state):
            return key, same, lambda: calls.append(key) or (eyes, state)

        # The own blink left the eyes open (its "eyes" may be bangs): the same head's closing one.
        r = C.choose_eyes([cand("own", True, a, "open"), cand("b", True, b, "closed")])
        self.assertEqual((r[0] is b, r[1], r[2], r[3]), (True, 1, "b", True))
        # Own eyes that cannot be judged give way to a closing blink of the same head only.
        r = C.choose_eyes([cand("own", True, a, "unknown"), cand("b", True, b, "closed")])
        self.assertEqual(r[1:], (1, "b", False))
        calls.clear()
        r = C.choose_eyes([cand("own", True, a, "unknown"), cand("c", False, c, "closed")])
        self.assertEqual(r[1:], (0, "own", False))
        self.assertEqual(calls, ["own"])  # other heads are not even loaded
        # Nothing but open blinks: no eyes.
        r = C.choose_eyes([cand("own", True, a, "open"), cand("c", False, c, "open")])
        self.assertEqual(r, ([], -1, None, True))

    def test_post_fails_a_blink_that_leaves_the_eyes_open(self) -> None:
        still = anime_eyes(drawing())
        with tempfile.TemporaryDirectory() as d:
            r = self.post_frame(d, still, anime_eyes(drawing(), dx=-4), "blink")
            self.assertFalse(r["checks"]["eyes_closed"]["ok"], r["checks"])
            r = self.post_frame(d, still, anime_eyes(drawing(), "closed"), "blink")
            self.assertTrue(r["checks"]["eyes_closed"]["ok"], r["checks"])
            # Left open, and only another head's blink to borrow: judged at its own eyes.
            other = {"still": str(Path(d, "o.png")), "blink": str(Path(d, "ob.png")), "key": "glance/x"}
            # (another head: its eyes sit lower, where this frame has no eye white)
            save(np.roll(big_eyes(drawing()), 30, axis=0), Path(d, "o.png"))
            save(np.roll(big_eyes(drawing(), closed=True), 30, axis=0), Path(d, "ob.png"))
            save(still, Path(d, "still.png"))
            save(anime_eyes(drawing(), dx=-4), Path(d, "frame.png"))
            item = {"id": "x", "kind": "frame", "frame": "blink", "image": str(Path(d, "frame.png"))}
            item |= {"still": str(Path(d, "still.png")), "cutout": str(Path(d, "cut.png")), "eyes": [other]}
            r = C.post_item(item)
            self.assertFalse(r["checks"]["eyes_closed"]["ok"], r["checks"])
            self.assertNotIn("eyes of", r["checks"]["eyes_closed"]["limit"])
            # Dark dot eyes: not judged.
            r = self.post_frame(d, big_eyes(drawing()), big_eyes(drawing(), closed=True), "blink")
            self.assertTrue(r["checks"]["eyes_closed"]["ok"], r["checks"])
            self.assertIn("can't judge", r["checks"]["eyes_closed"]["limit"])

    def test_post_and_derive_take_the_eyes_of_the_same_closing_blink(self) -> None:
        # The surprised group's own blink only redrew the eyes; the neutral blink closes them.
        neutral, surprised = anime_eyes(drawing()), anime_eyes(drawing(mouth=1))
        with tempfile.TemporaryDirectory() as d:
            src = Path(d, "src")
            src.mkdir()
            save(neutral, src / "ref.png")
            save(anime_eyes(drawing(), "closed"), src / "frame-base-neutral-blink.png")
            save(surprised, src / "still-base-surprised.png")
            save(anime_eyes(drawing(mouth=1), dx=-4), src / "frame-base-surprised-blink.png")
            pairs = (("base", "neutral"), ("base", "surprised"))
            groups = [{"head": h, "expr": e, "frames": ["blink"]} for h, e in pairs]
            eyes, own, own_open, key = C.view_eyes(src, groups, False, "full", None)("base", "surprised")
            self.assertEqual((len(eyes), own, own_open, key), (2, False, True, "base/neutral"))
            save(surprised, Path(d, "still.png"))
            r = C.post_item(
                {
                    "id": "x",
                    "kind": "frame",
                    "frame": "blink",
                    "image": str(src / "frame-base-surprised-blink.png"),
                    "still": str(Path(d, "still.png")),
                    "cutout": str(Path(d, "cut.png")),
                    "eyes": [
                        {
                            "still": str(src / "ref.png"),
                            "blink": str(src / "frame-base-neutral-blink.png"),
                            "key": "base/neutral",
                            "same_head": True,
                        }
                    ],
                }
            )
            check = r["checks"]["eyes_closed"]
            self.assertFalse(check["ok"], r["checks"])
            self.assertIn("eyes of base/neutral", check["limit"])


GOLDEN = HERE / "derive-golden.json"


def golden_cases(d: Path) -> dict:
    """derive on fixed synthetic views; what the renderer uses: layer pixels, pivot, offsets."""

    def arm(img: np.ndarray) -> np.ndarray:
        img = img.copy()
        img[95:105, 110:140] = (120, 190, 200)  # a raised arm (a pose body)
        return img

    cases = {}
    # a split view with a pose body, base/neutral and a happy still that borrows base's blink
    src = Path(d, "split", "src")
    src.mkdir(parents=True)
    save(drawing(), src / "ref.png")
    save(drawing(head=False), src / "headless.png")
    save(arm(drawing()), src / "body-wave.png")
    save(drawing(mouth=1), src / "frame-base-neutral-half.png")
    save(drawing(mouth=3), src / "frame-base-neutral-open.png")
    save(drawing(blink=True), src / "frame-base-neutral-blink.png")
    save(drawing(mouth=2), src / "still-base-happy.png")
    save(drawing(mouth=3), src / "frame-base-happy-half.png")
    save(drawing(mouth=4), src / "frame-base-happy-open.png")
    cases["split"] = {
        "src": str(src),
        "out": str(Path(d, "split", "out")),
        "split": True,
        "bodies": ["wave"],
        "groups": [
            {"head": "base", "expr": "neutral", "frames": ["half", "open", "blink"]},
            {"head": "base", "expr": "happy", "frames": ["half", "open"]},
        ],
    }
    # a close-up cut by the bottom edge, one image (not split)
    src = Path(d, "closeup", "src")
    src.mkdir(parents=True)
    crop = lambda img: big_eyes(img)[:150]  # noqa: E731
    save(crop(drawing(shadow=False)), src / "ref.png")
    save(crop(drawing(shadow=False, mouth=1)), src / "frame-base-neutral-half.png")
    save(crop(drawing(shadow=False, mouth=3)), src / "frame-base-neutral-open.png")
    save(big_eyes(drawing(shadow=False), closed=True)[:150], src / "frame-base-neutral-blink.png")
    cases["bottom_open"] = {
        "src": str(src),
        "out": str(Path(d, "closeup", "out")),
        "split": False,
        "bottom_open": True,
        "framing": "head",
        "bodies": [],
        "groups": [{"head": "base", "expr": "neutral", "frames": ["half", "open", "blink"]}],
    }
    out = {}
    for name, job in cases.items():
        r = C.derive_view(job)
        root = Path(job["out"])
        layers = {}
        for p in sorted(root.rglob("*.png")):
            a = np.asarray(Image.open(p).convert("RGBA"))
            layers[p.relative_to(root).as_posix()] = hashlib.sha256(str(a.shape).encode() + a.tobytes()).hexdigest()
        out[name] = {
            "layers": layers,
            "pivot": r["pivot"],
            "offsets": {k: g["offset"] for k, g in sorted(r["groups"].items())},
        }
    return out


@unittest.skipIf(np is None, "numpy / Pillow / scipy not installed")
class DeriveGoldenTest(unittest.TestCase):
    """What derive builds is tied to DERIVE_VERSION (S9b plan 3.1a): a change of the layers,
    pivots or offsets must raise it (s2v then rebuilds every character's layers)."""

    def test_derive_output_matches_the_golden_of_its_version(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            now = golden_cases(Path(d))
        if os.environ.get("S2V_WRITE_GOLDEN") == "1":
            GOLDEN.write_text(json.dumps({"derive_version": C.DERIVE_VERSION, "cases": now}, indent=2) + "\n")
        golden = json.loads(GOLDEN.read_text())
        rewrite = (
            "S2V_WRITE_GOLDEN=1 uv run --no-project --python 3.12 --with numpy==2.5.4 --with pillow==12.3.0"
            " --with scipy==1.18.1 python -m unittest discover -s imagegen"
        )
        self.assertEqual(
            golden["derive_version"],
            C.DERIVE_VERSION,
            f"DERIVE_VERSION is {C.DERIVE_VERSION}: rewrite the golden for it ({rewrite})",
        )
        self.assertEqual(
            now,
            golden["cases"],
            f"derive output changed: raise DERIVE_VERSION in character.py and rewrite the golden ({rewrite})",
        )
        # the cases cover what they are for: a body and a borrowed blink, a view without a head split
        self.assertIn("body/wave.png", now["split"]["layers"])
        self.assertIn("base/happy", now["split"]["offsets"])
        self.assertIsNone(now["bottom_open"]["pivot"])
        self.assertEqual(now["bottom_open"]["offsets"], {})

    def test_derive_version_is_a_plain_number_s2v_can_read(self) -> None:
        text = (HERE / "character.py").read_text()
        self.assertRegex(text, r"(?m)^DERIVE_VERSION = [1-9][0-9]*$")
        self.assertIsInstance(C.DERIVE_VERSION, int)


if __name__ == "__main__":
    unittest.main()

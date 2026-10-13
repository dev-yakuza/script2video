"""Image-step tests on synthetic drawings (needs numpy, Pillow, scipy; no MLX):
uv run --no-project --with numpy --with pillow --with scipy python -m unittest discover -s imagegen
"""

from __future__ import annotations

import json
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
        m, _ = C.group_parts(still, {"open": frame}, inside, eyes, mb)
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
        _, e = C.group_parts(still, {"blink": blink}, inside, eyes, 40, own_eyes=True)
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


if __name__ == "__main__":
    unittest.main()

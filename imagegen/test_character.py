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
        still = drawing()
        frame = drawing(mouth=3)
        frame[95:110, 55:105] = (60, 40, 30)  # a collar change, bigger and lower than the mouth
        inside = C.cutout(still)[0][..., 3] > 128
        # The eyes as a blink would find them (the toy eyes are below the blob size limit).
        yy, xx = np.mgrid[0:H, 0:W]
        eyes = [(xx - ex) ** 2 + (yy - 50) ** 2 <= 25 for ex in (68, 92)]
        m, _ = C.group_parts(still, {"open": frame}, inside, eyes)
        self.assertTrue(m[55 + 15, 80])
        self.assertFalse(m[100, 80])


if __name__ == "__main__":
    unittest.main()

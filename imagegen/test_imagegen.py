"""Stdlib-only tests (run in CI without MLX): python -m unittest discover -s imagegen"""

from __future__ import annotations

import contextlib
import io
import os
import subprocess
import sys
import time
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import models  # noqa: E402
import run  # noqa: E402


def job(tmp: Path, name: str = "a", **kw: object) -> dict:
    return {"out": str(tmp / f"{name}.png"), "prompt": "smile", "image": None, "seed": 7, **kw}


class RoundTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())

    def spec(self, **kw: object) -> dict:
        return {"width": 640, "height": 800, "jobs": [job(self.tmp)], **kw}

    def test_accepts_a_round_and_defaults_steps(self) -> None:
        self.assertEqual(run.check_round(self.spec())["steps"], 8)

    def test_rejects_bad_rounds(self) -> None:
        ref = self.tmp / "ref.png"
        ref.write_bytes(b"")
        bad = [
            ("width", self.spec(width=650)),
            ("width", self.spec(width=1040)),
            ("height", self.spec(height=True)),
            ("steps must be 8", self.spec(steps=4)),
            ("non-empty list", self.spec(jobs=[])),
            ("absolute .png", self.spec(jobs=[job(self.tmp, out="a.png")])),
            ("appears twice", self.spec(jobs=[job(self.tmp), job(self.tmp)])),
            ("temporary", self.spec(jobs=[job(self.tmp, out=str(self.tmp / "a.tmp.png"))])),
            ("prompt", self.spec(jobs=[job(self.tmp, prompt=" ")])),
            ("absolute path to a file", self.spec(jobs=[job(self.tmp, image=str(self.tmp / "nope.png"))])),
            ("absolute path to a file", self.spec(jobs=[job(self.tmp, image="ref.png")])),
            ("seed", self.spec(jobs=[job(self.tmp, seed=-1)])),
            ("seed", self.spec(jobs=[job(self.tmp, seed=2**32)])),
        ]
        for message, spec in bad:
            with self.subTest(message), self.assertRaisesRegex(run.JobError, message):
                run.check_round(spec)
        run.check_round(self.spec(jobs=[job(self.tmp, image=str(ref))]))

    def test_pending_skips_finished_images_and_drops_temporary_files(self) -> None:
        spec = run.check_round(self.spec(jobs=[job(self.tmp, "a"), job(self.tmp, "b")]))
        (self.tmp / "a.png").write_bytes(b"done")
        (self.tmp / "b.tmp.png").write_bytes(b"half")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            todo = run.pending(spec)
        self.assertEqual([Path(j["out"]).name for j in todo], ["b.png"])
        self.assertFalse((self.tmp / "b.tmp.png").exists())
        self.assertIn('"event": "skipped"', out.getvalue())

    def test_missing_mflux_internals_are_named(self) -> None:
        class Old:
            def generate_image(self) -> None: ...

        with self.assertRaisesRegex(run.EnvError, "_compute_dimensions, _encode_prompts_with_images"):
            run.check_internals(Old)


class ModelsTest(unittest.TestCase):
    def test_lifeline_exits_when_the_cli_goes_away(self) -> None:
        code = (
            f"import sys, time; sys.path.insert(0, {str(HERE)!r}); import models; "
            "models.exit_with_parent(); time.sleep(30)"
        )
        p = subprocess.Popen(
            [sys.executable, "-c", code], stdin=subprocess.PIPE, env={**os.environ, "S2V_LIFELINE": "1"}
        )
        time.sleep(0.5)
        t = time.time()
        p.stdin.close()  # what the OS does when the CLI is killed
        self.assertEqual(p.wait(10), 1)
        self.assertLess(time.time() - t, 5)

    def test_folders_keep_the_lock_name_and_count_only_with_a_marker(self) -> None:
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"S2V_MODELS_DIR": d}):
            lock = models.load_lock()
            q = models.quantized_path(lock)
            self.assertEqual(q.name, "qwen-image-edit-2511-q4__6f3ccc0b56e4")
            self.assertEqual(len(models.ready(lock)), 2)
            q.mkdir(parents=True)
            models.mark_complete(q, {})
            lora = models.lora_file(lock)
            lora.parent.mkdir(parents=True)
            lora.write_bytes(b"")
            self.assertEqual(len(models.ready(lock)), 1)  # downloaded but not finished
            models.mark_complete(lora.parent, {})
            self.assertEqual(models.ready(lock), [])


if __name__ == "__main__":
    unittest.main()

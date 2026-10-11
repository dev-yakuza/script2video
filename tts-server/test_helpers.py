"""Stdlib-only tests (run in CI without torch): python -m unittest discover -s tts-server"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "scripts"))

from fetch_models import snapshot_path  # noqa: E402
from helpers import qwen_token_cap, sentence_seed  # noqa: E402


class HelpersTest(unittest.TestCase):
    def test_seed_is_stable_and_63_bit(self) -> None:
        a = sentence_seed("abc:0")
        self.assertEqual(a, sentence_seed("abc:0"))
        self.assertNotEqual(a, sentence_seed("abc:1"))
        self.assertLess(a, 1 << 63)
        # Fixed value: changing it would change every cached take's seed.
        self.assertEqual(sentence_seed("script2video"), 0x26CD2236C11C309A)

    def test_token_cap_grows_with_text(self) -> None:
        self.assertEqual(qwen_token_cap(""), 36)
        self.assertGreater(qwen_token_cap("가" * 100), qwen_token_cap("가" * 10))

    def test_snapshot_dir_name_matches_the_cli(self) -> None:
        # packages/cli/src/doctor.ts builds the same name; both must agree.
        p = snapshot_path("qwen3-tts-1.7b-customvoice", "0c0e3051f131929182e2c023b9537f8b1c68adfe")
        self.assertEqual(p.name, "qwen3_tts_1_7b_customvoice__0c0e3051f131")


if __name__ == "__main__":
    unittest.main()

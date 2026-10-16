"""Stdlib-only tests (run in CI without torch): python -m unittest discover -s tts-server"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "scripts"))

from fetch_models import snapshot_path  # noqa: E402
import json  # noqa: E402
import tempfile  # noqa: E402

from helpers import qwen_token_cap, read_speaker, sentence_seed, trained_request_error, vector_sha  # noqa: E402


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


# the same vector and sha as packages/cli/test/trained.test.ts (TS vectorShaOf)
VECTOR = [(i % 97) / 97 - 0.5 for i in range(2048)]
VECTOR_SHA = "19951df2c2bbb16a0591221c3f18bdff4e47c8d7a8d72891f706b9d7ccbe6512"


class SpeakerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write(self, data: object) -> str:
        p = Path(self.tmp.name) / f"s{len(list(Path(self.tmp.name).iterdir()))}.json"
        p.write_text(json.dumps(data))
        return str(p)

    def test_sha_matches_the_cli(self) -> None:
        self.assertEqual(vector_sha(VECTOR), VECTOR_SHA)

    def test_reads_a_good_file_and_refuses_a_damaged_one(self) -> None:
        good = {"version": 1, "vector": VECTOR, "vectorSha": VECTOR_SHA}
        self.assertEqual(read_speaker(self.write(good))[1], VECTOR_SHA)
        for bad in (
            {**good, "vector": VECTOR[:-1]},
            {**good, "vector": [0.1] + VECTOR[1:]},
            {**good, "version": 2},
            # a bool in place of 1.0, with the sha it would have: refused for being a bool
            {**good, "vector": [True] + VECTOR[1:], "vectorSha": vector_sha([1.0] + VECTOR[1:])},
            {**good, "vector": [10**400] + VECTOR[1:]},
            {**good, "vector": [3.5e38] + VECTOR[1:]},
            [1, 2, 3],
        ):
            with self.assertRaises(ValueError):
                read_speaker(self.write(bad))
        with self.assertRaises(FileNotFoundError):
            read_speaker("/nonexistent/speaker.json")

    def test_request_checks(self) -> None:
        self.assertIsNone(trained_request_error("1.7b", "/a.json", "abc"))
        self.assertIsNotNone(trained_request_error("0.6b", "/a.json", "abc"))
        self.assertIsNotNone(trained_request_error("1.7b", None, "abc"))
        self.assertIsNotNone(trained_request_error("1.7b", "/a.json", None))


if __name__ == "__main__":
    unittest.main()

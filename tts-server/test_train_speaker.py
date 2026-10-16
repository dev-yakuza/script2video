"""Stdlib-only tests of train_speaker.py's helpers (CI runs them without torch)."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from train_speaker import (  # noqa: E402
    atomic_write,
    best_epoch,
    epoch_order,
    read_vector,
    split_holdout,
    vector_json,
)


class TrainHelpersTest(unittest.TestCase):
    def test_holdout_is_the_s2_split(self) -> None:
        val, tr = split_holdout(list(range(40)))
        self.assertEqual(len(val), 12)
        self.assertEqual(sorted(val + tr), list(range(40)))
        self.assertEqual(split_holdout(list(range(40))), (val, tr))
        # S2's permutation (Python's Random(0)): a change here moves the validation set
        self.assertEqual(val, [0, 27, 12, 21, 29, 15, 38, 34, 1, 20, 7, 5])

    def test_epoch_order_needs_no_replay(self) -> None:
        tr = list(range(30))
        a = epoch_order(tr, 3)
        self.assertEqual(a, epoch_order(tr, 3))  # the same after a resume
        self.assertNotEqual(a, epoch_order(tr, 4))
        self.assertEqual(tr, list(range(30)))  # the base order is not changed

    def test_best_epoch_skips_the_initial_vector(self) -> None:
        self.assertEqual(best_epoch({0: 1.0, 1: 2.5, 2: 2.1, 3: 2.1}), 2)

    def test_vectors_round_trip_with_their_sha(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "v.json"
            atomic_write(p, vector_json([0.5, -0.25], epoch=3))
            self.assertEqual(read_vector(p), [0.5, -0.25])
            data = json.loads(p.read_text())
            data["vector"][0] = 0.6
            p.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                read_vector(p)


if __name__ == "__main__":
    unittest.main()

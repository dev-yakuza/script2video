"""The lifeline (S8): the server exits when the CLI that started it is gone."""

import os
import subprocess
import sys
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
CODE = (
    "import sys, time; sys.path.insert(0, sys.argv[1]); "
    "from lifeline import exit_with_parent; exit_with_parent(); "
    "print('ready', flush=True); time.sleep(20)"
)


def start(lifeline: bool) -> subprocess.Popen:
    env = {k: v for k, v in os.environ.items() if k != "S2V_LIFELINE"}
    if lifeline:
        env["S2V_LIFELINE"] = "1"
    p = subprocess.Popen(
        [sys.executable, "-c", CODE, str(HERE)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env
    )
    assert p.stdout is not None
    p.stdout.readline()
    return p


class LifelineTest(unittest.TestCase):
    def test_exits_when_stdin_closes(self):
        p = start(True)
        t0 = time.monotonic()
        assert p.stdin is not None
        p.stdin.close()
        self.assertEqual(p.wait(timeout=5), 1)
        self.assertLess(time.monotonic() - t0, 2)

    def test_does_nothing_without_the_variable(self):
        p = start(False)
        assert p.stdin is not None
        p.stdin.close()
        with self.assertRaises(subprocess.TimeoutExpired):
            p.wait(timeout=1)
        p.kill()
        p.wait()


if __name__ == "__main__":
    unittest.main()

"""The CI's image-step test run pins numpy / Pillow / scipy (S9b plan 3.1a): they must be the
versions imagegen/uv.lock resolves (uv cannot sync that project on linux: MLX).

    python scripts/check_imagegen_pins.py   # exit 1 when a pin differs from imagegen/uv.lock
"""

from __future__ import annotations

import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGES = ("numpy", "pillow", "scipy")


# where the pinned command is written: the CI step, and the test's own instructions
FILES = (".github/workflows/ci.yml", "imagegen/test_character.py")


def main() -> int:
    lock = tomllib.loads((ROOT / "imagegen" / "uv.lock").read_text())
    locked = {p["name"]: p["version"] for p in lock["package"] if p["name"] in PACKAGES}
    bad = []
    for rel in FILES:
        text = (ROOT / rel).read_text()
        for name in PACKAGES:
            pinned = re.findall(rf"--with {name}==([\w.]+)", text)
            if not pinned:
                bad.append(f"{rel}: {name} is not pinned")
            for v in pinned:
                if v != locked.get(name):
                    bad.append(f"{rel}: {name}=={v}, imagegen/uv.lock has {locked.get(name)}")
    for line in bad:
        print(line, file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())

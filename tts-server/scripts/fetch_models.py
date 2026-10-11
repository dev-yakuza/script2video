"""Download pinned model snapshots listed in models.lock.json.

Usage:
    uv run python scripts/fetch_models.py qwen3-tts-1.7b-customvoice supertonic-3
    uv run python scripts/fetch_models.py --all

Snapshots are stored under $S2V_MODELS_DIR (default: ~/.cache/script2video/models)
as <name>__<revision[:12]> with non-identifier characters replaced by "_" (transformers
derives Python module names from the directory name), so a revision bump never overwrites
an older snapshot.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
LOCK_PATH = REPO_ROOT / "models.lock.json"


def models_dir() -> Path:
    return Path(os.environ.get("S2V_MODELS_DIR", Path.home() / ".cache" / "script2video" / "models"))


def snapshot_path(name: str, revision: str) -> Path:
    safe = re.sub(r"[^0-9A-Za-z_]", "_", name)
    return models_dir() / f"{safe}__{revision[:12]}"


def load_lock() -> dict[str, dict[str, str]]:
    return json.loads(LOCK_PATH.read_text())["models"]


def fetch(name: str, entry: dict[str, str]) -> Path:
    target = snapshot_path(name, entry["revision"])
    print(f"[fetch] {name}: {entry['repo']}@{entry['revision'][:12]} -> {target}", flush=True)
    from huggingface_hub import snapshot_download  # only needed to download

    snapshot_download(repo_id=entry["repo"], revision=entry["revision"], local_dir=target)
    return target


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("names", nargs="*")
    parser.add_argument("--all", action="store_true")
    args = parser.parse_args()

    lock = load_lock()
    names = list(lock) if args.all else args.names
    unknown = [n for n in names if n not in lock]
    if not names or unknown:
        print(f"unknown or missing model names: {unknown or '(none given)'}; known: {', '.join(lock)}", file=sys.stderr)
        return 2
    for name in names:
        fetch(name, lock[name])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

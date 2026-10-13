"""Model folders of imagegen.lock.json (the CLI's doctor and setup use the same rule).

Folders: $S2V_MODELS_DIR/<name>__<revision[:12]> with the lock name as is (unlike models.lock.json,
whose names are made identifier-safe for transformers). A folder counts only with its marker file,
written after the download or quantization finished: an interrupted 54 GB download is not a model.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
LOCK_PATH = REPO_ROOT / "imagegen.lock.json"
MARKER = ".s2v-complete"


def exit_with_parent() -> None:
    """With S2V_LIFELINE=1 (set by the CLI), stdin is a pipe from the CLI: when it closes because
    the CLI died without stopping us (SIGKILL, crash), exit instead of running on unwatched."""
    if os.environ.get("S2V_LIFELINE") != "1":
        return

    def watch() -> None:
        # os.read, not sys.stdin: a daemon thread blocked in a buffered read holds its lock and
        # aborts the interpreter's normal shutdown.
        while os.read(0, 4096):
            pass
        os._exit(1)

    threading.Thread(target=watch, daemon=True).start()


def models_dir() -> Path:
    return Path(os.environ.get("S2V_MODELS_DIR", Path.home() / ".cache" / "script2video" / "models"))


def load_lock() -> dict:
    return json.loads(LOCK_PATH.read_text())


def model_path(name: str, revision: str) -> Path:
    return models_dir() / f"{name}__{revision[:12]}"


def quantized_path(lock: dict) -> Path:
    q = lock["quantized"]
    return model_path(q["name"], lock["models"][q["from"]]["revision"])


def lora_file(lock: dict) -> Path:
    lo = lock["lora"]
    return model_path(lo["model"], lock["models"][lo["model"]]["revision"]) / lo["file"]


def is_complete(path: Path) -> bool:
    return (path / MARKER).exists()


def mark_complete(path: Path, info: dict) -> None:
    (path / MARKER).write_text(json.dumps(info, indent=2) + "\n")


def ready(lock: dict) -> list[str]:
    """What is missing for generation (empty = ready): the quantized model and the LoRA."""
    missing = []
    q = quantized_path(lock)
    if not is_complete(q):
        missing.append(f"{lock['quantized']['name']} ({q})")
    lo = lora_file(lock)
    if not is_complete(lo.parent) or not lo.exists():
        missing.append(f"{lock['lora']['model']} ({lo})")
    return missing

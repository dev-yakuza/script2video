"""Pure helpers of the TTS server (no third-party imports, so CI can test them cheaply)."""

from __future__ import annotations

import hashlib
import json
import math
import os
import struct
import threading
from pathlib import Path


def exit_with_parent() -> None:
    """With S2V_LIFELINE=1, stdin is a pipe from the CLI that started this server: exit when it
    closes, so a CLI killed outright (SIGKILL) leaves no server holding tens of GB (S8)."""
    if os.environ.get("S2V_LIFELINE") != "1":
        return

    def watch() -> None:
        while os.read(0, 4096):
            pass
        os._exit(1)

    threading.Thread(target=watch, daemon=True).start()


def sentence_seed(seed_material: str) -> int:
    """First 8 bytes of sha256 as an unsigned int, masked to 63 bits (PLAN 5.1)."""
    return int.from_bytes(hashlib.sha256(seed_material.encode()).digest()[:8], "big") & ((1 << 63) - 1)


def qwen_token_cap(text: str) -> int:
    """12 codec frames/s; runaway decodes otherwise run to 8192 tokens."""
    return int(12 * (len(text) * 0.35 + 3))


SPEAKER_DIM = 2048


def vector_sha(vector: list[float]) -> str:
    """sha256 of the vector as float32 little-endian bytes (the same in the CLI's persona.ts)."""
    return hashlib.sha256(struct.pack(f"<{len(vector)}f", *vector)).hexdigest()


FLOAT32_MAX = 3.4028234663852886e38


def read_speaker(path: str) -> tuple[list[float], str]:
    """A trained speaker file (acting stage 4): its vector and sha, checked. ValueError if not."""
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(f"speaker file not found: {path}")
    try:
        data = json.loads(p.read_text())
    except (ValueError, OSError) as e:
        raise ValueError(f"{path}: cannot read ({e})") from e
    if not isinstance(data, dict):
        raise ValueError(f"{path}: not a speaker file")
    if data.get("version") != 1:
        raise ValueError(f"{path}: version {data.get('version')} is not supported")
    vec = data.get("vector")
    if (
        not isinstance(vec, list)
        or len(vec) != SPEAKER_DIM
        # bool is an int in Python; TS refuses it, so do we
        or not all(isinstance(x, (int, float)) and not isinstance(x, bool) and _float32_ok(x) for x in vec)
    ):
        raise ValueError(f"{path}: vector must be {SPEAKER_DIM} finite numbers")
    sha = vector_sha(vec)
    if sha != data.get("vectorSha"):
        raise ValueError(f"{path}: vectorSha does not match the vector")
    return [float(x) for x in vec], sha


def _float32_ok(x: float) -> bool:
    try:
        return math.isfinite(x) and abs(x) <= FLOAT32_MAX
    except OverflowError:  # an int too large for a float
        return False


def trained_request_error(model_size: str, speaker_path: str | None, vector_sha: str | None) -> str | None:
    """Why a persona-trained request cannot be served (400), or None."""
    if model_size != "1.7b":
        return "trained speakers are for the 1.7B model"
    if not speaker_path or not vector_sha:
        return "persona-trained needs speaker_path and vector_sha"
    return None

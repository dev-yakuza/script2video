"""Pure helpers of the TTS server (no third-party imports, so CI can test them cheaply)."""

from __future__ import annotations

import hashlib


def sentence_seed(seed_material: str) -> int:
    """First 8 bytes of sha256 as an unsigned int, masked to 63 bits (PLAN 5.1)."""
    return int.from_bytes(hashlib.sha256(seed_material.encode()).digest()[:8], "big") & ((1 << 63) - 1)


def qwen_token_cap(text: str) -> int:
    """12 codec frames/s; runaway decodes otherwise run to 8192 tokens."""
    return int(12 * (len(text) * 0.35 + 3))

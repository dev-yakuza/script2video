"""Pure pitch helpers of the aligner (no third-party imports, so CI can test them cheaply)."""

from __future__ import annotations

import math
from statistics import median

# The ending is the last fifth of the voiced frames (acting plan 3.5).
ENDING_SHARE = 0.2
# Too few voiced frames to tell an ending from the rest.
MIN_VOICED = 10


def ending_semitones(voiced_hz: list[float]) -> float | None:
    """Median F0 of the last 20% of the voiced frames minus the median of all, in semitones.

    Negative when the sentence ends lower than it is spoken overall (a falling ending).
    """
    f = [x for x in voiced_hz if x > 0 and not math.isnan(x)]
    if len(f) < MIN_VOICED:
        return None
    tail = f[-max(1, round(len(f) * ENDING_SHARE)) :]
    return 12 * math.log2(median(tail) / median(f))


# A frame has sound when its RMS is above max(SOUND_FLOOR, SOUND_SHARE × the 95th percentile)
# (E1b `analyse`, acting stage 2 plan 4.1).
SOUND_FLOOR = 0.004
SOUND_SHARE = 0.04


def sound_frames(rms: list[float]) -> list[bool]:
    """Frames that carry sound (speech or not)."""
    if not rms:
        return []
    s = sorted(rms)
    p95 = s[min(len(s) - 1, max(0, round(0.95 * (len(s) - 1))))]
    level = max(SOUND_FLOOR, SOUND_SHARE * p95)
    return [x > level for x in rms]


def edges_and_noise(voiced: list[bool], sound: list[bool], hop_s: float) -> dict[str, float]:
    """Non-speech around and inside a take, in seconds.

    lead: sound before the first voiced frame, tail: sound after the last voiced frame,
    noise: all sound frames that are not voiced (breaths, sighs, unvoiced consonants).
    """
    n = min(len(voiced), len(sound))
    voiced, sound = voiced[:n], sound[:n]
    v = [i for i in range(n) if voiced[i]]
    s = [i for i in range(n) if sound[i]]
    lead = (v[0] - s[0]) * hop_s if v and s else 0.0
    tail = (s[-1] - v[-1]) * hop_s if v and s else 0.0
    noise = sum(1 for i in range(n) if sound[i] and not voiced[i]) * hop_s
    return {"lead_s": max(lead, 0.0), "tail_s": max(tail, 0.0), "noise_s": noise}

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

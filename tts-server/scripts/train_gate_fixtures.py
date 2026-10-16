"""Expected values for packages/core/test/train-gates.test.ts, computed once with librosa/numpy as
the S2 experiment did (s2gen.longest_pause, np.percentile). Run with the tts-server venv:

    tts-server/.venv/bin/python tts-server/scripts/train_gate_fixtures.py

Then `yarn prettier --write packages/core/test/fixtures`. The TS test rebuilds the signals from the
same recipe (segments of sine and silence).
"""

import json
import math
from pathlib import Path

import librosa
import numpy as np

OUT = Path(__file__).resolve().parents[2] / "packages/core/test/fixtures/train-gates.ts"


def signal(sr: int, segments: list[list[float]]) -> np.ndarray:
    """[seconds, amplitude, hz] segments; amplitude 0 is silence. Rounded to int16 as a wav would."""
    parts = []
    for seconds, amp, hz in segments:
        n = int(round(seconds * sr))
        t = np.arange(n, dtype=np.float64) / sr
        parts.append(amp * np.sin(2 * math.pi * hz * t))
    y = np.concatenate(parts)
    return (np.round(y * 32767) / 32768).astype(np.float32)


def longest_pause(y: np.ndarray, sr: int) -> float:
    hop = int(sr * 0.01)
    db = 20 * np.log10(librosa.feature.rms(y=y, frame_length=hop * 4, hop_length=hop)[0] + 1e-9)
    quiet = db < np.percentile(db, 90) - 30
    loud = np.nonzero(~quiet)[0]
    best, run = 0, 0
    for q in quiet[loud[0] : loud[-1]] if loud.size else []:
        run = run + 1 if q else 0
        best = max(best, run)
    return round(best * 0.01, 2)


CASES = [
    {"sr": 24000, "segments": [[0.2, 0, 0], [0.6, 0.5, 220], [0.5, 0, 0], [0.7, 0.4, 330], [0.3, 0, 0]]},
    {"sr": 24000, "segments": [[0.05, 0, 0], [1.0, 0.3, 180], [0.12, 0.002, 180], [0.8, 0.3, 200]]},
    {"sr": 16000, "segments": [[0.4, 0.2, 150], [0.9, 0, 0], [0.4, 0.2, 150]]},
    {"sr": 24000, "segments": [[1.2, 0.5, 260]]},
]
PERCENTILES = [[3, 1, 4, 1, 5, 9, 2, 6], [10.0], [-80.5, -20.25, -33.0, -180.0, -12.0]]

cases = [{**c, "pause": longest_pause(signal(c["sr"], c["segments"]), c["sr"])} for c in CASES]
pcts = [{"xs": xs, "p90": float(np.percentile(xs, 90)), "p37": float(np.percentile(xs, 37))} for xs in PERCENTILES]
OUT.parent.mkdir(parents=True, exist_ok=True)
data = {"librosa": librosa.__version__, "numpy": np.__version__, "pause": cases, "percentile": pcts}
OUT.write_text(
    "// Written by tts-server/scripts/train_gate_fixtures.py (librosa/numpy); do not edit.\n"
    f"export const FIXTURES = {json.dumps(data, indent=1)};\n"
)
print(OUT.read_text())

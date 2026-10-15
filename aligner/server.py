"""script2video aligner server (PLAN 5.3): word timing + ASR round-trip.

Separate uv project because qwen-asr pins transformers 4.57.6 (qwen-tts pins 4.57.3).

Endpoints (loopback only):
  GET  /health      identity, versions, lock hash, loaded models
  POST /align       {wav_path, text, lang} -> {words: [{text, start, end}]}   (80 ms grid)
  POST /transcribe  {wav_path, lang}       -> {text}
  POST /pitch       {wav_path}             -> {median_hz, voiced_ratio, ending_st}

Audio is passed by local path: the Node orchestrator and this server share the filesystem, and
sentence wavs already live in the audio lock / cache.

Run:  uv run --frozen --offline python server.py [--port 47862]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Literal

import soundfile as sf
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from pitch_helpers import ending_semitones  # noqa: E402

SERVER_ID = "script2video-aligner"
WRAPPER_VERSION = "0.3.0"
LANG = {"ko": "Korean", "ja": "Japanese", "en": "English"}
# qwen-asr's timestamp path caps alignment input at 180 s (MAX_FORCE_ALIGN_INPUT_SECONDS).
MAX_ALIGN_SECONDS = 180

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")


def lock() -> dict:
    return json.loads((REPO_ROOT / "models.lock.json").read_text())["models"]


def snapshot(name: str) -> Path:
    sys.path.insert(0, str(REPO_ROOT / "tts-server" / "scripts"))
    from fetch_models import snapshot_path

    return snapshot_path(name, lock()[name]["revision"])


def lock_hash() -> str:
    data = (REPO_ROOT / "models.lock.json").read_bytes() + (HERE / "uv.lock").read_bytes()
    return hashlib.sha256(data).hexdigest()[:16]


class AlignRequest(BaseModel):
    wav_path: str
    text: str = Field(min_length=1)
    lang: Literal["ko", "ja", "en"]


class PitchRequest(BaseModel):
    wav_path: str


class TranscribeRequest(BaseModel):
    wav_path: str
    lang: Literal["ko", "ja", "en"]


class Models:
    def __init__(self, device: str):
        self.device = device
        self._aligner = None
        self._asr = None
        self._lock = threading.Lock()

    def _dtype(self):
        import torch

        return torch.bfloat16 if self.device != "cpu" else torch.float32

    def aligner(self):
        if self._aligner is None:
            from qwen_asr import Qwen3ForcedAligner

            self._aligner = Qwen3ForcedAligner.from_pretrained(
                str(snapshot("qwen3-forcedaligner-0.6b")), device_map=self.device, dtype=self._dtype()
            )
        return self._aligner

    def asr(self):
        if self._asr is None:
            from qwen_asr import Qwen3ASRModel

            self._asr = Qwen3ASRModel.from_pretrained(
                str(snapshot("qwen3-asr-0.6b")), device_map=self.device, dtype=self._dtype()
            )
        return self._asr

    def loaded(self) -> list[str]:
        return (["qwen3-forcedaligner-0.6b"] if self._aligner else []) + (["qwen3-asr-0.6b"] if self._asr else [])


def read_wav(path: str):
    p = Path(path)
    if not p.is_file():
        raise HTTPException(404, f"wav not found: {path}")
    wav, sr = sf.read(p, dtype="float32")
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    return wav, sr


def create_app(device: str) -> FastAPI:
    app = FastAPI(title=SERVER_ID)
    models = Models(device)
    started = time.time()

    @app.get("/health")
    def health() -> dict:
        import torch
        import transformers

        return {
            "id": SERVER_ID,
            "wrapper_version": WRAPPER_VERSION,
            "lock_hash": lock_hash(),
            "models": {k: lock()[k]["revision"] for k in ("qwen3-forcedaligner-0.6b", "qwen3-asr-0.6b")},
            "loaded": models.loaded(),
            "device": device,
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "uptime_s": round(time.time() - started, 1),
        }

    @app.post("/align")
    def align(req: AlignRequest) -> dict:
        wav, sr = read_wav(req.wav_path)
        if len(wav) / sr > MAX_ALIGN_SECONDS:
            raise HTTPException(400, f"audio longer than {MAX_ALIGN_SECONDS}s; split it first")
        with models._lock:
            items = models.aligner().align(audio=(wav, sr), text=req.text, language=LANG[req.lang])[0]
        return {"words": [{"text": it.text, "start": it.start_time, "end": it.end_time} for it in items]}

    @app.post("/pitch")
    def pitch(req: PitchRequest) -> dict:
        """Median F0 of the voiced frames (Hz), for voice-consistency checks, and the ending: how far
        the last fifth of the voiced frames sits from that median (semitones, acting plan 3.5)."""
        import librosa
        import numpy as np

        wav, sr = read_wav(req.wav_path)
        y = librosa.resample(wav, orig_sr=sr, target_sr=16000) if sr != 16000 else wav
        f0, voiced, _ = librosa.pyin(y, fmin=65, fmax=600, sr=16000, frame_length=1024)
        f = f0[~np.isnan(f0)]
        return {
            "median_hz": float(np.median(f)) if f.size else None,
            "voiced_ratio": float(np.mean(voiced)),
            "ending_st": ending_semitones([float(x) for x in f]),
        }

    @app.post("/transcribe")
    def transcribe(req: TranscribeRequest) -> dict:
        wav, sr = read_wav(req.wav_path)
        with models._lock:
            result = models.asr().transcribe(audio=(wav, sr), language=LANG[req.lang])[0]
        return {"text": result.text}

    return app


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=47862)
    parser.add_argument("--device", choices=["mps", "cpu", "cuda"], default=None)
    args = parser.parse_args()
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print(f"warning: binding to non-loopback address {args.host}", file=sys.stderr)

    import torch
    import uvicorn

    device = args.device or (
        "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
    )
    uvicorn.run(create_app(device), host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

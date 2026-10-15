"""script2video TTS server (PLAN 5.1).

Engines (all usable as final voice, lazily loaded on first use):
  qwen        Qwen3-TTS CustomVoice (preset speakers, optional instruction on 1.7B)
  persona     Qwen3-TTS Base voice clone from a fixed reference clip (PLAN 5.8)
  supertonic  Supertonic-3 (10 preset voices, ONNX on CPU)

Endpoints (loopback only):
  GET  /health      identity, versions, lock hash, loaded models
  POST /synthesize  -> audio/wav body; metadata in X-S2V-* headers
  POST /design      VoiceDesign: description -> reference clip for a persona (audio/wav body)
  POST /embed       speaker x-vector of a wav (1.7B Base speaker encoder), for voice consistency

Run:  uv run --frozen --offline python server.py [--port 47861] [--host 127.0.0.1]
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
sys.path.insert(0, str(HERE / "scripts"))
from fetch_models import load_lock, snapshot_path  # noqa: E402
from helpers import qwen_token_cap, sentence_seed  # noqa: E402

SERVER_ID = "script2video-tts"
WRAPPER_VERSION = "0.3.0"
QWEN_LANG = {"ko": "Korean", "ja": "Japanese", "en": "English"}
QWEN_MODELS = {"1.7b": "qwen3-tts-1.7b-customvoice", "0.6b": "qwen3-tts-0.6b-customvoice"}
BASE_MODEL = "qwen3-tts-1.7b-base"
DESIGN_MODEL = "qwen3-tts-1.7b-voicedesign"
SUPERTONIC_DEFAULT_SPEED = 1.05  # our speed 1.0 maps to Supertonic's default (PLAN 5.2)

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")


def lock_hash() -> str:
    data = (REPO_ROOT / "models.lock.json").read_bytes() + (HERE / "uv.lock").read_bytes()
    return hashlib.sha256(data).hexdigest()[:16]


class SynthesizeRequest(BaseModel):
    engine: Literal["qwen", "persona", "supertonic"]
    voice: str = Field(description="qwen speaker (e.g. Sohee), supertonic voice (F1-F5, M1-M5) or persona id")
    lang: Literal["ko", "ja", "en"]
    text: str = Field(min_length=1, max_length=2000)
    instruct: str | None = None
    model_size: Literal["1.7b", "0.6b"] = "1.7b"
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    seed_material: str = Field(description="content key fields + attempt number; the seed is derived from it")
    max_new_tokens: int | None = Field(default=None, ge=12, le=8192)
    # persona only: the reference clip (made by /design) and the sentence it says
    ref_wav_path: str | None = None
    ref_text: str | None = None


class DesignRequest(BaseModel):
    lang: Literal["ko", "ja", "en"]
    text: str = Field(min_length=1, max_length=500, description="reference sentence the new voice says")
    instruct: str = Field(min_length=1, max_length=1000, description="voice description")
    seed_material: str


class EmbedRequest(BaseModel):
    wav_path: str


@dataclass
class Synthesized:
    wav: np.ndarray
    sample_rate: int
    model: str
    seed: int


class Engines:
    def __init__(self, device: str):
        self.device = device
        self._qwen: dict[str, object] = {}
        self._extra: dict[str, object] = {}  # Base / VoiceDesign
        self._prompts: dict[str, object] = {}  # voice clone prompts by reference hash
        self._supertonic = None
        self._lock = threading.Lock()  # torch/numpy seeds are global: one inference at a time

    def loaded(self) -> list[str]:
        return [QWEN_MODELS[k] for k in self._qwen] + list(self._extra) + (["supertonic-3"] if self._supertonic else [])

    def _load_qwen(self, name: str):
        import torch
        from qwen_tts import Qwen3TTSModel

        path = snapshot_path(name, load_lock()[name]["revision"])
        if not path.exists():
            raise HTTPException(503, f"model not installed: {name} (run scripts/fetch_models.py {name})")
        dtype = torch.bfloat16 if self.device != "cpu" else torch.float32
        return Qwen3TTSModel.from_pretrained(str(path), device_map=self.device, dtype=dtype)

    def _qwen_model(self, size: str):
        if size not in self._qwen:
            self._qwen[size] = self._load_qwen(QWEN_MODELS[size])
        return self._qwen[size]

    def _extra_model(self, name: str):
        if name not in self._extra:
            # VoiceDesign is only needed while creating personas: drop it before loading Base.
            if name == BASE_MODEL:
                self._extra.pop(DESIGN_MODEL, None)
            self._extra[name] = self._load_qwen(name)
        return self._extra[name]

    def _clone_prompt(self, ref_wav_path: str, ref_text: str):
        p = Path(ref_wav_path)
        if not p.is_file():
            raise HTTPException(404, f"reference clip not found: {ref_wav_path}")
        key = hashlib.sha256(p.read_bytes() + ref_text.encode()).hexdigest()
        if key not in self._prompts:
            wav, sr = sf.read(p, dtype="float32")
            if wav.ndim > 1:
                wav = wav.mean(axis=1)
            self._prompts[key] = self._extra_model(BASE_MODEL).create_voice_clone_prompt(
                ref_audio=(wav, sr), ref_text=ref_text
            )
        return self._prompts[key]

    def _sync(self) -> None:
        if self.device == "mps":
            import torch

            torch.mps.synchronize()

    def design(self, req: DesignRequest) -> Synthesized:
        import torch

        seed = sentence_seed(req.seed_material)
        with self._lock:
            model = self._extra_model(DESIGN_MODEL)
            torch.manual_seed(seed)
            wavs, sr = model.generate_voice_design(
                text=req.text,
                instruct=req.instruct,
                language=QWEN_LANG[req.lang],
                max_new_tokens=qwen_token_cap(req.text),
            )
            self._sync()
            return Synthesized(np.asarray(wavs[0], dtype=np.float32), sr, DESIGN_MODEL, seed)

    def embed(self, req: EmbedRequest) -> list[float]:
        """Speaker x-vector of a clip: the Base model's speaker encoder, as used for cloning."""
        p = Path(req.wav_path)
        if not p.is_file():
            raise HTTPException(404, f"wav not found: {req.wav_path}")
        wav, sr = sf.read(p, dtype="float32")
        if wav.ndim > 1:
            wav = wav.mean(axis=1)
        with self._lock:
            prompt = self._extra_model(BASE_MODEL).create_voice_clone_prompt(
                ref_audio=(wav, sr), x_vector_only_mode=True
            )
            self._sync()
            return [float(x) for x in prompt[0].ref_spk_embedding.float().flatten().cpu()]

    def _supertonic_tts(self):
        if self._supertonic is None:
            from supertonic import TTS

            path = snapshot_path("supertonic-3", load_lock()["supertonic-3"]["revision"])
            if not path.exists():
                raise HTTPException(503, "model not installed: supertonic-3")
            self._supertonic = TTS(model="supertonic-3", model_dir=path, auto_download=False)
        return self._supertonic

    def synthesize(self, req: SynthesizeRequest) -> Synthesized:
        seed = sentence_seed(req.seed_material)
        with self._lock:
            cap = req.max_new_tokens or qwen_token_cap(req.text)
            if req.engine == "qwen":
                import torch

                model = self._qwen_model(req.model_size)
                if req.instruct and req.model_size == "0.6b":
                    raise HTTPException(400, "instruct is not supported by the 0.6B model")
                torch.manual_seed(seed)
                wavs, sr = model.generate_custom_voice(
                    text=req.text,
                    speaker=req.voice,
                    language=QWEN_LANG[req.lang],
                    instruct=req.instruct,
                    max_new_tokens=cap,
                )
                self._sync()
                return Synthesized(np.asarray(wavs[0], dtype=np.float32), sr, QWEN_MODELS[req.model_size], seed)
            if req.engine == "persona":
                import torch

                if not req.ref_wav_path or not req.ref_text:
                    raise HTTPException(400, "persona voices need ref_wav_path and ref_text")
                prompt = self._clone_prompt(req.ref_wav_path, req.ref_text)
                torch.manual_seed(seed)
                # non_streaming_mode: the streaming default is reported to drift in pace on long text.
                wavs, sr = self._extra_model(BASE_MODEL).generate_voice_clone(
                    text=req.text,
                    language=QWEN_LANG[req.lang],
                    voice_clone_prompt=prompt,
                    non_streaming_mode=True,
                    max_new_tokens=cap,
                )
                self._sync()
                return Synthesized(np.asarray(wavs[0], dtype=np.float32), sr, BASE_MODEL, seed)
            tts = self._supertonic_tts()
            speed = SUPERTONIC_DEFAULT_SPEED * req.speed
            if not 0.7 <= speed <= 2.0:
                raise HTTPException(400, f"supertonic speed {speed:.2f} outside 0.7-2.0")
            np.random.seed(seed % (2**32))  # supertonic draws its initial noise from numpy's global RNG
            wav, _ = tts.synthesize(req.text, voice_style=tts.get_voice_style(req.voice), lang=req.lang, speed=speed)
            return Synthesized(np.asarray(wav, dtype=np.float32).squeeze(), tts.sample_rate, "supertonic-3", seed)


def create_app(device: str) -> FastAPI:
    app = FastAPI(title=SERVER_ID)
    engines = Engines(device)
    started = time.time()

    @app.get("/health")
    def health() -> dict:
        import torch
        import transformers

        return {
            "id": SERVER_ID,
            "wrapper_version": WRAPPER_VERSION,
            "lock_hash": lock_hash(),
            "models": {name: entry["revision"] for name, entry in load_lock().items()},
            "loaded": engines.loaded(),
            "device": device,
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "uptime_s": round(time.time() - started, 1),
        }

    def wav_response(out: Synthesized, start: float) -> Response:
        buf = io.BytesIO()
        sf.write(buf, out.wav, out.sample_rate, format="WAV", subtype="PCM_16")
        meta = {
            "model": out.model,
            "seed": out.seed,
            "sample_rate": out.sample_rate,
            "duration": round(len(out.wav) / out.sample_rate, 4),
            "elapsed": round(time.perf_counter() - start, 3),
        }
        return Response(buf.getvalue(), media_type="audio/wav", headers={"X-S2V-Meta": json.dumps(meta)})

    @app.post("/synthesize")
    def synthesize(req: SynthesizeRequest) -> Response:
        start = time.perf_counter()
        return wav_response(engines.synthesize(req), start)

    @app.post("/design")
    def design(req: DesignRequest) -> Response:
        start = time.perf_counter()
        return wav_response(engines.design(req), start)

    @app.post("/embed")
    def embed(req: EmbedRequest) -> dict:
        return {"model": BASE_MODEL, "vector": engines.embed(req)}

    return app


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=47861)
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

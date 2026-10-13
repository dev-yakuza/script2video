"""Generate one round of image edits (one process per round, run by the CLI under its memory watchdog).

    python run.py <round.json>
    python run.py --smoke <dir>    # 64x64, 2 steps: checks the model files and the mflux internals used here

round.json: {"width": 640, "height": 800, "steps": 8,
             "jobs": [{"out": "/abs/a.png", "prompt": "...", "image": "/abs/ref.png" | null, "seed": 7}]}
A job without an image edits a plain light gray canvas (candidates of a new character). Sizes are
64-1024 px in steps of 16; steps must match the Lightning LoRA (imagegen.lock.json, default).

Memory (plan C14): every prompt is encoded first, then both references to the 14 GB text encoder are
dropped, so denoising runs with the transformer alone (footprint 16-17 GB at 640x800). The cache
limit is required: without it MLX grows past 49 GB. The LoRA stays unbaked: baking requantizes the
4-bit layers to 8 bits (20 GB) and keeps only part of the LoRA's effect.

Jobs whose output exists are skipped, so a stopped round resumes. Each image is written to a
temporary file and renamed. Progress goes to stdout as JSON lines: {"event": "loaded" | "encoded" |
"done" | "skipped" | "error", ...}. Exit 2: a bad round or a broken environment, found before
generating (rerunning does not fix it). Other failures (e.g. a Metal allocation failure) exit 1:
rerunning resumes.
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import sys
import tempfile
import time
from pathlib import Path

import models

BLANK = (224, 224, 224)
MAX_SIDE = 1024  # larger sizes are out of scope (plan 9)
MAX_SEED = 2**32 - 1  # exact in JSON numbers from JS; mx.random.key rejects >= 2**64
CACHE_LIMIT = 1_000_000_000
# mflux internals used to encode once and drop the encoder (checked before loading the model).
INTERNALS = ("_compute_dimensions", "_encode_prompts_with_images", "generate_image")


class JobError(ValueError):
    pass


class EnvError(RuntimeError):
    """The environment is broken (models, mflux version): rerunning the round does not fix it."""


def emit(event: str, **fields: object) -> None:
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def load_round(path: Path) -> dict:
    try:
        spec = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as e:
        raise JobError(f"{path}: {e}") from e
    return check_round(spec, str(path))


def is_int(v: object) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def check_round(spec: object, where: str = "round", lora_steps: int | None = None) -> dict:
    """Validate a round; steps default to (and must equal) the LoRA's steps from the lock."""
    if lora_steps is None:
        lora_steps = models.load_lock()["lora"]["steps"]
    if not isinstance(spec, dict):
        raise JobError(f"{where}: expected an object")
    for k in ("width", "height"):
        v = spec.get(k)
        if not is_int(v) or not 64 <= v <= MAX_SIDE or v % 16:
            raise JobError(f"{where}: {k} must be a multiple of 16 from 64 to {MAX_SIDE}")
    steps = spec.get("steps", lora_steps)
    if steps != lora_steps or not is_int(steps):
        raise JobError(f"{where}: steps must be {lora_steps} (the Lightning LoRA's steps)")
    jobs = spec.get("jobs")
    if not isinstance(jobs, list) or not jobs:
        raise JobError(f"{where}: jobs must be a non-empty list")
    outs = set()
    for i, j in enumerate(jobs):
        at = f"{where}: jobs[{i}]"
        if not isinstance(j, dict):
            raise JobError(f"{at}: expected an object")
        out, prompt, image, seed = j.get("out"), j.get("prompt"), j.get("image"), j.get("seed")
        if not isinstance(out, str) or not out.endswith(".png") or not Path(out).is_absolute():
            raise JobError(f"{at}: out must be an absolute .png path")
        if out.endswith(".tmp.png"):
            raise JobError(f"{at}: out must not end in .tmp.png (temporary files)")
        if out in outs:
            raise JobError(f"{at}: out {out} appears twice")
        outs.add(out)
        if not isinstance(prompt, str) or not prompt.strip():
            raise JobError(f"{at}: prompt must be a non-empty string")
        if image is not None and (
            not isinstance(image, str) or not Path(image).is_absolute() or not Path(image).is_file()
        ):
            raise JobError(f"{at}: image {image!r} must be an absolute path to a file")
        if not is_int(seed) or not 0 <= seed <= MAX_SEED:
            raise JobError(f"{at}: seed must be an integer from 0 to {MAX_SEED}")
    return {"width": spec["width"], "height": spec["height"], "steps": steps, "jobs": jobs}


def temp_path(out: Path) -> Path:
    return out.with_name(out.stem + ".tmp.png")


def pending(spec: dict) -> list[dict]:
    """Jobs still to generate; also removes temporary files left by a stopped round."""
    todo = []
    for j in spec["jobs"]:
        out = Path(j["out"])
        temp_path(out).unlink(missing_ok=True)
        if out.exists():
            emit("skipped", out=str(out))
        else:
            todo.append(j)
    return todo


def check_internals(cls: type) -> None:
    gone = [n for n in INTERNALS if not callable(getattr(cls, n, None))]
    if gone:
        raise EnvError(f"this mflux version lacks {', '.join(gone)}: reinstall with s2v character setup")


def load_model():
    import mlx.core as mx

    try:
        from mflux.models.common.config.model_config import ModelConfig
        from mflux.models.common.vae.tiling_config import TilingConfig
        from mflux.models.qwen.variants.edit.qwen_image_edit import QwenImageEdit
    except ImportError as e:
        raise EnvError(f"this mflux version is not the pinned one ({e}): rerun s2v character setup") from e

    check_internals(QwenImageEdit)
    lock = models.load_lock()
    missing = models.ready(lock)
    if missing:
        raise EnvError(f"missing {', '.join(missing)}: run s2v character setup")
    mx.set_cache_limit(CACHE_LIMIT)
    t = time.time()
    model = QwenImageEdit(
        model_config=ModelConfig.qwen_image_edit_2511(),
        quantize=None,
        model_path=str(models.quantized_path(lock)),
        lora_paths=[str(models.lora_file(lock))],
        lora_scales=[1.0],
        bake_lora=False,
    )
    model.tiling_config = TilingConfig()
    emit("loaded", s=round(time.time() - t))
    return model


def encode_all(model, jobs: list[dict], spec: dict) -> None:
    """Adds job['emb'] to every job, then frees the text encoder."""
    import mlx.core as mx

    for j in jobs:
        image = j["_image"]
        config, vl_w, vl_h, _, _ = model._compute_dimensions(
            image_paths=[image],
            num_inference_steps=spec["steps"],
            height=spec["height"],
            width=spec["width"],
            guidance=1.0,
            image_path=image,
            scheduler="linear",
        )
        emb = model._encode_prompts_with_images(
            prompt=j["prompt"],
            negative_prompt=" ",
            image_paths=[image],
            config=config,
            vl_width=vl_w,
            vl_height=vl_h,
        )
        mx.eval(*emb)
        j["emb"] = emb
    model.qwen_vl_encoder = None
    model.text_encoder = None  # the same object: both references must go
    gc.collect()
    mx.clear_cache()
    emit("encoded", jobs=len(jobs))


def generate(model, job: dict, spec: dict) -> dict:
    import mlx.core as mx

    model._encode_prompts_with_images = lambda **_: job["emb"]
    mx.reset_peak_memory()
    t = time.time()
    image = model.generate_image(
        seed=job["seed"],
        prompt=job["prompt"],
        negative_prompt=" ",
        width=spec["width"],
        height=spec["height"],
        guidance=1.0,
        image_path=job["_image"],
        image_paths=[job["_image"]],
        num_inference_steps=spec["steps"],
        scheduler="linear",
    ).image
    out = Path(job["out"])
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = temp_path(out)
    image.save(tmp)
    tmp.rename(out)
    stats = {"s": round(time.time() - t), "peak_gb": round(mx.get_peak_memory() / 1e9, 1)}
    job.pop("emb", None)
    gc.collect()
    mx.clear_cache()
    return stats


def blank_canvas(width: int, height: int) -> Path:
    """The plain gray canvas candidates are edited from: one fixed file per size in the temp folder,
    so a stopped round leaves nothing new behind."""
    path = Path(tempfile.gettempdir()) / f"s2v-imagegen-blank-{width}x{height}-{bytes(BLANK).hex()}.png"
    if not path.exists():
        from PIL import Image

        tmp = path.with_name(f"{path.stem}.{os.getpid()}.tmp.png")
        Image.new("RGB", (width, height), BLANK).save(tmp)
        tmp.replace(path)
    return path


def run(spec: dict) -> int:
    todo = pending(spec)
    if not todo:
        return 0
    for j in todo:
        j["_image"] = j["image"] if j.get("image") is not None else str(blank_canvas(spec["width"], spec["height"]))
    model = load_model()
    encode_all(model, todo, spec)
    for i, j in enumerate(todo):
        stats = generate(model, j, spec)
        emit("done", out=j["out"], index=i + 1, total=len(todo), **stats)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("round", nargs="?")
    ap.add_argument("--smoke", metavar="DIR")
    a = ap.parse_args()
    models.exit_with_parent()
    try:
        if a.smoke:
            out = Path(a.smoke).resolve() / "smoke.png"
            out.unlink(missing_ok=True)
            spec = check_round(
                {
                    "width": 64,
                    "height": 64,
                    "steps": 2,  # enough to run every code path
                    "jobs": [{"out": str(out), "prompt": "A small red circle.", "image": None, "seed": 1}],
                },
                "smoke",
                lora_steps=2,
            )
        elif a.round:
            spec = load_round(Path(a.round))
        else:
            ap.error("give a round file or --smoke DIR")
        return run(spec)
    except (JobError, EnvError) as e:
        emit("error", message=str(e))
        print(f"[imagegen] {e}", file=sys.stderr, flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

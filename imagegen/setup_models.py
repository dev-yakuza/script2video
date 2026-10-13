"""Model setup steps for `s2v character setup` (the CLI checks RAM and disk and runs these in order).

    python setup_models.py download <name>   # a snapshot of imagegen.lock.json, then its marker
    python setup_models.py quantize          # the bf16 model -> 4-bit MLX weights (mflux-save -q 4)

Both are safe to rerun: downloads resume, and quantization writes to <target>.partial and renames
it only when finished. Quantize the official weights here: a third-party 4-bit copy was noisy.
"""

from __future__ import annotations

import argparse
import shutil
import sys

import models

CACHE_LIMIT = 1_000_000_000


def download(name: str) -> int:
    lock = models.load_lock()
    entry = lock["models"].get(name)
    if entry is None:
        print(f"unknown model {name!r}; known: {', '.join(lock['models'])}", file=sys.stderr)
        return 2
    target = models.model_path(name, entry["revision"])
    print(f"[setup] download {entry['repo']}@{entry['revision'][:12]} -> {target}", flush=True)
    from huggingface_hub import snapshot_download

    snapshot_download(
        repo_id=entry["repo"],
        revision=entry["revision"],
        local_dir=target,
        allow_patterns=entry.get("allow_patterns"),
    )
    models.mark_complete(target, {"repo": entry["repo"], "revision": entry["revision"]})
    return 0


def quantize() -> int:
    lock = models.load_lock()
    q = lock["quantized"]
    src_entry = lock["models"][q["from"]]
    src = models.model_path(q["from"], src_entry["revision"])
    if not models.is_complete(src):
        print(f"{src} is not downloaded: run the download step first", file=sys.stderr)
        return 2
    target = models.quantized_path(lock)
    partial = target.with_name(target.name + ".partial")
    shutil.rmtree(partial, ignore_errors=True)
    print(f"[setup] quantize {src} -> {target} ({q['bits']}-bit)", flush=True)
    from importlib.metadata import version

    import mlx.core as mx
    from mflux.models.common.cli.save import main as save

    mx.set_cache_limit(CACHE_LIMIT)  # without it MLX keeps freed buffers and grows by tens of GB

    sys.argv = [
        "mflux-save",
        "--model",
        str(src),
        "--base-model",
        "qwen-image-edit-2511",
        "--quantize",
        str(q["bits"]),
        "--path",
        str(partial),
    ]
    code = save()
    if code not in (None, 0):
        return int(code)
    models.mark_complete(
        partial,
        {"from": q["from"], "revision": src_entry["revision"], "bits": q["bits"], "mflux": version("mflux")},
    )
    shutil.rmtree(target, ignore_errors=True)
    partial.rename(target)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="step", required=True)
    sub.add_parser("download").add_argument("name")
    sub.add_parser("quantize")
    a = ap.parse_args()
    models.exit_with_parent()
    return download(a.name) if a.step == "download" else quantize()


if __name__ == "__main__":
    raise SystemExit(main())

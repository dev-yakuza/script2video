"""Train a persona's speaker row for the CustomVoice model (acting stage 4 plan 7).

Only the speaker vector (one input-embedding row, 2048 floats) is trained; the model stays frozen,
so the trained speaker keeps following emotion instructions. The recipe is the S2 experiment's
(experiments/m7-acting/s2train.py), rewritten: per-epoch checkpoints with the Adam state (resume),
atomic writes, a lifeline to the CLI and JSON progress lines on stdout.

    python train_speaker.py encode --clips clips.jsonl --codes DIR
    python train_speaker.py check  --data data.jsonl --codes DIR --init init.json --lang ko
    python train_speaker.py train  --data data.jsonl --codes DIR --init init.json --out DIR --epochs 20 --lang ko

clips.jsonl: {"sha", "audio"}; data.jsonl: {"sha", "text", "instruct"?}. Vectors are JSON
({"vector": [...], "vectorSha"}), never pickles. torch is imported inside functions so the pure
helpers below can be tested without it.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "scripts"))

from helpers import vector_sha  # noqa: E402

MODEL = "qwen3-tts-1.7b-customvoice"
LR = 2e-3
ACCUM = 8
HOLDOUT = 12
SUB_WEIGHT = 0.3
LANGS = {"ko": "korean", "ja": "japanese", "en": "english"}
PRESETS = ("sohee", "ryan", "uncle_fu")


# ---------- pure helpers (tested without torch) ----------


def event(kind: str, **fields) -> None:
    """One JSON line for the CLI."""
    print(json.dumps({"event": kind, **fields}, ensure_ascii=False), flush=True)


def atomic_write(path: Path, data: str | bytes) -> None:
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_bytes(data.encode() if isinstance(data, str) else data)
    os.replace(tmp, path)


def split_holdout(pairs: list, holdout: int = HOLDOUT) -> tuple[list, list]:
    """The S2 split: one shuffle with Random(0), the first `holdout` pairs for validation."""
    order = list(pairs)
    random.Random(0).shuffle(order)
    return order[:holdout], order[holdout:]


def epoch_order(train: list, epoch: int) -> list:
    """Epoch e's order: a fresh copy shuffled with Random(e), so a resumed run needs no replay
    (S2 shuffled in place, cumulatively)."""
    order = list(train)
    random.Random(epoch).shuffle(order)
    return order


def best_epoch(vals: dict[int, float]) -> int:
    """The lowest validation loss among epochs 1 and up (epoch 0 is the initial vector)."""
    return min((e for e in vals if e >= 1), key=lambda e: (vals[e], e))


def vector_json(vector: list[float], **extra) -> str:
    # allow_nan=False: a diverged vector is an error here, not a NaN the CLI cannot read
    return json.dumps({"vector": vector, "vectorSha": vector_sha(vector), **extra}, allow_nan=False)


def read_vector(path: Path) -> list[float]:
    d = json.loads(path.read_text())
    v = d["vector"]
    if vector_sha(v) != d.get("vectorSha"):
        raise ValueError(f"{path}: vectorSha does not match")
    return [float(x) for x in v]


def exit_with_parent() -> None:
    """With S2V_LIFELINE=1, stdin is a pipe from the CLI: exit when it closes (as imagegen)."""
    if os.environ.get("S2V_LIFELINE") != "1":
        return

    def watch() -> None:
        while os.read(0, 4096):
            pass
        os._exit(1)

    threading.Thread(target=watch, daemon=True).start()


def read_jsonl(path: str) -> list[dict]:
    return [json.loads(x) for x in Path(path).read_text().splitlines() if x.strip()]


# ---------- model parts ----------


def device() -> str:
    import torch

    return "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"


def load_model():
    import torch
    from fetch_models import load_lock, snapshot_path
    from qwen_tts import Qwen3TTSModel

    dev = device()
    path = snapshot_path(MODEL, load_lock()[MODEL]["revision"])
    dtype = torch.bfloat16 if dev != "cpu" else torch.float32
    return Qwen3TTSModel.from_pretrained(str(path), device_map=dev, dtype=dtype)


class Builder:
    """generate_custom_voice's non-streaming input sequence, with teacher-forced frames (S2)."""

    def __init__(self, cv, lang: str):
        import torch

        self.cv, m = cv, cv.model
        self.cfg, self.tk = m.config, m.talker
        tc = self.cfg.talker_config
        dev = self.tk.device

        def ids(xs):
            return torch.tensor([xs], device=dev)

        with torch.no_grad():
            bos, eos, pad = self.tk.text_projection(
                self.tk.get_text_embeddings()(
                    ids([self.cfg.tts_bos_token_id, self.cfg.tts_eos_token_id, self.cfg.tts_pad_token_id])
                )
            ).chunk(3, dim=1)
            emb = self.tk.get_input_embeddings()
            self.tts_bos, self.tts_eos, self.tts_pad = bos, eos, pad
            self.pre0 = emb(
                ids([tc.codec_think_id, tc.codec_think_bos_id, tc.codec_language_id[lang], tc.codec_think_eos_id])
            )
            self.pre1 = emb(ids([tc.codec_pad_id, tc.codec_bos_id]))
            self.codec_pad = emb(ids([tc.codec_pad_id]))
            self.eos_id = tc.codec_eos_token_id

    def prefix(self, text: str, spk, instruct: str | None):
        """Everything before the first frame, ending with codec_bos (whose output predicts frame 0)."""
        import torch

        tk = self.tk
        input_id = self.cv._tokenize_texts([self.cv._build_assistant_text(text)])[0]
        with torch.no_grad():
            role = tk.text_projection(tk.get_text_embeddings()(input_id[:, :3]))
            body = tk.text_projection(tk.get_text_embeddings()(input_id[:, 3:-5]))
        n_pre = self.pre0.shape[1] + 1 + self.pre1.shape[1]  # codec prefix incl. the speaker
        codec_prefix = torch.cat([self.pre0, spk.to(self.pre0.dtype).view(1, 1, -1), self.pre1], dim=1)
        head = torch.cat([self.tts_pad.expand(-1, n_pre - 2, -1), self.tts_bos], dim=1) + codec_prefix[:, :-1]
        text_part = torch.cat([body, self.tts_eos], dim=1) + self.codec_pad.expand(-1, body.shape[1] + 1, -1)
        start = self.tts_pad + codec_prefix[:, -1:]
        parts = [role, head, text_part, start]
        if instruct:  # generate() puts the instruction before the role tokens
            with torch.no_grad():
                ins_id = self.cv._tokenize_texts([self.cv._build_instruct_text(instruct)])[0]
                parts.insert(0, tk.text_projection(tk.get_text_embeddings()(ins_id)))
        return torch.cat(parts, dim=1)

    def __call__(self, text: str, codes, spk, instruct: str | None):
        import torch

        tk = self.tk
        codes = codes.to(tk.device)
        with torch.no_grad():
            frames = tk.get_input_embeddings()(codes[:, :1].T)
            cp = tk.code_predictor.get_input_embeddings()
            for i in range(1, codes.shape[1]):
                frames = frames + cp[i - 1](codes[:, i : i + 1].T)
        pre = self.prefix(text, spk, instruct)
        seq = torch.cat([pre, frames + self.tts_pad], dim=1)
        return seq, pre.shape[1] - 1, codes


def loss_of(cv, build: Builder, text: str, codes, spk, instruct: str | None):
    import torch
    import torch.nn.functional as F

    seq, first, codes = build(text, codes, spk, instruct)
    out = cv.model.talker(inputs_embeds=seq, output_hidden_states=True)
    logits = out.logits[0, first:].float()
    target = torch.cat([codes[:, 0], torch.tensor([build.eos_id], device=codes.device)])
    main = F.cross_entropy(logits, target)
    hidden = out.hidden_states[0][-1][0, first : first + codes.shape[0]]
    # the built-in sub-talker loss shifts the labels a second time: score its logits directly
    logits_sub, _ = cv.model.talker.forward_sub_talker_finetune(codes, hidden)
    sub = F.cross_entropy(logits_sub.float().reshape(-1, logits_sub.shape[-1]), codes[:, 1:].reshape(-1))
    return main + SUB_WEIGHT * sub


def load_pairs(args) -> list[tuple[str, object, str | None]]:
    import torch

    rows = read_jsonl(args.data)
    codes = Path(args.codes)
    return [(r["text"], torch.load(codes / f"{r['sha']}.pt"), r.get("instruct")) for r in rows]


# ---------- commands ----------


def encode(args) -> None:
    """Audio codes of the clips (speech tokenizer of the CustomVoice snapshot), one file per clip sha."""
    import io

    import torch
    from fetch_models import load_lock, snapshot_path
    from qwen_tts import Qwen3TTSTokenizer

    out = Path(args.codes)
    out.mkdir(parents=True, exist_ok=True)
    todo = [c for c in read_jsonl(args.clips) if not (out / f"{c['sha']}.pt").exists()]
    if not todo:
        event("encoded", count=0)
        return
    path = snapshot_path(MODEL, load_lock()[MODEL]["revision"])
    tok = Qwen3TTSTokenizer.from_pretrained(str(path / "speech_tokenizer"), device_map=device())
    for i in range(0, len(todo), 8):
        batch = todo[i : i + 8]
        for c, codes in zip(batch, tok.encode([c["audio"] for c in batch]).audio_codes, strict=True):
            buf = io.BytesIO()
            torch.save(codes.cpu(), buf)
            atomic_write(out / f"{c['sha']}.pt", buf.getvalue())
        event("progress", stage="encode", done=min(i + 8, len(todo)), total=len(todo))
    event("encoded", count=len(todo))


def check(args) -> None:
    """Before training: Builder must give generate()'s exact input (a qwen_tts update could change the
    private functions it uses), and the initial vector must fit the data better than other speakers."""
    import torch

    cv = load_model()
    cv.model.eval()
    build = Builder(cv, LANGS[args.lang])
    init = torch.tensor(read_vector(Path(args.init)))
    pairs = load_pairs(args)
    text, _, _ = pairs[0]
    for instruct in (None, "Sound happy and bright."):
        seen: list = []

        def first_input(_m, _a, kw, seen=seen):
            if not seen:
                seen.append(kw["inputs_embeds"].detach().clone())

        hook = cv.model.talker.register_forward_pre_hook(first_input, with_kwargs=True)
        torch.manual_seed(0)
        cv.generate_custom_voice(
            text=text,
            speaker="aiden",
            language=LANGS[args.lang].capitalize(),
            instruct=instruct,
            max_new_tokens=2,
            voice_clone_prompt={
                "ref_code": [None],
                "ref_spk_embedding": [init],
                "x_vector_only_mode": [True],
                "icl_mode": [False],
            },
        )
        hook.remove()
        mine = build.prefix(text, init.to(cv.model.talker.device), instruct)
        if not seen or seen[0].shape != mine.shape or not torch.equal(seen[0], mine.to(seen[0].dtype)):
            event("error", message="the training input differs from generate()'s (qwen_tts changed?)")
            sys.exit(3)
    table = cv.model.talker.get_input_embeddings().weight
    spk_id = cv.model.config.talker_config.spk_id
    cands = {"init": init.to(table.device)} | {n: table[spk_id[n]].detach().float() for n in PRESETS}
    plain = [p for p in pairs if not p[2]][:16]
    losses = {}
    with torch.no_grad():
        for name, v in cands.items():
            losses[name] = sum(loss_of(cv, build, t, c, v, None).item() for t, c, _ in plain) / len(plain)
    event("checked", losses={k: round(v, 4) for k, v in losses.items()})
    if losses["init"] >= min(losses[n] for n in PRESETS):
        event("error", message=f"the initial vector does not fit the data better than other speakers: {losses}")
        sys.exit(4)


def train(args) -> None:
    import io

    import torch

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    state_path = out / "state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {"epoch": 0, "vals": {}}
    pairs = load_pairs(args)
    if len(pairs) <= HOLDOUT:
        event("error", message=f"{len(pairs)} clips: more than {HOLDOUT} are needed (validation)")
        sys.exit(2)
    val, tr = split_holdout(pairs)
    cv = load_model()
    cv.model.requires_grad_(False)
    cv.model.eval()  # no dropout: only the speaker vector changes
    build = Builder(cv, LANGS[args.lang])
    init = read_vector(Path(args.init))
    start = state["epoch"]
    vec = read_vector(out / f"e{start}.json") if start > 0 else init
    spk = torch.nn.Parameter(torch.tensor(vec, device=cv.model.talker.device))
    opt = torch.optim.Adam([spk], lr=LR)
    if start > 0:
        opt.load_state_dict(torch.load(out / f"adam-e{start}.pt", map_location=cv.model.talker.device))

    def evaluate() -> float:
        with torch.no_grad():
            return sum(loss_of(cv, build, t, c, spk, i).item() for t, c, i in val) / len(val)

    vals = {int(k): v for k, v in state["vals"].items()}
    if start == 0:
        vals[0] = evaluate()
        event("epoch", epoch=0, val=round(vals[0], 4))
    t0 = time.time()
    for ep in range(start + 1, args.epochs + 1):
        order = epoch_order(tr, ep)
        for k, (text, codes, ins) in enumerate(order):
            loss = loss_of(cv, build, text, codes, spk, ins)
            (loss / ACCUM).backward()
            if (k + 1) % ACCUM == 0 or k + 1 == len(order):
                torch.nn.utils.clip_grad_norm_([spk], 1.0)
                opt.step()
                opt.zero_grad()
            if k % 40 == 0:
                event("progress", stage="train", epoch=ep, step=k, steps=len(order), seconds=round(time.time() - t0))
        vals[ep] = evaluate()
        v = [float(x) for x in spk.detach().cpu().float()]
        if not math.isfinite(vals[ep]) or not all(math.isfinite(x) for x in v):
            event("error", message=f"training diverged at epoch {ep} (validation {vals[ep]})")
            sys.exit(5)
        atomic_write(out / f"e{ep}.json", vector_json(v, epoch=ep, valLoss=vals[ep]))
        buf = io.BytesIO()
        torch.save(opt.state_dict(), buf)
        atomic_write(out / f"adam-e{ep}.pt", buf.getvalue())
        # the state is written last: a crash before it resumes from the previous epoch
        atomic_write(state_path, json.dumps({"epoch": ep, "vals": vals}))
        event("epoch", epoch=ep, val=round(vals[ep], 4), seconds=round(time.time() - t0))
    best = best_epoch(vals)
    v = read_vector(out / f"e{best}.json")
    atomic_write(out / "best.json", vector_json(v, epoch=best, valLoss=vals[best]))
    event("trained", epoch=best, val=round(vals[best], 4))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("encode")
    e.add_argument("--clips", required=True)
    e.add_argument("--codes", required=True)
    for name in ("check", "train"):
        s = sub.add_parser(name)
        s.add_argument("--data", required=True)
        s.add_argument("--codes", required=True)
        s.add_argument("--init", required=True)
        s.add_argument("--lang", default="ko", choices=sorted(LANGS))
        if name == "train":
            s.add_argument("--out", required=True)
            s.add_argument("--epochs", type=int, default=20)
    args = p.parse_args()
    exit_with_parent()
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    try:
        {"encode": encode, "check": check, "train": train}[args.cmd](args)
    except SystemExit:
        raise
    except Exception as ex:  # one line for the CLI, the traceback on stderr
        import traceback

        traceback.print_exc()
        event("error", message=f"{type(ex).__name__}: {ex}")
        sys.exit(1)


if __name__ == "__main__":
    main()

/**
 * `s2v takes <script>` (stage 3b-2 plan): a listening page to choose takes. Every take of a line
 * plays alone or between its neighbours, at the level render would give it; the radios turn into
 * one `s2v takes pick` / `unpick` command. No server is started and the caches are not written:
 * only ffmpeg (loudness, and a take wav made from its raw take into the page folder).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { gainFor, type Script } from '@script2video/core';
import { clampGain, integratedLoudness, medianOf, SPEECH_LUFS } from './media.js';
import { readPcm16, writePcm16 } from './pauses.js';
import { rawShaOf, readPicks, shellQuote, stalePicks, type PicksFile } from './picks.js';
import { context, lastTake, matches, type Context } from './takes.js';
import {
  isPickSelect,
  makeTakeWav,
  rawPathOf,
  takeKeyOf,
  takeMadeOf,
  type LockEntry,
  type SentenceJob,
} from './tts.js';
import { outDirOf } from './paths.js';

// ---------- page data ----------

/** How the wav of a take was found (shown next to it). */
export type TakeSource = 'lock' | 'cut' | 'uncut' | 'many' | 'raw' | 'none';

export interface PageTake {
  n: number;
  /** Page-relative wav (null: nothing to play). */
  wav: string | null;
  source: TakeSource;
  /** The lock's record of this take (current key only). */
  ok: boolean | null;
  f0: number | null;
  rate: number | null;
}

export interface PageLine {
  id: string;
  pickKey: string;
  text: string;
  emo?: string;
  power?: string;
  /** Paragraph (scene:block) and sentence index, for the context playback. */
  para: string;
  index: number;
  pauseAfter: number;
  /** A line shown with radios (neighbours of shown lines are carried for context only). */
  target: boolean;
  lockTake: number | null;
  lockWav: string | null;
  /** How the lock chose its take. */
  lockNote: string;
  /** The lock holds a pick that is gone: the next tts chooses again. */
  reselect: boolean;
  pick: { take: number; by: 'human' | 'retry' } | null;
  /** Other shown lines with the same pick key (one pick applies to all). */
  shared: string[];
  takes: PageTake[];
}

export interface PageData {
  script: string;
  scriptArg: string;
  lang: string;
  sentenceGap: number;
  storageKey: string;
  /** Build id, added to the wav URLs. */
  build: string;
  lines: PageLine[];
  notes: string[];
}

/** Lines the page shows by default: emotion lines, and lines with a pick (3b-2 plan 1). */
function isTarget(
  job: SentenceJob,
  entry: LockEntry | undefined,
  picks: PicksFile,
  all: boolean,
  ids: string[],
) {
  if (ids.length > 0) return matches(job.id, ids);
  if (all) return true;
  return job.emotional || !!picks.picks[job.pickKey] || isPickSelect(entry?.select);
}

function lockNoteOf(e: LockEntry | undefined, picks: PicksFile, pickKey: string): string {
  if (!e) return 'no lock';
  const s = e.select;
  if (isPickSelect(s))
    return picks.picks[pickKey] ? `lock: pick (${s.by})` : 'no pick — the next tts chooses again';
  if (s)
    return `lock: automatic (strength rank ${s.rank + 1} of ${s.n} passing${s.neighbor ? ', matched to the line before' : ''})`;
  return (e.checks?.length ?? 0) > 0
    ? 'lock: none passed — the take with the fewest failures'
    : 'lock: first passing take';
}

const wavName = (id: string, tag: string) => `wav/${id.replace(/:/g, '-')}-${tag}.wav`;

// ---------- loudness (as render: buildNarration) ----------

class Loudness {
  private cache: Record<string, number | null>;
  constructor(private path: string) {
    try {
      this.cache = JSON.parse(readFileSync(path, 'utf8')) as Record<string, number | null>;
    } catch {
      this.cache = {};
    }
  }
  /** Integrated loudness (null: too short or silent to measure), cached by `key`. */
  async of(wav: string, key: string): Promise<number | null> {
    if (!(key in this.cache)) {
      try {
        const { lufs } = await integratedLoudness(wav);
        this.cache[key] = lufs > -70 ? lufs : null;
      } catch {
        this.cache[key] = null;
      }
    }
    return this.cache[key]!;
  }
  save() {
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.cache));
    renameSync(tmp, this.path);
  }
}

const fileKey = (p: string) => {
  const st = statSync(p);
  return `${p}|${st.size}|${st.mtimeMs}`;
};

// ---------- build ----------

export interface TakesPageResult {
  html: string;
  lines: number;
  notes: string[];
}

/** Gather the takes, write the gained wavs and the page. */
export async function buildTakesPage(
  scriptPath: string,
  script: Script,
  repoRoot: string,
  opts: { all: boolean; ids: string[]; log: (m: string) => void; outDir?: string },
): Promise<TakesPageResult> {
  const c = context(scriptPath, script, repoRoot);
  const picks = readPicks(c.lockDir);
  const { meta } = script;
  // under --out-dir when given (checked by the caller), else out/<video> (S2)
  const outDir = join(opts.outDir ?? outDirOf(scriptPath, repoRoot), 'takes', meta.lang);
  const wavDir = join(outDir, 'wav');
  const srcDir = join(outDir, 'src');
  rmSync(wavDir, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
  mkdirSync(wavDir, { recursive: true });
  mkdirSync(srcDir, { recursive: true });

  const notes: string[] = [];
  for (const e of c.plan.errors) notes.push(`${e.id}: ${e.message}`);
  if (c.mock)
    notes.push('S2V_TTS=mock: mock keys — real picks are not shown, and there is no take cache');
  else
    for (const s of stalePicks(picks, pickLinesOf(c), shellQuote(resolve(scriptPath))))
      notes.push(s.message);

  const entryOf = (j: SentenceJob) => {
    const e = c.lock?.entries[j.key];
    return e && existsSync(join(c.lockDir, e.src)) ? e : undefined;
  };
  const sentenceOf = (id: string) => {
    const [scene, bi, si] = id.split(':');
    const block = script.scenes.find((s) => s.id === scene)!.blocks[Number(bi)]!;
    if (block.kind !== 'paragraph') throw new Error(`${id}: not a paragraph`);
    return { block, sentence: block.sentences[Number(si)]! };
  };

  const targets = c.jobs.filter((j) =>
    isTarget(j, c.lock?.entries[j.key], picks, opts.all, opts.ids),
  );
  const targetIds = new Set(targets.map((j) => j.id));
  // neighbours in the same paragraph, for the context playback
  const byId = new Map(c.jobs.map((j) => [j.id, j]));
  const carried = new Set<string>();
  for (const j of targets) {
    const [s, b, i] = j.id.split(':');
    for (const k of [Number(i) - 1, Number(i) + 1]) {
      const id = `${s}:${b}:${k}`;
      if (byId.has(id) && !targetIds.has(id)) carried.add(id);
    }
  }
  const shown = c.jobs.filter((j) => targetIds.has(j.id) || carried.has(j.id));

  // every wav to write: its source, its page path, the cast and the line's own gain
  interface Out {
    src: string;
    key: string;
    page: string;
    cast: string;
    lineGain: number;
  }
  const outs: Out[] = [];
  const lines: PageLine[] = [];
  for (const job of shown) {
    const { block, sentence } = sentenceOf(job.id);
    const lineGain = gainFor(meta, block, sentence);
    const entry = entryOf(job);
    const pick = picks.picks[job.pickKey];
    const [scene, bi, si] = job.id.split(':');
    const line: PageLine = {
      id: job.id,
      pickKey: job.pickKey,
      text: job.text,
      ...(job.acting?.emo ? { emo: job.acting.emo } : {}),
      ...(job.power ? { power: job.power } : {}),
      para: `${scene}:${bi}`,
      index: Number(si),
      pauseAfter: sentence.pauseAfter ?? 0,
      target: targetIds.has(job.id),
      lockTake: entry ? entry.attempt : null,
      lockWav: null,
      lockNote: lockNoteOf(entry, picks, job.pickKey),
      reselect: !pick && isPickSelect(entry?.select),
      pick: pick ? { take: pick.take, by: pick.by } : null,
      shared: targets.filter((j) => j.pickKey === job.pickKey && j.id !== job.id).map((j) => j.id),
      takes: [],
    };
    if (entry) {
      const src = join(c.lockDir, entry.src);
      line.lockWav = wavName(job.id, 'lock');
      outs.push({ src, key: fileKey(src), page: line.lockWav, cast: block.cast, lineGain });
    }
    // a target: every take (mock: the lock only, there is no take cache); a carried neighbour:
    // its pick, which the next tts puts there
    const wanted: number[] = line.target
      ? c.mock
        ? entry
          ? [entry.attempt]
          : []
        : [...Array(lastTake(c, job, pick?.tried ?? -1) + 1).keys()]
      : pick && pick.take !== entry?.attempt
        ? [pick.take]
        : [];
    {
      for (const n of wanted) {
        const rec = entry?.takes?.[n];
        const take: PageTake = {
          n,
          wav: null,
          source: 'none',
          ok: rec ? rec.ok : null,
          f0: rec ? rec.f0 : null,
          rate: rec ? rec.rate : null,
        };
        const found = await sourceOf(c, job, n, entry, srcDir);
        if (found) {
          take.source = found.source;
          take.wav = found.source === 'lock' ? line.lockWav : wavName(job.id, `t${n}`);
          if (found.source !== 'lock')
            outs.push({
              src: found.path,
              key: found.key,
              page: take.wav!,
              cast: block.cast,
              lineGain,
            });
        }
        line.takes.push(take);
      }
    }
    lines.push(line);
  }

  // gains as render: clamp(−20 − LUFS) + the line's level; unmeasurable → the cast's median
  const loud = new Loudness(join(outDir, 'loudness.json'));
  const castMedian = new Map<string, number>();
  const medianFor = async (cast: string) => {
    if (castMedian.has(cast)) return castMedian.get(cast)!;
    const gains: number[] = [];
    for (const j of c.jobs) {
      const e = entryOf(j);
      if (!e || sentenceOf(j.id).block.cast !== cast) continue;
      const src = join(c.lockDir, e.src);
      const l = await loud.of(src, fileKey(src));
      if (l !== null) gains.push(SPEECH_LUFS - l);
    }
    const m = medianOf(gains);
    castMedian.set(cast, m);
    return m;
  };
  const gains = new Map<string, number>();
  for (const o of outs) {
    if (gains.has(o.page)) continue;
    const l = await loud.of(o.src, o.key);
    const db = clampGain(l !== null ? SPEECH_LUFS - l : await medianFor(o.cast)) + o.lineGain;
    gains.set(o.page, db);
  }
  loud.save();
  // one attenuation for the whole page when a gained wav would clip (relative levels kept)
  let peak = 0;
  for (const o of outs) {
    const g = 10 ** (gains.get(o.page)! / 20);
    const { samples } = readPcm16(o.src);
    for (const x of samples) peak = Math.max(peak, (Math.abs(x) / 32768) * g);
  }
  const atten = peak > 1 ? 1 / peak : 1;
  if (atten < 1)
    notes.push(`all wavs ${(20 * Math.log10(atten)).toFixed(1)} dB so the loudest does not clip`);
  const written = new Set<string>();
  for (const o of outs) {
    if (written.has(o.page)) continue;
    written.add(o.page);
    const g = 10 ** (gains.get(o.page)! / 20) * atten;
    const { rate, samples } = readPcm16(o.src);
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++)
      out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * g)));
    writePcm16(join(outDir, o.page), rate, out);
  }
  rmSync(srcDir, { recursive: true, force: true });

  const data: PageData = {
    script: resolve(scriptPath),
    scriptArg: shellQuote(resolve(scriptPath)),
    lang: meta.lang,
    sentenceGap: meta.pacing.sentenceGap,
    storageKey: `s2v-takes:${resolve(scriptPath)}:${meta.lang}`,
    // wav names repeat across runs: a page left open must not play the new files as its own
    build: String(Date.now()),
    lines,
    notes,
  };
  const html = join(outDir, 'index.html');
  writeFileSync(html, takesPage(data));
  return { html, lines: targets.length, notes };
}

const pickLinesOf = (c: Context) =>
  c.jobs.map((j) => ({ id: j.id, pickKey: j.pickKey, text: j.text }));

/** Where take n of a line can be heard (3b-2 plan 2), or null. */
async function sourceOf(
  c: Context,
  job: SentenceJob,
  n: number,
  entry: LockEntry | undefined,
  srcDir: string,
): Promise<{ source: TakeSource; path: string; key: string } | null> {
  if (entry && entry.attempt === n) {
    const p = join(c.lockDir, entry.src);
    return { source: 'lock', path: p, key: fileKey(p) };
  }
  const tk = takeKeyOf(job, c.maxPause, n);
  const made = existsSync(c.takesDir) ? takeMadeOf(c.takesDir, tk) : null;
  if (made) {
    const cuts = readdirSync(c.takesDir).filter(
      (f) => f.startsWith(`${tk}.crop-`) && f.endsWith(`.${made.wavSha}.wav`),
    );
    const p = cuts.length === 1 ? join(c.takesDir, cuts[0]!) : join(c.takesDir, `${tk}.wav`);
    const source: TakeSource = cuts.length === 1 ? 'cut' : cuts.length > 1 ? 'many' : 'uncut';
    return { source, path: p, key: fileKey(p) };
  }
  const raw = rawPathOf(c.rawDir, job.synthKey, n);
  const info = existsSync(`${raw}.json`)
    ? (JSON.parse(readFileSync(`${raw}.json`, 'utf8')) as { model?: string })
    : null;
  if (existsSync(raw) && typeof info?.model === 'string') {
    // the take wav tts would make, into the page folder only (the caches are not written)
    const out = join(srcDir, `${job.id.replace(/:/g, '-')}-t${n}.wav`);
    await makeTakeWav(raw, out, job.tempo, c.maxPause);
    // keyed like the take (post-processing version included) and its raw take
    return {
      source: 'raw',
      path: out,
      key: `raw:${takeKeyOf(job, c.maxPause, n)}:${rawShaOf(raw)}`,
    };
  }
  return null;
}

// ---------- HTML ----------

/** JSON inside <script>: no `</script>`, `<!--` or line separators can end it early. */
export function scriptJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function takesPage(data: PageData): string {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Takes</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--card:#f5f5f7;--accent:#0a66c2;--warn:#b25000;--bad:#c4001a;--good:#127c3a}
@media (prefers-color-scheme:dark){:root{--bg:#161617;--fg:#f5f5f7;--muted:#a1a1a6;--line:#3a3a3c;--card:#232325;--accent:#4ea1ff;--warn:#ff9f40;--bad:#ff6b6b;--good:#3ddc84}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:920px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:8px 0}
.muted{color:var(--muted)}.warn{color:var(--warn)}.bad{color:var(--bad)}.good{color:var(--good)}
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:8px 0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin:12px 0}
.head{margin-bottom:6px}.id{font-weight:600}.text{font-size:16px;margin:2px 0}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:4px 0;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.row label{min-width:110px}
button{font:inherit;padding:2px 10px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
button:disabled{opacity:.4;cursor:default}
.tag{font-size:12px;border:1px solid var(--line);border-radius:10px;padding:0 6px}
.facts{font-size:13px}
body.hide .facts,body.hide .verdict{visibility:hidden}
pre{white-space:pre-wrap;word-break:break-all;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;min-height:1.5em}
#bar{position:sticky;bottom:0;background:var(--bg);border-top:1px solid var(--line);padding:8px 0}
input.note{flex:1;min-width:160px;font:inherit;font-size:13px;padding:2px 6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
textarea.memo{width:100%;box-sizing:border-box;min-height:2.4em;margin-top:6px;font:inherit;font-size:13px;padding:4px 6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
#report{max-height:30vh;overflow:auto}
</style></head>
<body><main>
<h1>Takes</h1>
<div id="info" class="muted"></div>
<ul id="notes" class="warn"></ul>
<div class="top">
<label><input type="checkbox" id="hide"> 수치 숨기기</label>
<button id="clear">선택 모두 지우기</button>
<button id="clearNotes">코멘트 모두 지우기</button>
<span id="now" class="muted"></span>
</div>
<p class="muted">고른 뒤 아래 명령을 실행하고 <code>s2v tts</code>를 돌려야 반영됩니다(TTS는 이미지 생성과 동시에 돌리지 마세요). 그 뒤 <code>s2v takes</code>를 다시 실행하면 이 페이지가 갱신됩니다. 소리는 render와 같은 음량이며, 대사의 volume·power도 들어 있습니다.</p>
<div id="lines"></div>
<div id="bar">
<div id="restored" class="warn"></div>
<pre id="cmd"></pre>
<button id="copy">명령 복사</button> <span id="copied" class="muted"></span>
<pre id="report"></pre>
<button id="copyReport">코멘트 복사</button> <span id="copiedReport" class="muted"></span>
</div>
<audio id="player" preload="auto"></audio>
</main>
<script id="data" type="application/json">${scriptJson(data)}</script>
<script>${PAGE_JS}</script>
</body></html>
`;
}

/**
 * The page's own JS (3b-2 plan 4). Pure functions first (tested in node:vm), the DOM wiring only
 * when there is a document.
 */
export const PAGE_JS = String.raw`
'use strict';
function shellQuote(s) {
  return /^[\w./:@%+=-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Shown lines grouped by pick key, in script order (one pick applies to the group). */
function groups(data) {
  var out = [], seen = {};
  data.lines.forEach(function (l) {
    if (!l.target) return;
    if (!seen[l.pickKey]) { seen[l.pickKey] = { pickKey: l.pickKey, first: l, lines: [] }; out.push(seen[l.pickKey]); }
    seen[l.pickKey].lines.push(l);
  });
  return out;
}

/**
 * The commands for the choices (state: pick key → take number | 'unpick'; absent = keep).
 * Only picks.json decides: a take is a command unless it is already the human pick.
 */
function buildCommands(data, state) {
  var picks = [], unpicks = [];
  groups(data).forEach(function (g) {
    var choice = state[g.pickKey];
    var pick = g.first.pick;
    if (choice === undefined) return;
    if (choice === 'unpick') { if (pick) unpicks.push(g.first.id); return; }
    if (pick && pick.take === choice && pick.by === 'human') return;
    picks.push(g.first.id + '=' + choice);
  });
  var lines = [];
  if (picks.length) lines.push('s2v takes pick ' + data.scriptArg + ' ' + picks.join(' '));
  if (unpicks.length) lines.push('s2v takes unpick ' + data.scriptArg + ' ' + unpicks.join(' '));
  return lines;
}

/** The saved choice for a pick key as it was based (the pick then). */
function baseOf(line) {
  return line.pick ? { take: line.pick.take, by: line.pick.by } : null;
}
function sameBase(a, b) {
  return (a === null && b === null) || (!!a && !!b && a.take === b.take && a.by === b.by);
}

/**
 * Saved choices back onto this page (only its pick keys): applied ones are dropped quietly,
 * those whose base is still the state come back, the rest are dropped and counted.
 */
function restore(saved, data) {
  var state = {}, keep = {}, dropped = 0;
  Object.keys(saved || {}).forEach(function (k) { keep[k] = saved[k]; });
  groups(data).forEach(function (g) {
    var s = keep[g.pickKey];
    if (!s) return;
    var pick = g.first.pick;
    var applied =
      (typeof s.choice === 'number' && pick && pick.take === s.choice && pick.by === 'human') ||
      (s.choice === 'unpick' && !pick);
    if (applied) { delete keep[g.pickKey]; return; }
    if (sameBase(s.base, baseOf(g.first))) { state[g.pickKey] = s.choice; return; }
    delete keep[g.pickKey];
    dropped++;
  });
  return { state: state, saved: keep, dropped: dropped };
}

/** The wav a line plays as a neighbour: chosen take, else the pending pick, else its lock. */
function neighbourWav(line, state) {
  var choice = state[line.pickKey];
  var playable = function (n) {
    var t = (line.takes || []).filter(function (x) { return x.n === n; })[0];
    return t && t.wav ? t.wav : null;
  };
  if (typeof choice === 'number' && playable(choice)) return { wav: playable(choice), what: 'take ' + choice + ' (chosen)' };
  if (choice !== 'unpick' && line.pick && playable(line.pick.take)) return { wav: playable(line.pick.take), what: 'pick ' + line.pick.take };
  if (line.lockWav) return { wav: line.lockWav, what: choice === 'unpick' ? 'lock (before the automatic choice)' : 'lock' };
  return null;
}

/**
 * What "지금 그대로" sounds like: the take the next tts leaves there — a pending pick, else the
 * lock (null: nothing to play).
 */
function keepSound(line) {
  var t = line.pick && (line.takes || []).filter(function (x) { return x.n === line.pick.take && x.wav; })[0];
  if (t) {
    var pending = line.pick.take !== line.lockTake;
    return { n: t.n, wav: t.wav, label: '테이크 ' + t.n + (pending ? ' (pick, tts 전)' : ' (pick)') };
  }
  if (line.lockWav)
    return {
      n: line.lockTake,
      wav: line.lockWav,
      label: '테이크 ' + line.lockTake + ' (lock)' + (line.reselect ? ' — 다음 tts에서 바뀔 수 있음' : ''),
    };
  return null;
}

/** Previous line, this take, next line — inside the paragraph, with the render's gaps. */
function contextPlan(data, state, id, wav) {
  var line = data.lines.filter(function (l) { return l.id === id; })[0];
  var at = function (i) { return data.lines.filter(function (l) { return l.para === line.para && l.index === i; })[0]; };
  var prev = at(line.index - 1), next = at(line.index + 1);
  var plan = [];
  var p = prev && neighbourWav(prev, state);
  if (p) plan.push({ wav: p.wav, what: prev.id + ' ' + p.what, gapAfter: data.sentenceGap + prev.pauseAfter });
  plan.push({ wav: wav, what: id, gapAfter: next ? data.sentenceGap + line.pauseAfter : 0 });
  var q = next && neighbourWav(next, state);
  if (q) plan.push({ wav: q.wav, what: next.id + ' ' + q.what, gapAfter: 0 });
  else plan[plan.length - 1].gapAfter = 0;
  return plan;
}

/**
 * The comments as text (notes: line id → { memo, takes: { n: text } }), with what was chosen.
 * Empty when there is no comment.
 */
function buildReport(data, notes, state) {
  var out = [];
  data.lines.forEach(function (l) {
    if (!l.target) return;
    var n = notes[l.id] || {};
    var memo = (n.memo || '').trim();
    var takes = Object.keys(n.takes || {})
      .map(Number)
      .sort(function (a, b) { return a - b; })
      .filter(function (k) { return (n.takes[k] || '').trim(); });
    if (!memo && !takes.length) return;
    var choice = state[l.pickKey];
    var head = l.id + ' "' + l.text + '"' + (l.lockTake !== null ? ' — lock ' + l.lockTake : '') +
      (l.pick ? ', pick ' + l.pick.take : '') +
      (typeof choice === 'number' ? ', 고름 ' + choice : choice === 'unpick' ? ', 자동 선택으로' : '');
    out.push(head);
    if (memo) out.push('  - 메모: ' + memo.replace(/\s*\n\s*/g, ' / '));
    takes.forEach(function (k) { out.push('  - 테이크 ' + k + ': ' + n.takes[k].trim().replace(/\s*\n\s*/g, ' / ')); });
  });
  return out.length ? ['테이크 코멘트 — ' + data.script, ''].concat(out).join('\n') : '';
}

if (typeof document !== 'undefined') (function () {
  var data = JSON.parse(document.getElementById('data').textContent);
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var load = function () { try { return JSON.parse(localStorage.getItem(data.storageKey) || '{}'); } catch (e) { return {}; } };
  var store = function (all) { try { localStorage.setItem(data.storageKey, JSON.stringify(all)); } catch (e) {} };
  var notesKey = data.storageKey + ':notes';
  var loadNotes = function () { try { return JSON.parse(localStorage.getItem(notesKey) || '{}'); } catch (e) { return {}; } };
  var notes = loadNotes();
  var noteOf = function (id, n) {
    var x = notes[id] || {};
    return (n === null ? x.memo : (x.takes || {})[n]) || '';
  };
  var r = restore(load(), data);
  var state = r.state;
  store(r.saved);
  if (r.dropped) document.getElementById('restored').textContent = '저장된 선택 ' + r.dropped + '개가 지금 상태와 달라 버렸어요';

  document.getElementById('info').textContent = data.script + ' · ' + data.lang + ' · ' + groups(data).reduce(function (n, g) { return n + g.lines.length; }, 0) + ' lines';
  document.getElementById('notes').innerHTML = data.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('');
  var hide = document.getElementById('hide');
  try { hide.checked = localStorage.getItem('s2v-takes:hide') === '1'; } catch (e) {}
  document.body.classList.toggle('hide', hide.checked);
  hide.onchange = function () { document.body.classList.toggle('hide', hide.checked); try { localStorage.setItem('s2v-takes:hide', hide.checked ? '1' : '0'); } catch (e) {} };

  var sourceText = { lock: 'lock', cut: 'cut', uncut: '자르기 전', many: '자른 wav가 여럿 — 자르기 전', raw: '원본에서 만듦·자르기 전', none: '캐시 없음' };
  var html = '';
  data.lines.forEach(function (l, li) {
    if (!l.target) return;
    var name = 'c' + li;
    var head = '<div class="head"><span class="id">' + esc(l.id) + '</span> ' +
      (l.emo ? '<span class="tag">' + esc(l.emo) + (l.power ? ' ' + esc(l.power) : '') + '</span> ' : '') +
      '<div class="text">' + esc(l.text) + '</div><div class="muted">' + esc(l.lockNote) +
      (l.lockTake !== null ? ' · lock take ' + l.lockTake : '') +
      (l.pick ? ' · pick ' + esc(l.pick.take) + ' (' + esc(l.pick.by) + ')' + (l.pick.take !== l.lockTake ? ' — tts 전' : '') : '') +
      (l.shared.length ? ' · 같은 pick: ' + esc(l.shared.join(', ')) : '') + '</div></div>';
    var cur = keepSound(l);
    var rows = '<div class="row"><label><input type="radio" name="' + name + '" data-key="' + esc(l.pickKey) + '" value="keep"> ' + (l.reselect ? '자동 선택(다음 tts에서 다시 고름)' : '지금 그대로') + '</label>' +
      (cur
        ? '<button data-play="' + esc(cur.wav) + '">▶ 단독</button>' +
          '<button data-context="' + esc(l.id) + '" data-wav="' + esc(cur.wav) + '">▶ 이어 듣기</button>' +
          ' <span class="muted">= ' + esc(cur.label) + '</span>'
        : ' <span class="muted">들을 소리 없음</span>') +
      '</div>';
    if (l.pick) rows += '<div class="row"><label><input type="radio" name="' + name + '" data-key="' + esc(l.pickKey) + '" value="unpick"> 자동 선택으로</label></div>';
    l.takes.forEach(function (t) {
      var tags = [];
      if (t.n === l.lockTake) tags.push('lock');
      if (l.pick && t.n === l.pick.take) tags.push('pick');
      var verdict = t.ok === null ? '<span class="muted">기록 없음</span>' : t.ok ? '<span class="good">통과</span>' : '<span class="bad">실패</span>';
      var facts = (t.f0 !== null ? 'f0 ' + t.f0 + ' Hz ' : '') + (t.rate !== null ? '빠르기 ' + t.rate + ' 자/초' : '');
      rows += '<div class="row"><label><input type="radio" name="' + name + '" data-key="' + esc(l.pickKey) + '" value="' + t.n + '"' + (t.wav ? '' : ' disabled') + '> 테이크 ' + t.n + '</label>' +
        '<button data-play="' + esc(t.wav || '') + '"' + (t.wav ? '' : ' disabled') + '>▶ 단독</button>' +
        '<button data-context="' + esc(l.id) + '" data-wav="' + esc(t.wav || '') + '"' + (t.wav ? '' : ' disabled') + '>▶ 이어 듣기</button>' +
        tags.map(function (x) { return '<span class="tag">' + x + '</span>'; }).join(' ') +
        ' <span class="verdict">' + verdict + '</span> <span class="facts muted">' + facts + '</span> <span class="muted">' + sourceText[t.source] + '</span>' +
        (t.wav ? '' : ' <span class="muted">— s2v tts ' + esc(data.scriptArg) + ' --retry ' + esc(l.id) + '</span>') +
        '<input type="text" class="note" data-id="' + esc(l.id) + '" data-take="' + t.n + '" placeholder="테이크 ' + t.n + ' 코멘트" value="' + esc(noteOf(l.id, t.n)) + '"></div>';
    });
    var memo = '<textarea class="memo" data-id="' + esc(l.id) + '" placeholder="이 문장 메모">' + esc(noteOf(l.id, null)) + '</textarea>';
    html += '<div class="card">' + head + rows + memo + '</div>';
  });
  document.getElementById('lines').innerHTML = html;

  var sync = function () {
    document.querySelectorAll('input[type=radio]').forEach(function (r) {
      var v = state[r.dataset.key];
      r.checked = v === undefined ? r.value === 'keep' : String(v) === r.value;
    });
    var cmds = buildCommands(data, state);
    document.getElementById('cmd').textContent = cmds.length ? cmds.join('\n') : '바꾼 문장 없음';
    showReport();
    var all = load();
    groups(data).forEach(function (g) {
      if (state[g.pickKey] === undefined) delete all[g.pickKey];
      else all[g.pickKey] = { choice: state[g.pickKey], base: baseOf(g.first) };
    });
    store(all);
  };
  document.getElementById('lines').addEventListener('change', function (e) {
    var r = e.target;
    if (r.type !== 'radio') return;
    if (r.value === 'keep') delete state[r.dataset.key];
    else state[r.dataset.key] = r.value === 'unpick' ? 'unpick' : Number(r.value);
    sync();
  });
  function showReport() {
    var text = buildReport(data, notes, state);
    document.getElementById('report').textContent = text || '코멘트 없음';
  }
  document.getElementById('lines').addEventListener('input', function (e) {
    var el = e.target, id = el.dataset && el.dataset.id;
    if (!id) return;
    var x = notes[id] || (notes[id] = {});
    if (el.classList.contains('memo')) x.memo = el.value;
    else (x.takes || (x.takes = {}))[el.dataset.take] = el.value;
    // only this page's lines are written; other lines' comments stay
    var all = loadNotes();
    all[id] = x;
    try { localStorage.setItem(notesKey, JSON.stringify(all)); } catch (err) {}
    showReport();
  });
  document.getElementById('clearNotes').onclick = function () {
    if (!confirm('이 페이지의 코멘트를 모두 지울까요?')) return;
    var all = loadNotes();
    data.lines.forEach(function (l) { delete all[l.id]; delete notes[l.id]; });
    try { localStorage.setItem(notesKey, JSON.stringify(all)); } catch (err) {}
    document.querySelectorAll('input.note, textarea.memo').forEach(function (el) { el.value = ''; });
    showReport();
  };
  document.getElementById('clear').onclick = function () { state = {}; sync(); };
  sync();

  // one player for everything: WebKit allows a started element to go on (src swaps)
  var player = document.getElementById('player'), gen = 0, now = document.getElementById('now');
  var stop = function () { gen++; player.pause(); now.textContent = ''; };
  var play = function (items) {
    stop();
    var g = gen, i = 0;
    var step = function () {
      if (g !== gen || i >= items.length) { if (g === gen) now.textContent = ''; return; }
      var it = items[i++];
      now.textContent = '▶ ' + it.what;
      player.src = it.wav + '?v=' + data.build;
      player.onended = function () { if (g === gen) setTimeout(step, it.gapAfter * 1000); };
      var p = player.play();
      if (p && p.catch) p.catch(function () { if (g === gen) now.textContent = '재생이 막혔어요 — 다시 눌러 주세요'; });
    };
    step();
  };
  document.getElementById('lines').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.play) play([{ wav: b.dataset.play, what: b.dataset.play, gapAfter: 0 }]);
    else if (b.dataset.context) play(contextPlan(data, state, b.dataset.context, b.dataset.wav));
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') stop(); });

  var copy = function (text, status) {
    var done = function () { document.getElementById(status).textContent = '복사했어요'; };
    var fallback = function () {
      var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { if (document.execCommand('copy')) done(); } catch (e) {} document.body.removeChild(ta);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  };
  document.getElementById('copy').onclick = function () { copy(document.getElementById('cmd').textContent, 'copied'); };
  document.getElementById('copyReport').onclick = function () { copy(buildReport(data, notes, state), 'copiedReport'); };
})();
`;

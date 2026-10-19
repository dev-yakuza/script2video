/**
 * `s2v direct` (acting stage 6 plan): one output's direction plan without a render — who speaks
 * when, how (emotion, face, motion, looks, reactions) and with which gaps — and director notes
 * that say what to do where a script is likely to look flat. Times come from the real timeline,
 * built on the synthesized audio that matches the script and estimates for the rest.
 */

import { actsEmotion, emotionFace, emotionSentence, engineOf, paragraphActing } from './acting.js';
import { filledManifest } from './lint-budget.js';
import { resolveRhythm, rhythmGaps, type RhythmRule, type RhythmValues } from './rhythm.js';
import type { Acting, Framing, LookValue, Paragraph, Script } from './schema.js';
import { includesParagraph, selectScenes, stageEvents, type Side } from './stage.js';
import { buildTimeline, motionFor, sentenceId, type AudioManifest } from './timeline.js';

/** Thresholds of the director notes (plan 3). */
export const DIRECT = {
  /** Paragraphs of one cast in a row with the same emotion. */
  sameEmotionRun: 6,
  /** Seconds of a scene without a listener reaction, look or entrance. */
  noReactionS: 30,
  /** Paragraphs of one cast in a row (dialogue). */
  longTurn: 4,
  /** Lines of a cast before a missing emotion is worth a note. */
  flatMinLines: 10,
  /** Notes of one code per output; the rest are counted. */
  perCode: 5,
} as const;

export interface DirectListener {
  cast: string;
  /** `:react` face and the motion it brings. */
  face?: string;
  motion?: string;
  /** `:look` of a cast that is not the speaker. */
  look?: LookValue;
}

export interface DirectSentence {
  id: string;
  text: string;
  acting?: Acting;
  /** An inline `:emo` starts here. */
  change: boolean;
  /** The voice acts the emotion (an acting engine, not a recording). */
  acts: boolean;
  /** Real audio (else estimated). */
  measured: boolean;
  /** Start in the video (seconds). */
  start: number;
  /** Character mode only: the face drawn (look variant applied). */
  face?: string;
  /** The emotion's face cannot be drawn: `wanted` is shown as `drawn`. */
  fallback?: { wanted: string; drawn: string };
  /** The look variant the character lacks. */
  lookMissing?: string;
  /** The speaker's look when not at the partner. */
  look?: LookValue;
  listeners: DirectListener[];
}

export interface DirectRow {
  /** `scene:block`. */
  id: string;
  line: number;
  cast: string;
  start: number;
  /** An earlier sentence of the output is estimated, so this time is too. */
  estimated: boolean;
  /** The gap before it (absent on a scene's first paragraph). */
  gap?: { seconds: number; explicit: boolean; factor: number; rules: RhythmRule[] };
  recording: boolean;
  sentences: DirectSentence[];
  /** Character mode only: motions by sentence index. */
  motions: { sentence: number; motion: string }[];
}

export interface DirectScene {
  id: string;
  title: string;
  start: number;
  estimated: boolean;
  stage: { cast: string; kind: 'enter' | 'exit'; at: number }[];
  rows: DirectRow[];
}

export interface DirectNote {
  code: 'flat-emotion' | 'same-emotion-run' | 'no-reaction' | 'long-turn' | 'trained-joy';
  message: string;
  line?: number;
  rowId?: string;
  /** The cast the note is about (no-reaction: the one talking). */
  cast?: string;
  /** The last paragraph of a run or a long turn. */
  toRowId?: string;
  toLine?: number;
  /** no-reaction: the cast that does not react. */
  listener?: string;
  /** same-emotion-run, trained-joy: the emotion. */
  emo?: string;
}

export interface DirectPlan {
  output: string;
  lang: string;
  layout: string;
  /** Same split as the renderer: characters, circle avatars (dialogue layout), or neither. */
  mode: 'character' | 'avatar' | 'none';
  fps: number;
  seconds: number;
  /** Sentences of this output with real audio, of all. */
  measured: number;
  total: number;
  rhythm: { on: boolean; values: RhythmValues };
  idle: boolean;
  /** Sentences per emotion (`none`: no emo) for each speaking cast. */
  emotions: Record<string, Record<string, number>>;
  scenes: DirectScene[];
  notes: DirectNote[];
  /** Notes before the per-code cap. */
  noteCount: number;
  /** Every note, before the per-code cap (same order; for tools, S9b). */
  allNotes: DirectNote[];
}

export function directPlan(
  script: Script,
  output: string,
  manifest: AudioManifest,
  opts: { rhythm?: boolean; fps?: number } = {},
): DirectPlan {
  const { meta } = script;
  const profile = meta.outputs[output];
  if (!profile) throw new Error(`unknown output "${output}"`);
  const fps = opts.fps ?? 30;
  const { filled } = filledManifest(script, manifest);
  const rhythm = resolveRhythm(script, output, opts.rhythm);
  const { timeline } = buildTimeline(
    script,
    output,
    filled,
    fps,
    opts.rhythm === undefined ? {} : { rhythm: opts.rhythm },
  );
  const stage = stageEvents(script, output);
  const mode = stage.characterMode
    ? 'character'
    : profile.layout === 'dialogue'
      ? 'avatar'
      : 'none';
  const gapOf = new Map(rhythm.on ? rhythmGaps(script, output).map((g) => [g.paragraph, g]) : []);
  const sec = (frames: number) => frames / fps;

  let anyEstimated = false;
  let measured = 0;
  let total = 0;
  const emotions: Record<string, Record<string, number>> = {};
  const scenes: DirectScene[] = [];
  const rowParagraph = new Map<DirectRow, Paragraph>();
  const selected = selectScenes(script, profile);
  selected.forEach((scene, si) => {
    const ts = timeline.scenes[si]!;
    const audioStart = new Map(ts.audio.map((a) => [a.sentenceId, a.startFrame]));
    const out: DirectScene = {
      id: scene.id,
      title: scene.title,
      start: sec(ts.startFrame),
      estimated: anyEstimated,
      stage: (ts.stage ?? []).map((e) => ({
        cast: e.cast,
        kind: e.kind,
        at: sec(ts.startFrame + e.frame),
      })),
      rows: [],
    };
    let first = true;
    scene.blocks.forEach((b, bi) => {
      if (b.kind !== 'paragraph' || !includesParagraph(b, output)) return;
      const member = meta.cast[b.cast];
      const framing: Framing = ts.framing[b.cast] ?? 'full';
      const acting = mode === 'character' ? paragraphActing(meta, b, framing) : undefined;
      const rowStart = audioStart.get(sentenceId(scene.id, bi, 0));
      const row: DirectRow = {
        id: `${scene.id}:${bi}`,
        line: b.line,
        cast: b.cast,
        start: sec(ts.startFrame + (rowStart ?? 0)),
        estimated: anyEstimated,
        recording: b.audio !== undefined,
        sentences: [],
        motions: (acting?.runs ?? []).flatMap((r) =>
          r.motion ? [{ sentence: r.sentence, motion: r.motion }] : [],
        ),
      };
      if (!first) {
        const g = gapOf.get(b);
        const factor = b.gap === undefined ? (g?.factor ?? 1) : 1;
        row.gap = {
          seconds: b.gap ?? meta.pacing.paragraphGap * factor,
          explicit: b.gap !== undefined,
          factor,
          rules: g?.rules ?? (b.gap !== undefined ? ['explicit'] : []),
        };
      }
      first = false;
      const counts = (emotions[b.cast] ??= {});
      b.sentences.forEach((s, i) => {
        const id = sentenceId(scene.id, bi, i);
        const real = manifest[id] !== undefined;
        total++;
        if (real) measured++;
        const emo = s.acting?.emo ?? 'none';
        counts[emo] = (counts[emo] ?? 0) + 1;
        const ds: DirectSentence = {
          id,
          text: s.text,
          ...(s.acting ? { acting: s.acting } : {}),
          change: s.actingChange === true,
          acts: !!member && !b.audio && emotionSentence(engineOf(member), s.acting),
          measured: real,
          start: sec(ts.startFrame + (audioStart.get(id) ?? 0)),
          listeners: [],
        };
        const f = acting?.faces[i];
        if (f) {
          ds.face = f.shown;
          const want = emotionFace(meta, s.acting?.emo);
          if (member?.faceSets && !b.face && want !== undefined && f.drawn !== f.wanted)
            ds.fallback = { wanted: f.wanted, drawn: f.drawn };
          if (f.missing) ds.lookMissing = f.missing;
          if (f.look !== 'partner') ds.look = f.look;
        }
        for (const r of s.reacts ?? [])
          for (const [cast, face] of Object.entries(r.faces)) {
            const motion =
              mode === 'character' ? motionFor(meta, cast, face, r.motions?.[cast]) : undefined;
            ds.listeners.push({ cast, face, ...(motion ? { motion } : {}) });
          }
        for (const l of s.looks ?? [])
          for (const [cast, look] of Object.entries(l.looks))
            if (cast !== b.cast) ds.listeners.push({ cast, look });
        row.sentences.push(ds);
        if (!real) anyEstimated = true;
      });
      out.rows.push(row);
      rowParagraph.set(row, b);
    });
    scenes.push(out);
  });

  const plan: DirectPlan = {
    output,
    lang: meta.lang,
    layout: profile.layout,
    mode,
    fps,
    seconds: sec(timeline.totalFrames),
    measured,
    total,
    rhythm,
    idle: meta.acting?.idle !== false,
    emotions,
    scenes,
    notes: [],
    noteCount: 0,
    allNotes: [],
  };
  // Who stands opposite a row's speaker (no-reaction): nobody when the stage says that side is
  // empty (with entrances or exits every paragraph has an entry) or no cast of the output sits
  // there; else the cast of that side seen last (speaking or reacting) up to this row, else the
  // next one seen, among those not away.
  const rows = scenes.flatMap((x) => x.rows);
  // a scene's entrances come before its first row
  const entering = new Map(
    scenes.map((x) => [x.rows[0], x.stage.filter((e) => e.kind === 'enter').map((e) => e.cast)]),
  );
  const seen = rows.map((r) => [
    ...(entering.get(r) ?? []),
    r.cast,
    ...r.sentences.flatMap((x) => x.listeners.filter((l) => l.face).map((l) => l.cast)),
  ]);
  const opposite = (row: DirectRow): string | undefined => {
    const side = stage.side[row.cast];
    if (!side) return undefined;
    const opp: Side = side === 'left' ? 'right' : 'left';
    const p = rowParagraph.get(row)!;
    if (stage.empty.get(p)?.has(opp)) return undefined;
    const away = stage.absent.get(p);
    const ok = (c: string) => stage.side[c] === opp && !away?.has(c);
    const i = rows.indexOf(row);
    for (let k = i; k >= 0; k--) {
      const c = seen[k]!.filter(ok).pop();
      if (c) return c;
    }
    for (let k = i + 1; k < rows.length; k++) {
      const c = seen[k]!.find(ok);
      if (c) return c;
    }
    return Object.keys(stage.side).find(ok);
  };
  const all = directNotes(script, plan, opposite);
  plan.noteCount = all.length;
  plan.allNotes = all;
  plan.notes = capNotes(all);
  return plan;
}

const fmt = (seconds: number) => {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function directNotes(
  script: Script,
  plan: DirectPlan,
  opposite: (row: DirectRow) => string | undefined,
): DirectNote[] {
  const { meta } = script;
  const notes: DirectNote[] = [];
  const rows = plan.scenes.flatMap((s) => s.rows);
  const speakers = new Set(rows.map((r) => r.cast));
  const name = (cast: string) => meta.cast[cast]?.name ?? cast;

  // flat-emotion: a cast whose voice acts, with many lines and no emo at all
  if (speakers.size >= 2)
    for (const cast of speakers) {
      const member = meta.cast[cast];
      if (!member || !actsEmotion(engineOf(member))) continue;
      const lines = rows.filter((r) => r.cast === cast && !r.recording).flatMap((r) => r.sentences);
      if (lines.length < DIRECT.flatMinLines || lines.some((s) => s.acting?.emo !== undefined))
        continue;
      const first = rows.find((r) => r.cast === cast && !r.recording)!;
      notes.push({
        code: 'flat-emotion',
        message: `${name(cast)} has no emo in ${lines.length} lines. Put emo= on the lines whose words carry a feeling (surprise, joy, worry); leave plain explanations without it.`,
        line: first.line,
        rowId: first.id,
        cast,
      });
    }

  for (const scene of plan.scenes) {
    // same-emotion-run: one cast's paragraphs with the same emotion (first sentence's), others skipped
    const runs = new Map<string, { emo: string; rows: DirectRow[] }>();
    const flush = (cast: string) => {
      const run = runs.get(cast);
      runs.delete(cast);
      if (!run || run.rows.length < DIRECT.sameEmotionRun) return;
      const third = run.rows[2]!;
      const last = run.rows[run.rows.length - 1]!;
      notes.push({
        code: 'same-emotion-run',
        message: `${name(cast)} is ${run.emo} in ${run.rows.length} paragraphs in a row (lines ${run.rows[0]!.line}–${last.line}). Lower the 3rd (line ${third.line}) to calm or neutral, or change it mid-paragraph with :emo.`,
        line: run.rows[0]!.line,
        rowId: run.rows[0]!.id,
        cast,
        toRowId: last.id,
        toLine: last.line,
        emo: run.emo,
      });
    };
    for (const row of scene.rows) {
      if (row.recording) continue;
      const emo = row.sentences[0]?.acting?.emo;
      const run = runs.get(row.cast);
      if (emo === undefined || emo === 'neutral') flush(row.cast);
      else if (run && run.emo === emo) run.rows.push(row);
      else {
        flush(row.cast);
        runs.set(row.cast, { emo, rows: [row] });
      }
    }
    for (const cast of [...runs.keys()]) flush(cast);

    // long-turn: one cast speaking many paragraphs in a row (recordings count as turns)
    if (speakers.size >= 2) {
      let i = 0;
      while (i < scene.rows.length) {
        let j = i;
        while (j + 1 < scene.rows.length && scene.rows[j + 1]!.cast === scene.rows[i]!.cast) j++;
        const n = j - i + 1;
        if (n >= DIRECT.longTurn) {
          const cast = scene.rows[i]!.cast;
          const others = [...speakers].filter((c) => c !== cast).map(name);
          notes.push({
            code: 'long-turn',
            message: `${name(cast)} speaks ${n} paragraphs in a row (lines ${scene.rows[i]!.line}–${scene.rows[j]!.line}). Break it with a question or a short reply from ${others.join(' or ')}.`,
            line: scene.rows[i]!.line,
            rowId: scene.rows[i]!.id,
            cast,
            toRowId: scene.rows[j]!.id,
            toLine: scene.rows[j]!.line,
          });
        }
        i = j + 1;
      }
    }

    // no-reaction: with idle motion off nobody nods by itself. Windows run over rows with someone
    // opposite, from the scene start or the last reaction / listener look to the next one (or a
    // row with nobody opposite, or the scene's last paragraph start), timed at sentence starts.
    if (plan.mode === 'character' && !plan.idle && scene.rows.length > 0) {
      let from: number | null = null;
      let window: DirectRow[] = [];
      const close = (t: number) => {
        if (from === null || t - from < DIRECT.noReactionS) return;
        const start = from;
        // the cast talking most in the window, and whoever stands opposite it
        const talking = window.filter((r) => r.start > start);
        const pool = talking.length ? talking : window;
        const count = new Map<string, number>();
        for (const r of pool) count.set(r.cast, (count.get(r.cast) ?? 0) + 1);
        const main = [...count].sort((x, y) => y[1] - x[1])[0]![0];
        const at = pool.find((r) => r.cast === main && opposite(r) !== undefined);
        const listener = at && opposite(at);
        if (!at || !listener) return;
        const estimated = window.some((r) => r.estimated || r.sentences.some((x) => !x.measured));
        notes.push({
          code: 'no-reaction',
          message: `${scene.id} ${fmt(start)}–${fmt(t)}${estimated ? ' (estimated)' : ''}: ${name(listener)} does not react while ${name(main)} talks. Add :react{${listener}=surprised} at the word ${name(listener)} would react to.`,
          line: at.line,
          rowId: at.id,
          cast: main,
          listener,
        });
      };
      for (const row of scene.rows) {
        if (opposite(row) === undefined) {
          close(row.start);
          from = null;
          window = [];
          continue;
        }
        if (from === null) {
          from = row.start;
          window = [];
        }
        window.push(row);
        for (const x of row.sentences)
          if (x.listeners.length > 0 && x.start > from) {
            close(x.start);
            from = x.start;
            window = [row];
          } else if (x.listeners.length > 0) from = Math.max(from, x.start);
      }
      close(scene.rows[scene.rows.length - 1]!.start);
    }

    // trained-joy: trained voices are weak when happy and can sound angry when excited
    for (const row of scene.rows) {
      const member = meta.cast[row.cast];
      if (row.recording || !member || engineOf(member) !== 'trained') continue;
      const said = new Set<string>();
      row.sentences.forEach((s) => {
        const emo = s.acting?.emo;
        if ((emo !== 'happy' && emo !== 'excited') || s.acting?.power || said.has(emo)) return;
        said.add(emo);
        notes.push({
          code: 'trained-joy',
          message:
            emo === 'happy'
              ? `${name(row.cast)} line ${row.line} (happy): trained voices can sound flat when happy. Try power=strong and compare in s2v takes (tentative).`
              : `${name(row.cast)} line ${row.line} (excited): trained voices can sound angry when excited. Listen in s2v takes; if it does, try happy power=strong or drop emo (tentative).`,
          line: row.line,
          rowId: row.id,
          cast: row.cast,
          emo,
        });
      });
    }
  }
  return notes;
}

/** At most `DIRECT.perCode` notes of each code, then one "and N more" note. */
function capNotes(notes: DirectNote[]): DirectNote[] {
  const out: DirectNote[] = [];
  const count = new Map<string, number>();
  for (const n of notes) {
    const c = (count.get(n.code) ?? 0) + 1;
    count.set(n.code, c);
    if (c <= DIRECT.perCode) out.push(n);
  }
  for (const [code, c] of count)
    if (c > DIRECT.perCode)
      out.push({
        code: code as DirectNote['code'],
        message: `…and ${c - DIRECT.perCode} more ${code} notes.`,
      });
  return out;
}

/**
 * `s2v direct <script>` (acting stage 6 plan): the direction plan of one output as an HTML page,
 * with director notes. No server runs and nothing is synthesized: lines whose audio matches the
 * script use it, the rest are estimated.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  formatDiagnostic,
  type AudioManifest,
  type Diagnostic,
  type DirectPlan,
  type DirectRow,
  type DirectSentence,
  type Script,
} from '@script2video/core';
import { escapeHtml as esc } from './html.js';
import { mockEnabled } from './mock-tts.js';
import { scriptJson } from './takes-page.js';
import { planSentences, type LockManifest } from './tts.js';

export interface DirectManifest {
  manifest: AudioManifest;
  /** Lines synthesized before whose text or voice changed since (estimated now). */
  stale: number;
  /**
   * The lock's id map is the current plan's: what lint measured the length with is what the page
   * uses (otherwise its length diagnostics are dropped from the page).
   */
  current: boolean;
  /** Why some or all lines are estimated. */
  notes: string[];
  mock: boolean;
}

/**
 * The synthesized audio of the current script: every line whose current key has a lock entry
 * (as `tts` would reuse it, even when ids moved because paragraphs were added or removed).
 */
export function directManifest(
  scriptPath: string,
  script: Script,
  repoRoot: string,
  mock = mockEnabled(),
): DirectManifest {
  const notes: string[] = [];
  const lockDir = join(dirname(scriptPath), 'audio', script.meta.lang);
  const path = join(lockDir, 'manifest.json');
  if (mock) notes.push('S2V_TTS=mock: mock keys — only audio made with the mock voice counts');
  if (!existsSync(path)) return { manifest: {}, stale: 0, current: true, notes, mock };
  let plan: ReturnType<typeof planSentences>;
  try {
    plan = planSentences(scriptPath, script, repoRoot, { draft: false, mock });
  } catch {
    notes.push(
      'all lines estimated: the voices of this script cannot be planned (run s2v lint / s2v doctor)',
    );
    return { manifest: {}, stale: 0, current: false, notes, mock };
  }
  for (const e of plan.errors)
    notes.push(
      `${e.message.startsWith(`${e.id}:`) ? e.message : `${e.id}: ${e.message}`} (estimated)`,
    );
  const lock = JSON.parse(readFileSync(path, 'utf8')) as LockManifest;
  const manifest: AudioManifest = {};
  let stale = 0;
  for (const [id, key] of Object.entries(plan.sentences)) {
    const entry = lock.entries[key];
    if (entry && existsSync(join(lockDir, entry.src)))
      manifest[id] = {
        src: join(lockDir, entry.src),
        duration: entry.duration,
        words: entry.words,
      };
    else if (lock.sentences[id] !== undefined) stale++;
  }
  if (stale > 0) notes.push(`${stale} lines changed since the last s2v tts (estimated)`);
  const ids = (m: Record<string, string>) => JSON.stringify(Object.entries(m).sort());
  const current = ids(lock.sentences) === ids(plan.sentences);
  return { manifest, stale, current, notes, mock };
}

/**
 * The diagnostics that concern this output: not those naming another output, nor those on a line
 * inside a scene or a paragraph the output leaves out. Length diagnostics were measured with the
 * lock's id map and are dropped when it is not the current one (the page shows its own length).
 */
export function directDiagnostics(
  diagnostics: Diagnostic[],
  script: Script,
  plan: DirectPlan,
  current: boolean,
): Diagnostic[] {
  const otherOutput = (m: string) => {
    const tag =
      /\(output "([^"]+)"\)/.exec(m) ?? /in output "([^"]+)"/.exec(m) ?? /^"([^"]+)" is /.exec(m);
    return tag !== null && tag[1] !== plan.output;
  };
  const out = outsideLines(script, plan);
  return diagnostics.filter((d) => {
    if (d.severity === 'error') return true;
    if (otherOutput(d.message)) return false;
    if ((d.code === 'max-duration' || d.code === 'target-duration') && !current) return false;
    if (d.line !== undefined && out(d.line)) return false;
    return true;
  });
}

/** Line ranges of the script: each scene, and each block up to the next one. */
function blockRanges(script: Script) {
  const scenes = script.scenes.map((scene, i) => {
    const end = script.scenes[i + 1]?.line ?? Infinity;
    const blocks = scene.blocks.map((b, k) => ({
      block: b,
      from: b.line,
      to: scene.blocks[k + 1]?.line ?? end,
    }));
    return { scene, from: scene.line, to: end, blocks };
  });
  return scenes;
}

/** Whether a line belongs to a scene or a paragraph this output leaves out. */
function outsideLines(script: Script, plan: DirectPlan) {
  const shownScenes = new Set(plan.scenes.map((s) => s.id));
  const shownRows = new Set(plan.scenes.flatMap((s) => s.rows.map((r) => r.line)));
  const ranges = blockRanges(script);
  return (line: number) => {
    const s = ranges.find((r) => line >= r.from && line < r.to);
    if (!s) return false;
    if (!shownScenes.has(s.scene.id)) return true;
    const b = s.blocks.find((r) => line >= r.from && line < r.to);
    return b?.block.kind === 'paragraph' && !shownRows.has(b.block.line);
  };
}

/** The row a script line falls in (its paragraph, up to the next block). */
function rowAt(script: Script, plan: DirectPlan) {
  const rows = new Map(plan.scenes.flatMap((s) => s.rows.map((r) => [r.line, r.id] as const)));
  const ranges = blockRanges(script);
  return (line: number | undefined) => {
    if (line === undefined) return undefined;
    const b = ranges
      .flatMap((r) => r.blocks)
      .find((r) => line >= r.from && line < r.to && r.block.kind === 'paragraph');
    return b ? rows.get(b.block.line) : undefined;
  };
}

const PALETTE = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2'];
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const clock = (seconds: number) => {
  const t = Math.round(seconds * 10) / 10;
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
};

/** The page (plan 4): the same bytes for the same input — no dates, no absolute paths. */
export function directHtml(
  plan: DirectPlan,
  script: Script,
  opts: { scriptName: string; diagnostics: Diagnostic[]; notes: string[] },
): string {
  const { meta } = script;
  const castKeys = Object.keys(meta.cast);
  const color = (cast: string) => {
    const c = meta.cast[cast]?.color;
    return c && HEX.test(c) ? c : PALETTE[Math.max(0, castKeys.indexOf(cast)) % PALETTE.length]!;
  };
  const name = (cast: string) => meta.cast[cast]?.name ?? cast;
  const rowOf = rowAt(script, plan);
  const anchor = (id: string) =>
    `row-${id.replace(/[^A-Za-z0-9_-]/g, (c) => `_${c.charCodeAt(0)}`)}`;
  const time = (seconds: number, estimated: boolean) =>
    estimated ? `<span class="est" title="estimated">~${clock(seconds)}</span>` : clock(seconds);
  const who = (cast: string) =>
    `<span class="who"><i style="background:${color(cast)}"></i>${esc(name(cast))}</span>`;
  const badge = (text: string, cls = '') =>
    `<span class="b${cls ? ` ${cls}` : ''}">${esc(text)}</span>`;

  const sentence = (s: DirectSentence) => {
    const a = s.acting ?? {};
    const tags: string[] = [];
    if (s.change) tags.push(badge(':emo', 'change'));
    if (a.emo) tags.push(badge(a.emo, s.acts ? 'emo' : 'emo off'));
    if (a.emo && !s.acts) tags.push(badge('not acted', 'off'));
    if (a.power) tags.push(badge(`power ${a.power}`));
    if (a.volume) tags.push(badge(`volume ${a.volume}`));
    if (a.speed !== undefined) tags.push(badge(`speed ${a.speed}`));
    if (a.say) tags.push(badge(`say "${a.say}"`));
    return `<div class="s">${tags.join('')}<span class="t">${esc(s.text)}</span></div>`;
  };
  const faces = (r: DirectRow) =>
    r.sentences
      .map((s, i) => {
        const parts: string[] = [];
        if (s.face !== undefined) parts.push(esc(s.face));
        if (s.fallback) parts.push(badge(`no ${s.fallback.wanted} face`, 'warn'));
        if (s.lookMissing) parts.push(badge(`no ${s.lookMissing}`, 'warn'));
        const m = r.motions.find((x) => x.sentence === i);
        if (m) parts.push(badge(m.motion, 'motion'));
        return `<div class="s">${parts.join(' ')}</div>`;
      })
      .join('');
  const looks = (r: DirectRow) =>
    r.sentences
      .map((s) => {
        const parts: string[] = [];
        if (s.look) parts.push(`${esc(name(r.cast))} → ${esc(s.look)}`);
        for (const l of s.listeners)
          parts.push(
            l.look
              ? `${esc(name(l.cast))} looks ${esc(l.look)}`
              : `${esc(name(l.cast))}: ${esc(l.face ?? '')}${l.motion ? ` +${esc(l.motion)}` : ''}`,
          );
        return `<div class="s">${parts.join('<br>')}</div>`;
      })
      .join('');
  const gap = (r: DirectRow) =>
    r.gap
      ? `${r.gap.seconds.toFixed(2)}s${r.gap.factor !== 1 ? ` ×${r.gap.factor.toFixed(2)}` : ''}${r.gap.rules.map((x) => badge(x, 'rule')).join('')}`
      : '';
  const character = plan.mode === 'character';

  const rows = (rs: DirectRow[]) =>
    rs
      .map(
        (r) => `<tr id="${anchor(r.id)}">
<td class="time">${time(r.start, r.estimated)}<div class="line">line ${r.line}</div></td>
<td>${who(r.cast)}${r.recording ? badge('recording', 'off') : ''}</td>
<td>${r.sentences.map(sentence).join('')}</td>
${character ? `<td>${faces(r)}</td><td>${looks(r)}</td>` : ''}
<td class="gap">${gap(r)}</td>
</tr>`,
      )
      .join('\n');

  const scenes = plan.scenes
    .map((s) => {
      const stage = s.stage.length
        ? `<p class="stage">${s.stage.map((e) => `${e.kind === 'enter' ? '→' : '←'} ${esc(name(e.cast))} ${e.kind}s at ${time(e.at, s.estimated || (e.kind === 'exit' && s.rows.some((r) => r.sentences.some((x) => !x.measured))))}`).join(' · ')}</p>`
        : '';
      return `<section>
<h2><span class="time">${time(s.start, s.estimated)}</span> ${esc(s.title)} <code>#${esc(s.id)}</code></h2>
${stage}
<div class="scroll"><table>
<thead><tr><th>time</th><th>speaker</th><th>lines</th>${character ? '<th>face · motion</th><th>looks · reactions</th>' : ''}<th>gap before</th></tr></thead>
<tbody>
${rows(s.rows)}
</tbody></table></div>
</section>`;
    })
    .join('\n');

  const emotions = Object.entries(plan.emotions)
    .map(
      ([cast, counts]) =>
        `<li>${who(cast)} ${Object.entries(counts)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([emo, n]) => `${esc(emo)} ${n}`)
          .join(', ')}</li>`,
    )
    .join('');
  const noteText = plan.notes.map(
    (n) => `${n.line !== undefined ? `line ${n.line}: ` : ''}${n.message}`,
  );
  const notes = plan.notes.length
    ? `<ol class="notes">${plan.notes
        .map(
          (n) =>
            `<li>${badge(n.code, 'rule')} ${n.rowId ? `<a href="#${anchor(n.rowId)}">${esc(n.message)}</a>` : esc(n.message)}</li>`,
        )
        .join('')}</ol><button type="button" id="copy">Copy notes</button>`
    : '<p>No notes.</p>';
  const diags = opts.diagnostics.length
    ? `<ul class="diag">${opts.diagnostics
        .map((d) => {
          const text = esc(formatDiagnostic(d, opts.scriptName));
          const row = rowOf(d.line);
          return `<li>${row ? `<a href="#${anchor(row)}">${text}</a>` : text}</li>`;
        })
        .join('')}</ul>`
    : '';
  const r = plan.rhythm;
  const summary = [
    `output <b>${esc(plan.output)}</b> (${esc(plan.layout)} layout, ${plan.mode === 'character' ? 'characters' : plan.mode === 'avatar' ? 'avatars' : 'no characters'})`,
    `length ${time(plan.seconds, plan.measured < plan.total)} — ${plan.measured}/${plan.total} lines synthesized, the rest estimated${plan.measured < plan.total ? ' (draft audio is not used)' : ''}`,
    `rhythm ${r.on ? `on (answer ×${r.values.answer}, emotion ×${r.values.emotion}, linger ×${r.values.linger}, jitter ±${r.values.jitter})` : 'off'}`,
    `idle motion ${plan.idle ? "on: listeners nod by themselves at the end of others' lines (the renderer places the nods)" : 'off'}`,
  ];

  return `<!doctype html>
<html lang="${esc(plan.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`Direction — ${opts.scriptName} (${plan.output})`)}</title>
<style>
:root { --bg:#ffffff; --fg:#1f2328; --muted:#656d76; --line:#d0d7de; --chip:#eef1f4; --emo:#dbeafe; --emo-fg:#1e40af; --warn:#fde68a; --warn-fg:#78350f; --rule:#ede9fe; --rule-fg:#5b21b6; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#8d96a0; --line:#30363d; --chip:#21262d; --emo:#1e3a8a; --emo-fg:#dbeafe; --warn:#713f12; --warn-fg:#fde68a; --rule:#3b0764; --rule-fg:#ede9fe; } }
* { box-sizing: border-box; }
body { margin:0; padding:24px 16px 64px; background:var(--bg); color:var(--fg); font:14px/1.5 system-ui, sans-serif; }
main { max-width: 1280px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 8px; }
h2 { font-size: 16px; margin: 32px 0 8px; }
h2 code { color: var(--muted); font-weight: normal; }
.summary li, .emotions li { margin: 2px 0; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 760px; }
th, td { border-top: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 12px; }
td.time, td.gap { white-space: nowrap; font-variant-numeric: tabular-nums; }
.line { color: var(--muted); font-size: 12px; }
.est { font-style: italic; color: var(--muted); }
.s { min-height: 1.5em; }
.s + .s { margin-top: 4px; }
.who { white-space: nowrap; }
.who i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
.b { display: inline-block; padding: 0 6px; margin: 0 4px 0 0; border-radius: 9px; background: var(--chip); font-size: 12px; }
.b.emo { background: var(--emo); color: var(--emo-fg); }
.b.off { opacity: .6; }
.b.warn { background: var(--warn); color: var(--warn-fg); }
.b.rule { background: var(--rule); color: var(--rule-fg); margin-left: 4px; }
.b.change { font-family: ui-monospace, monospace; }
.stage { color: var(--muted); margin: 0 0 8px; }
.notes li { margin: 4px 0; }
.notes a { color: inherit; }
.diag { color: var(--muted); font-family: ui-monospace, monospace; font-size: 12px; }
button { font: inherit; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--chip); color: var(--fg); cursor: pointer; }
tr:target td { background: var(--warn); color: var(--warn-fg); }
</style>
</head>
<body>
<main>
<h1>${esc(opts.scriptName)} — direction</h1>
<ul class="summary">${summary.map((s) => `<li>${s}</li>`).join('')}</ul>
${opts.notes.length ? `<ul class="diag">${opts.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
<h2>Emotions</h2>
<ul class="emotions">${emotions}</ul>
<h2>Director notes</h2>
${notes}
${diags ? `<h2>Lint</h2>\n${diags}` : ''}
${scenes}
</main>
<script>
const NOTES = ${scriptJson(noteText)};
const copy = document.getElementById('copy');
if (copy) copy.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(NOTES.join('\\n')); copy.textContent = 'Copied'; }
  catch { copy.textContent = 'Copy failed'; }
  setTimeout(() => { copy.textContent = 'Copy notes'; }, 1500);
});
</script>
</body>
</html>
`;
}

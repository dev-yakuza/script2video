/**
 * The review page (plan 4.4): items grouped by round, set and view, cutouts over a checkerboard
 * next to the raw image, checks (failed ones in red), a "failed only" filter, and checkboxes that
 * build the approve / redo command line to copy. Round 6 groups show a lip-sync preview video.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROUND_NAMES, type Item } from './items.js';
import { ensureGitignore, WORK, workName, type Check, type Graph, type Status } from './state.js';

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface ReviewEntry {
  id: string;
  title: string;
  status: Status;
  checks?: Record<string, Check> | undefined;
  /** File names inside .work/. */
  raw: string;
  cut: string;
  video?: string | undefined;
  prompt: string;
  seed?: number | undefined;
}

/** A JSON value safe inside <script> (no closing tag). */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
/** A path as one shell word in the copied command line. */
const shellQuote = (s: string) => (/^[\w./:@-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

const cutName = (id: string) => workName(id).replace(/\.png$/, '.cut.png');
export const previewName = (group: string) => workName(group).replace(/\.png$/, '.mp4');

export function entryOf(dir: string, g: Graph, item: Item, st: Status): ReviewEntry {
  const rec = g.prov.items[item.id];
  const video = previewName(item.group);
  return {
    id: item.id,
    title: item.id,
    status: st,
    checks: rec?.checks,
    raw: workName(item.id),
    cut: cutName(item.id),
    video: item.kind === 'frame' && existsSync(join(dir, WORK, video)) ? video : undefined,
    prompt: rec?.prompt ?? item.prompt,
    seed: rec?.seed,
  };
}

export function candidateEntries(g: Graph): ReviewEntry[] {
  return Object.entries(g.prov.candidates).map(([n, c]) => ({
    id: n,
    title: `candidate ${n}`,
    status: 'generated',
    checks: c.checks,
    raw: join('candidates', `${n}.png`),
    cut: join('candidates', `${n}.cut.png`),
    prompt: c.prompt,
    seed: c.seed,
  }));
}

function card(e: ReviewEntry): string {
  const failed = e.checks && Object.values(e.checks).some((c) => !c.ok);
  const rows = Object.entries(e.checks ?? {})
    .map(
      ([k, c]) =>
        `<tr class="${c.ok ? '' : 'bad'}"><td>${esc(k)}</td><td>${c.value}</td><td>${esc(c.limit)}</td></tr>`,
    )
    .join('');
  const media = e.video
    ? `<video src="${esc(e.video)}" autoplay loop muted playsinline></video>`
    : `<img class="cut" src="${esc(e.cut)}" loading="lazy"><img class="raw" src="${esc(e.raw)}" loading="lazy">`;
  return `<figure class="card ${failed ? 'failed' : ''}" data-id="${esc(e.id)}">
<label>${e.status === 'approved' ? '' : `<input type="checkbox" value="${esc(e.id)}">`} <b>${esc(e.title)}</b> <span class="st ${esc(e.status)}">${esc(e.status)}</span></label>
<div class="media">${media}</div>
<table>${rows}</table>
<details><summary>prompt${e.seed !== undefined ? ` · seed ${e.seed}` : ''}</summary><p>${esc(e.prompt)}</p></details>
</figure>`;
}

export function writeReview(
  dir: string,
  sections: { title: string; entries: ReviewEntry[] }[],
  opts: { candidates?: boolean },
): string {
  const rel = relative(process.cwd(), dir) || '.';
  const body = sections
    .filter((s) => s.entries.length > 0)
    .map((s) => `<h2>${esc(s.title)}</h2><div class="grid">${s.entries.map(card).join('')}</div>`)
    .join('');
  const page = `<!doctype html><meta charset="utf-8"><title>character review</title><style>
body{font-family:system-ui,sans-serif;margin:24px;color:#222;background:#fafafa}
.grid{display:flex;flex-wrap:wrap;gap:12px}
.card{margin:0;width:330px;background:#fff;border:1px solid #ddd;border-radius:8px;padding:8px}
.card.failed{border-color:#d33}
.media{display:flex;gap:4px}
.media img{width:160px;height:200px;object-fit:contain}
.media video{width:320px}
.cut{background:repeating-conic-gradient(#ccc 0 25%,#fff 0 50%) 0 0/16px 16px}
table{font-size:12px;border-collapse:collapse;width:100%}td{padding:1px 4px}
tr.bad{color:#c00;font-weight:600}
.st{font-size:11px;padding:1px 6px;border-radius:8px;background:#eee}
.st.failed,.st.stale{background:#fdd}.st.approved{background:#dfd}
details{font-size:12px}
#bar{position:sticky;top:0;background:#fafafa;padding:8px 0;border-bottom:1px solid #ddd}
code{display:block;background:#222;color:#eee;padding:8px;border-radius:6px;white-space:pre-wrap}
</style>
<div id="bar">
<label><input type="checkbox" id="onlyFailed"> failed checks only</label>
<button id="all">select all</button>
<code id="cmd">select items</code>
<button id="copy">copy</button>
</div>
${body}
<script>
const dir = ${scriptJson(shellQuote(rel))};
const candidates = ${JSON.stringify(Boolean(opts.candidates))};
const boxes = [...document.querySelectorAll('.card input')];
const cmd = document.getElementById('cmd');
function update() {
  const ids = boxes.filter((b) => b.checked).map((b) => b.value);
  if (candidates) cmd.textContent = ids.length === 1 ? 's2v character pick ' + dir + ' ' + ids[0] : 'select one candidate';
  else cmd.textContent = ids.length ? 's2v character approve ' + dir + ' ' + ids.join(' ') + '\\n# or: s2v character redo ' + dir + ' ' + ids.join(' ') : 'select items';
}
boxes.forEach((b) => b.addEventListener('change', update));
document.getElementById('all').onclick = () => { boxes.forEach((b) => { if (b.closest('.card').style.display !== 'none') b.checked = true; }); update(); };
document.getElementById('onlyFailed').onchange = (e) => {
  for (const c of document.querySelectorAll('.card')) c.style.display = e.target.checked && !c.classList.contains('failed') ? 'none' : '';
};
document.getElementById('copy').onclick = () => navigator.clipboard.writeText(cmd.textContent);
</script>`;
  // a fresh clone has no .work yet (S9b plan M3)
  mkdirSync(join(dir, WORK), { recursive: true });
  ensureGitignore(dir);
  const file = join(dir, WORK, 'review.html');
  writeFileSync(file, page);
  return file;
}

export function sectionsOf(dir: string, g: Graph, items: Item[], st: (id: string) => Status) {
  const by = new Map<string, ReviewEntry[]>();
  for (const it of items) {
    const key = `Round ${it.round}: ${ROUND_NAMES[it.round]} — ${it.set} / ${it.view}`;
    (by.get(key) ?? by.set(key, []).get(key)!).push(entryOf(dir, g, it, st(it.id)));
  }
  return [...by.entries()].map(([title, entries]) => ({ title, entries }));
}

/**
 * `s2v pick <image>`: open the image in a local page and copy `:cue` attributes by clicking
 * (circle mark) or dragging (box mark). A coordinate reader, not an editor (PLAN 5.6).
 */

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { openPage } from './html.js';

const PAGE = (imageFile: string, title: string) => `<!doctype html>
<meta charset="utf-8">
<title>s2v pick — ${title}</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #111827; color: #e5e7eb; }
  header { position: sticky; top: 0; z-index: 2; display: flex; gap: 12px; align-items: center;
           padding: 10px 16px; background: #1f2937; flex-wrap: wrap; }
  code { background: #0f172a; padding: 6px 10px; border-radius: 6px; font-size: 15px; user-select: all; }
  button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 0; background: #3b82f6; color: #fff; cursor: pointer; }
  .hint { color: #9ca3af; font-size: 13px; }
  .wrap { position: relative; display: inline-block; margin: 16px; cursor: crosshair; }
  img { display: block; max-width: calc(100vw - 32px); height: auto; user-select: none; }
  .mark { position: absolute; border: 3px solid #ef4444; box-sizing: border-box; pointer-events: none; }
</style>
<header>
  <code id="out">클릭: 원 / 드래그: 박스</code>
  <button id="copy">복사</button>
  <span class="hint">좌표는 이미지 기준 0–1. zoom은 표시가 화면 폭의 약 40%가 되도록 제안합니다.</span>
</header>
<div class="wrap" id="wrap"><img id="img" src="${imageFile}" draggable="false"><div class="mark" id="mark" hidden></div></div>
<script>
  const img = document.getElementById('img'), mark = document.getElementById('mark'), out = document.getElementById('out');
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const zoomFor = (frac) => Math.max(1, Math.min(4, Math.round((0.4 / frac) * 10) / 10));
  let start = null;
  const rel = (e) => { const b = img.getBoundingClientRect(); return [(e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height]; };
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  img.addEventListener('mousedown', (e) => { start = rel(e).map(clamp01); });
  window.addEventListener('mouseup', (e) => {
    if (!start) return;
    const end = rel(e).map(clamp01);
    const [x0, y0] = start; const [x1, y1] = end; start = null;
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    const b = img.getBoundingClientRect();
    let attrs;
    if (w * b.width < 6 && h * b.height < 6) {
      const r = 0.035;
      attrs = 'x=' + r3(x0) + ' y=' + r3(y0) + ' zoom=' + zoomFor(r * 2) + ' mark=circle r=' + r;
      Object.assign(mark.style, { left: (x0 - r) * 100 + '%', top: 'calc(' + y0 * 100 + '% - ' + r * b.width + 'px)',
        width: r * 200 + '%', height: r * 2 * b.width + 'px', borderRadius: '50%' });
    } else {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      attrs = 'x=' + r3(cx) + ' y=' + r3(cy) + ' zoom=' + zoomFor(w) + ' mark=box w=' + r3(w) + ' h=' + r3(h);
      Object.assign(mark.style, { left: Math.min(x0, x1) * 100 + '%', top: Math.min(y0, y1) * 100 + '%',
        width: w * 100 + '%', height: h * 100 + '%', borderRadius: '8px' });
    }
    mark.hidden = false;
    out.textContent = '{' + attrs + '}';
    copy();
  });
  async function copy() {
    const text = out.textContent;
    try { await navigator.clipboard.writeText(text); }
    catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
  }
  document.getElementById('copy').addEventListener('click', copy);
</script>
`;

export function pick(imagePath: string, workRoot: string): string {
  const abs = resolve(imagePath);
  const dir = join(workRoot, '.s2v-cache', 'pick');
  mkdirSync(dir, { recursive: true });
  const imageFile = `image${extname(abs)}`;
  copyFileSync(abs, join(dir, imageFile));
  const page = join(dir, 'index.html');
  writeFileSync(page, PAGE(imageFile, basename(abs)));
  openPage(page);
  return page;
}

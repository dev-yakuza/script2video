import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCharacterSpec, type LayeredSpec } from '@script2video/renderer-remotion';
import { describe, expect, it } from 'vitest';
import { FRONT_REF, planItems, twinsOf, twinWrites } from '../src/character-gen/items.js';
import { flipPrompt } from '../src/character-gen/prompts.js';
import {
  currentDef,
  invalidate,
  pending,
  seedOf,
  status,
  type Graph,
  type ItemRecord,
} from '../src/character-gen/state.js';
import { writeDerived } from '../src/character-gen/yaml-write.js';

const spec = (yaml: string) => parseCharacterSpec(yaml) as LayeredSpec;
const count = (items: { round: number }[]) =>
  items.reduce<Record<number, number>>((a, i) => ({ ...a, [i.round]: (a[i.round] ?? 0) + 1 }), {});

describe('generation items', () => {
  it('standard@1 (mirror: true): rounds and counts', () => {
    const { items, errors } = planItems(
      '/c',
      spec('source: generated\nkind: a girl\npreset: standard@1\n'),
    );
    expect(errors).toEqual([]);
    const ids = new Set(items.map((i) => i.id));
    // Round 2: the turn view and the head close-up; round 3: only the split front view.
    expect(
      items
        .filter((i) => i.round === 2)
        .map((i) => i.id)
        .sort(),
    ).toEqual(['head:front/ref', 'turn/ref']);
    expect(items.filter((i) => i.round === 3).map((i) => i.id)).toEqual(['front/headless']);
    expect(ids.has('turn/base/happy')).toBe(true);
    expect(ids.has('turn/base/happy/open')).toBe(true);
    expect(ids.has('front/glance/neutral')).toBe(true);
    expect(ids.has('front/body/point')).toBe(true);
    expect(ids.has('head:front/base/moved/blink')).toBe(true);
    // 12 front + 12 turn + 4 glance + 6 head groups, 3 frames each.
    expect(items.filter((i) => i.kind === 'frame')).toHaveLength((12 + 12 + 4 + 6) * 3);
    expect(count(items)).toMatchObject({ 2: 2, 3: 1, 4: 7 });
  });

  it('frames edit the approved still with its template minus the pose prefix (P5)', () => {
    const { items } = planItems('/c', spec('source: generated\npreset: standard@1\n'));
    const still = items.find((i) => i.id === 'turn/base/happy')!;
    const open = items.find((i) => i.id === 'turn/base/happy/open')!;
    expect(open.group).toBe(still.id);
    expect(open.input).toBe(still.id);
    expect(open.needs).toEqual([still.id]);
    const [a, b] = [still.prompt.split(', mouth')[0], open.prompt.split(', mouth')[0]];
    expect(a).toMatch(/viewer's right/);
    expect(b).not.toMatch(/viewer's/);
    expect(a.endsWith(b)).toBe(true);
    // The neutral group's still is the view reference.
    expect(items.find((i) => i.id === 'turn/base/neutral/half')!.input).toBe('turn/ref');
  });

  it('mirror: false adds @flip twins with the opposite direction', () => {
    const s = spec('source: generated\npreset: standard@1\nmirror: false\n');
    const t = twinsOf(s);
    expect(t.views['turn@flip']).toMatchObject({ facing: 'left', preset: 'turn-slight' });
    expect(t.heads['front/glance@flip']).toMatchObject({ facing: 'left' });
    expect(t.bodies['front/point@flip']?.prompt).toMatch(/viewer's left/);
    const { items, errors } = planItems('/c', s);
    expect(errors).toEqual([]);
    const flip = items.find((i) => i.id === 'turn@flip/base/happy')!;
    expect(flip.prompt).toMatch(/viewer's left/);
    expect(items.some((i) => i.id === 'front/glance@flip/neutral/open')).toBe(true);
    expect(items.some((i) => i.id === 'front/body/point@flip')).toBe(true);
  });

  it('mirror: false close-up sets get their own @flip twins', () => {
    const s = spec(
      'source: generated\npreset: standard@1\nmirror: false\nsets:\n  upper:\n    heads: { front/glance: { preset: glance, facing: right } }\n    bodies: { front/point: { prompt: "points toward the viewer\'s right", facing: right } }\n    faces: [glance-happy, point, happy]\n',
    );
    const { items, errors } = planItems('/c', s);
    expect(errors).toEqual([]);
    expect(items.some((i) => i.id === 'upper:front/glance@flip/happy')).toBe(true);
    expect(items.some((i) => i.id === 'upper:front/body/point@flip')).toBe(true);
    expect(twinWrites(s).map((w) => w.path.join('.'))).toContain(
      'sets.upper.heads.front/glance@flip',
    );
  });

  it('flipPrompt swaps screen sides only', () => {
    expect(flipPrompt("toward the viewer's right, then the viewer's left")).toBe(
      "toward the viewer's left, then the viewer's right",
    );
  });
});

const SMALL = `source: generated
kind: a girl
views:
  turn: { preset: turn-slight, facing: right }
expressions:
  neutral: {}
  happy: { prompt: smiling }
faces:
  neutral: { view: turn, expression: neutral }
  happy: { view: front, expression: happy }
`;

function graph(yaml = SMALL): Graph {
  const { items } = planItems('/c', spec(yaml));
  return {
    items: new Map(items.map((i) => [i.id, i])),
    prov: { version: 1, items: {}, candidates: {}, derived: {} },
    size: [640, 800],
  };
}
const approve = (g: Graph, id: string, sha = `sha-${id}`) => {
  invalidate(g);
  const it = g.items.get(id);
  const def = it ? currentDef(g, it)! : 'picked';
  g.prov.items[id] = {
    def,
    state: 'approved',
    seed: 7,
    prompt: '',
    sha,
    approvedSha: sha,
  } as ItemRecord;
  invalidate(g);
};

describe('generation state', () => {
  it('rounds unlock as inputs are approved; a changed input makes items stale (C16)', () => {
    const g = graph();
    expect(status(g, 'turn/ref')).toBe('blocked');
    approve(g, FRONT_REF);
    expect(
      pending(g)
        .map((i) => i.id)
        .sort(),
    ).toEqual(['front/base/happy', 'front/headless', 'turn/ref']);
    approve(g, 'turn/ref');
    approve(g, 'front/base/happy');
    expect(status(g, 'turn/base/neutral/open')).toBe('missing');
    // A new front reference: everything made from it is stale.
    approve(g, FRONT_REF, 'other');
    expect(status(g, 'turn/ref')).toBe('stale');
    expect(status(g, 'turn/base/neutral/open')).toBe('blocked');
  });

  it('a redo seed belongs to the group: the still and all its frames change', () => {
    const g = graph();
    approve(g, FRONT_REF);
    approve(g, 'front/base/happy');
    for (const f of ['half', 'open', 'blink']) approve(g, `front/base/happy/${f}`);
    const rec = g.prov.items['front/base/happy']!;
    rec.seed = 8;
    rec.seedFixed = true;
    invalidate(g);
    expect(status(g, 'front/base/happy')).toBe('stale');
    expect(status(g, 'front/base/happy/open')).toBe('blocked');
  });

  it('a frames-only redo seed changes the frames and keeps the approved still', () => {
    const g = graph();
    approve(g, FRONT_REF);
    approve(g, 'turn/ref');
    for (const f of ['half', 'open', 'blink']) approve(g, `turn/base/neutral/${f}`);
    g.prov.items['turn/ref']!.frameSeed = 8;
    invalidate(g);
    expect(status(g, 'turn/ref')).toBe('approved');
    expect(status(g, 'turn/base/neutral/open')).toBe('stale');
    expect(seedOf(g, g.items.get('turn/base/neutral/open')!)).toBe(8);
    expect(seedOf(g, g.items.get('turn/ref')!)).toBe(7);
  });
});

describe('derived yaml fields', () => {
  it('keeps comments, writes flow values and keeps hand edits (C16)', () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-derived-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'character.yaml'),
      '# mine\nsource: generated\nviews:\n  front: {} # the front\n',
    );
    const last: Record<string, unknown> = {};
    const w = writeDerived(dir, [{ path: ['views', 'front', 'pivot'], value: [10, 20] }], last);
    expect(w.written).toEqual(['views › front › pivot']);
    let text = readFileSync(join(dir, 'character.yaml'), 'utf8');
    expect(text).toContain('# mine');
    expect(text).toContain('# the front');
    expect(text).toMatch(/pivot: \[ ?10, 20 ?\]/);
    // A person changes it: a new estimate does not overwrite, unless reset.
    writeFileSync(join(dir, 'character.yaml'), text.replace(/pivot: .*\]/, 'pivot: [11, 20]'));
    const k = writeDerived(dir, [{ path: ['views', 'front', 'pivot'], value: [12, 21] }], last);
    expect(k.kept).toHaveLength(1);
    expect(readFileSync(join(dir, 'character.yaml'), 'utf8')).toMatch(/\[ ?11, 20 ?\]/);
    writeDerived(dir, [{ path: ['views', 'front', 'pivot'], value: [12, 21] }], last, {
      reset: true,
    });
    text = readFileSync(join(dir, 'character.yaml'), 'utf8');
    expect(text).toMatch(/\[ ?12, 21 ?\]/);
  });
});

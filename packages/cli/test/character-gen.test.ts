import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCharacterSpec, type LayeredSpec } from '@script2video/renderer-remotion';
import { describe, expect, it } from 'vitest';
import { FRONT_REF, planItems, twinsOf, twinWrites } from '../src/character-gen/items.js';
import { frameContext } from '../src/character-gen/commands.js';
import { flipPrompt } from '../src/character-gen/prompts.js';
import {
  currentDef,
  invalidate,
  pending,
  seedOf,
  status,
  type Graph,
  type ItemRecord,
  workPath,
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
    // The head close-up draws every face: front ones frontal, turned ones and glances with the
    // turned head (one picture), poses with their expression (closeup-look plan).
    const glance = items.find((i) => i.id === 'head:front/glance/neutral')!;
    expect(glance).toMatchObject({ round: 4, input: 'head:front/ref' });
    expect(glance.prompt).toMatch(/turns the head about 30 degrees toward the viewer's right/);
    expect(ids.has('head:front/glance/playful/open')).toBe(true);
    expect([...ids].filter((i) => i.startsWith('head:') && i.includes('/body/'))).toEqual([]);
    // 12 front + 12 turn + 4 glance + 24 head groups, 3 frames each.
    expect(items.filter((i) => i.kind === 'frame')).toHaveLength((12 + 12 + 4 + 24) * 3);
    expect(count(items)).toMatchObject({ 2: 2, 3: 1, 4: 8 });
  });

  it('frames edit the approved still and name only their change (P5)', () => {
    const { items } = planItems('/c', spec('source: generated\npreset: standard@1\n'));
    const still = items.find((i) => i.id === 'turn/base/happy')!;
    const open = items.find((i) => i.id === 'turn/base/happy/open')!;
    expect(open.group).toBe(still.id);
    expect(open.input).toBe(still.id);
    expect(open.needs).toEqual([still.id]);
    expect(still.prompt).toMatch(/viewer's right/);
    expect(still.prompt).toMatch(/look happy/);
    // Neither the pose nor the expression: "eyes wide open …, eyes gently closed" left surprised
    // eyes open (test sora r6).
    expect(open.prompt).not.toMatch(/viewer's|smiling eyes/);
    expect(open.prompt).toMatch(
      /^Open the character's mouth wide, as if speaking, keeping the same happy expression/,
    );
    const blink = items.find((i) => i.id === 'front/base/surprised/blink')!;
    expect(blink.prompt).not.toMatch(/surprised|wide open/i);
    expect(blink.prompt).toMatch(/^Close both of the character's eyes/);
    // A mouth frame names its expression only; a blink has the same words in every group.
    expect(items.find((i) => i.id === 'turn/base/surprised/open')!.prompt).toBe(
      open.prompt.replace('same happy', 'same surprised'),
    );
    expect(items.find((i) => i.id === 'turn/base/happy/blink')!.prompt).toBe(blink.prompt);
    // Stills keep their words (and so their approvals).
    expect(still.prompt).toBe(
      "The character turns the head and body about 45 degrees toward the viewer's right side of the image, a three-quarter view, as if talking to someone standing there. Both eyes stay visible; the far side of the face looks a little narrower. Make the character look happy: Happy expression with smiling eyes, mouth closed. Keep exactly the same character design, colors, outfit, line art and plain light gray background. No shadow.",
    );
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
    // The head close-up's turned faces need the twin of its glance head (closeup-look plan).
    expect(items.some((i) => i.id === 'head:front/glance@flip/happy/open')).toBe(true);
    expect(twinWrites(s).map((w) => w.path.join('.'))).toContain(
      'sets.head.heads.front/glance@flip',
    );
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

  it('gaze frames keep screen directions on @flip twins (the still carries the turn)', () => {
    const s = spec(
      'source: generated\npreset: standard@1\nmirror: false\nexpressions:\n  happy: { gaze: toward }\n',
    );
    const { items } = planItems('/c', s);
    const id = 'front/glance/happy/gaze-screen-left';
    const twin = items.find((i) => i.id === 'front/glance@flip/happy/gaze-screen-left');
    expect(twin?.prompt).toMatch(/viewer's left/);
    expect(twin?.prompt).toBe(items.find((i) => i.id === id)!.prompt);
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

describe("post: the blinks that place a frame's eyes", () => {
  it("borrows this round's blinks of the view, with their keys (a round remaking every frame)", () => {
    const g = graph('source: generated\nkind: a girl\npreset: standard@1\n');
    const half = g.items.get('front/base/happy/half')!;
    const blink = g.items.get('front/base/neutral/blink')!;
    const glance = g.items.get('front/glance/happy/blink')!;
    const dir = mkdtempSync(join(tmpdir(), 's2v-ctx-'));
    try {
      const round = [half, glance, blink];
      // Not made yet: nothing to borrow.
      expect(frameContext(dir, g, half, round).eyes).toEqual([]);
      mkdirSync(join(dir, '.work'), { recursive: true });
      writeFileSync(workPath(dir, blink.id), '');
      writeFileSync(workPath(dir, glance.id), '');
      // The same head first (as derive's eye_order), another head after it.
      expect(frameContext(dir, g, half, round).eyes).toEqual([
        expect.objectContaining({
          blink: workPath(dir, blink.id),
          key: 'base/neutral',
          same_head: true,
        }),
        expect.objectContaining({
          blink: workPath(dir, glance.id),
          key: 'glance/happy',
          same_head: false,
        }),
      ]);
      // Neither in this round nor approved: not borrowed.
      expect(frameContext(dir, g, half, [half]).eyes).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

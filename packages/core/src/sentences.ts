import type { Acting, Inline, Lang, Sentence } from './schema.js';

// Sentence-final punctuation. For ko/en a boundary also needs whitespace (or the end) after it,
// so that "2.5.1" or "tsconfig.json" do not split. Japanese full-width marks split immediately.
const SPACE_DELIMITED_END = /[.?!](?=["'”’)\]]*(\s|$))["'”’)\]]*/g;
const JA_END = /[。！？!?](?=["'」』”’)\]]*)["'」』”’)\]]*/g;

function boundaries(text: string, lang: Lang): number[] {
  const re =
    lang === 'ja'
      ? new RegExp(`${JA_END.source}|${SPACE_DELIMITED_END.source}`, 'g')
      : SPACE_DELIMITED_END;
  re.lastIndex = 0;
  const cuts: number[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    cuts.push(m.index + m[0].length);
    if (m[0].length === 0) re.lastIndex++;
  }
  return cuts;
}

/**
 * Split a paragraph's inline stream into sentences.
 * - Text is split at sentence-final punctuation.
 * - A cue never splits; its phrase stays inside the current sentence.
 * - `:pause` ends the current sentence and records the pause after it.
 * - `:react{cast=face}` is recorded at its position (it adds no text).
 * - `:emo{…}` changes the voice attributes from the next sentence on (`acting`: the paragraph's).
 *   It must stand between sentences; elsewhere an issue is reported.
 * Whitespace (including soft line breaks) is collapsed to a single space.
 */
export interface SentenceIssue {
  line?: number;
  message: string;
  level: 'error' | 'warning' | 'info';
  code?: string;
}

export function splitSentences(
  inlines: Inline[],
  lang: Lang,
  acting?: Acting,
  issues?: SentenceIssue[],
): Sentence[] {
  const out: Sentence[] = [];
  let current = acting;
  let changed = false;
  let pendingLine: number | undefined;
  let cur: Sentence & {
    reacts: NonNullable<Sentence['reacts']>;
    looks: NonNullable<Sentence['looks']>;
  } = {
    text: '',
    cues: [],
    reacts: [],
    looks: [],
  };

  const flush = (pauseAfter?: number) => {
    const trimmed = cur.text.trimEnd();
    const lead = cur.text.length - cur.text.trimStart().length;
    if (trimmed.trim().length > 0) {
      const text = trimmed.trimStart();
      out.push({
        text,
        ...(current ? { acting: current } : {}),
        ...(changed ? { actingChange: true as const } : {}),
        cues: cur.cues.map((c) => ({ ...c, start: c.start - lead, end: c.end - lead })),
        ...(pauseAfter !== undefined ? { pauseAfter } : {}),
        ...(cur.reacts.length > 0
          ? {
              reacts: cur.reacts.map((r) => ({
                ...r,
                at: Math.min(text.length, Math.max(0, r.at - lead)),
              })),
            }
          : {}),
        ...(cur.looks.length > 0
          ? {
              looks: cur.looks.map((l) => ({
                ...l,
                at: Math.min(text.length, Math.max(0, l.at - lead)),
              })),
            }
          : {}),
      });
      changed = false;
      pendingLine = undefined;
      cur = { text: '', cues: [], reacts: [], looks: [] };
      return;
    } else if (pauseAfter !== undefined && out.length > 0) {
      const last = out[out.length - 1]!;
      last.pauseAfter = (last.pauseAfter ?? 0) + pauseAfter;
    }
    // no text yet: looks wait for the next sentence (they lead it)
    cur = { text: '', cues: [], reacts: [], looks: cur.looks.map((l) => ({ ...l, at: 0 })) };
  };

  const append = (s: string) => {
    const collapsed = s.replace(/\s+/g, ' ');
    if (cur.text.length === 0) cur.text = collapsed.trimStart();
    else cur.text += collapsed;
  };

  for (const node of inlines) {
    if (node.type === 'emo') {
      if (cur.text.trim().length > 0) {
        issues?.push({
          level: 'error',
          line: node.line,
          message: `:emo must stand between sentences (after . ? ! or at the start of the paragraph)${cur.cues.length > 0 ? '; a period inside :cue[…] does not end a sentence' : ''}`,
        });
        continue;
      }
      if (out.length === 0)
        issues?.push({
          level: 'info',
          line: node.line,
          message:
            ':emo at the start of a paragraph: write it in the speaker prefix instead (mina{emo=…}:)',
        });
      current = Object.keys(node.acting).length > 0 ? node.acting : undefined;
      changed = true;
      pendingLine = node.line;
      continue;
    }
    if (node.type === 'pause') {
      flush(node.seconds);
      continue;
    }
    if (node.type === 'react') {
      cur.reacts.push({
        at: cur.text.length,
        faces: node.faces,
        ...(node.motions ? { motions: node.motions } : {}),
      });
      continue;
    }
    if (node.type === 'look') {
      cur.looks.push({
        at: cur.text.length,
        looks: node.looks,
        ...(node.line !== undefined ? { line: node.line } : {}),
      });
      continue;
    }
    if (node.type === 'cue') {
      append(''); // keep position semantics consistent
      const start = cur.text.length;
      append(node.text);
      cur.cues.push({ start, end: cur.text.length, attrs: node.attrs });
      continue;
    }
    let rest = node.value.replace(/\s+/g, ' ');
    while (rest.length > 0) {
      const cuts = boundaries(rest, lang);
      const cut = cuts[0];
      if (cut === undefined) {
        append(rest);
        break;
      }
      append(rest.slice(0, cut));
      flush();
      rest = rest.slice(cut);
    }
  }
  flush();
  // a look after the last word (before the final punctuation) has nothing to start from either
  const last = out[out.length - 1];
  if (last?.looks) {
    const after = last.looks.filter(
      (l) => l.at >= last.text.replace(/[\s.!?。！？…"'」』）)]+$/u, '').length && l.at > 0,
    );
    if (after.length > 0) {
      cur.looks.push(...after);
      last.looks = last.looks.filter((l) => !after.includes(l));
      if (last.looks.length === 0) delete last.looks;
    }
  }
  for (const l of cur.looks)
    issues?.push({
      level: 'warning',
      code: 'look-dropped',
      line: l.line,
      message: ':look at the end of a paragraph has no word to start from (dropped)',
    });
  if (changed)
    issues?.push({
      level: 'error',
      line: pendingLine,
      message: ':emo at the end of a paragraph has no sentence to apply to',
    });
  return out;
}

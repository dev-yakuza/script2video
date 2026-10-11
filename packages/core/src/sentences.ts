import type { Inline, Lang, Sentence } from './schema.js';

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
 * Whitespace (including soft line breaks) is collapsed to a single space.
 */
export function splitSentences(inlines: Inline[], lang: Lang): Sentence[] {
  const out: Sentence[] = [];
  let cur: Sentence & { reacts: NonNullable<Sentence['reacts']> } = {
    text: '',
    cues: [],
    reacts: [],
  };

  const flush = (pauseAfter?: number) => {
    const trimmed = cur.text.trimEnd();
    const lead = cur.text.length - cur.text.trimStart().length;
    if (trimmed.trim().length > 0) {
      const text = trimmed.trimStart();
      out.push({
        text,
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
      });
    } else if (pauseAfter !== undefined && out.length > 0) {
      const last = out[out.length - 1]!;
      last.pauseAfter = (last.pauseAfter ?? 0) + pauseAfter;
    }
    cur = { text: '', cues: [], reacts: [] };
  };

  const append = (s: string) => {
    const collapsed = s.replace(/\s+/g, ' ');
    if (cur.text.length === 0) cur.text = collapsed.trimStart();
    else cur.text += collapsed;
  };

  for (const node of inlines) {
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
  return out;
}

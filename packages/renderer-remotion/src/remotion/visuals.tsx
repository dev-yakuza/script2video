import type { SubtitleMetrics, Side } from '../shared';
import type { TimelineCue, TimelineSubtitle } from '@script2video/core';
import { createContext, useContext, useEffect, useState } from 'react';
import type React from 'react';
import {
  AbsoluteFill,
  continueRender,
  delayRender,
  Easing,
  Img,
  interpolate,
  interpolateColors,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { useVisualArea } from './area';
import { alpha, useTheme } from './theme';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/**
 * Keep hyphenated words whole (`overflow-wrap`, `break-word`): browsers may break a line right
 * after a hyphen, which splits code-like terms in titles.
 */
function keepHyphenated(text: string): React.ReactNode {
  return text.split(/(\S*-\S*)/).map((part, i) =>
    /-/.test(part) ? (
      <span key={i} style={{ whiteSpace: 'nowrap' }}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

export const TitleVisual: React.FC<{ label: string; fontFamily: string }> = ({
  label,
  fontFamily,
}) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const { width, portrait } = useVisualArea();
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: 80 }}>
      <div
        style={{
          fontFamily,
          fontSize: Math.min(portrait ? 96 : 120, Math.round(width / 11)),
          fontWeight: 800,
          color: theme.text,
          textAlign: 'center',
          wordBreak: 'keep-all',
          opacity: interpolate(frame, [0, 12], [0, 1], clamp),
        }}
      >
        {keepHyphenated(label)}
      </div>
    </AbsoluteFill>
  );
};

const HL_FRAMES = 8;

/** 0..1 highlight of item i: fades in at its cue, fades out when a later cue moves elsewhere. */
function highlightAmount(i: number, frame: number, cues: TimelineCue[]): number {
  let amount = 0;
  for (const cue of cues) {
    if (cue.frame > frame) break;
    const t = interpolate(frame, [cue.frame, cue.frame + HL_FRAMES], [0, 1], clamp);
    amount = Number(cue.attrs.highlight) === i ? Math.max(amount, t) : amount * (1 - t);
  }
  return amount;
}

export const BulletsVisual: React.FC<{
  items: string[];
  cues: TimelineCue[];
  fontFamily: string;
}> = ({ items, cues, fontFamily }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const { width, portrait, reserved } = useVisualArea();
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        paddingBottom: reserved ? 24 : portrait ? 300 : 160,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 28,
          width: Math.min(portrait ? 900 : 1200, width - 80),
        }}
      >
        {items.map((item, i) => {
          const a = highlightAmount(i, frame, cues);
          return (
            <div
              key={i}
              style={{
                fontFamily,
                fontSize: portrait ? 52 : 56,
                fontWeight: 600,
                padding: '28px 40px',
                borderRadius: 20,
                background: interpolateColors(a, [0, 1], [theme.panel, theme.accent]),
                color: interpolateColors(a, [0, 1], [theme.text, theme.onAccent]),
                boxShadow: `0 4px 16px ${theme.shadow}`,
                wordBreak: 'keep-all',
              }}
            >
              {item}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/** Subtitle colors and font (subtitleStyle); geometry lives in SubtitleMetrics. */
export type SubtitleLook = {
  color: string;
  /** Box color, or `none`: no box, outlined text. */
  background: string;
  highlight: string;
  /** Overrides the language font (a custom font file). */
  fontFamily?: string;
};

export const DEFAULT_LOOK: SubtitleLook = {
  color: '#ffffff',
  background: 'rgba(17, 24, 39, 0.78)',
  highlight: '#facc15',
};

export const SubtitleLookContext = createContext<SubtitleLook>(DEFAULT_LOOK);

/** Group text with the word being spoken highlighted; words not yet spoken are dimmed. */
function wordSpans(s: TimelineSubtitle, frame: number, look: SubtitleLook): React.ReactNode {
  if (s.words.length === 0) return s.text;
  const current = [...s.words].reverse().find((w) => w.frame <= frame);
  const parts: React.ReactNode[] = [];
  let pos = 0;
  s.words.forEach((w, i) => {
    if (w.end <= pos) return; // defensive: skip words overlapping what was already drawn
    if (w.start > pos) parts.push(s.text.slice(pos, w.start));
    const spoken = w.frame <= frame;
    parts.push(
      <span
        key={i}
        style={{
          color: w === current ? look.highlight : look.color,
          opacity: spoken ? 1 : 0.55,
        }}
      >
        {s.text.slice(Math.max(pos, w.start), w.end)}
      </span>,
    );
    pos = w.end;
  });
  if (pos < s.text.length) parts.push(s.text.slice(pos));
  return parts;
}

const TAIL = 18;

/** Speech-bubble tail pointing at the speaker's character. */
function Tail({ at, portrait, color }: { at: Side; portrait: boolean; color: string }) {
  const style: React.CSSProperties = { position: 'absolute', width: 0, height: 0 };
  if (portrait)
    // Below the box, near the speaker's side, pointing down.
    return (
      <div
        style={{
          ...style,
          top: '100%',
          [at]: 72,
          borderLeft: `${TAIL}px solid transparent`,
          borderRight: `${TAIL}px solid transparent`,
          borderTop: `${TAIL + 4}px solid ${color}`,
        }}
      />
    );
  // Beside the box, low, pointing sideways at the character.
  return (
    <div
      style={{
        ...style,
        bottom: 22,
        [at === 'left' ? 'right' : 'left']: '100%',
        borderTop: `${TAIL}px solid transparent`,
        borderBottom: `${TAIL}px solid transparent`,
        [at === 'left' ? 'borderRight' : 'borderLeft']: `${TAIL + 4}px solid ${color}`,
      }}
    />
  );
}

/**
 * One subtitle box. `clamp: false` lets the text overflow freely so `s2v check` can count the
 * lines it really needs (the rendered box clamps to `maxLines` and hides the rest).
 */
export const SubtitleBox: React.FC<{
  lang: string;
  fontFamily: string;
  metrics: SubtitleMetrics;
  /** Dialogue with avatars / name tags only: colored name tag above the box. */
  speaker?: { name: string; color: string };
  /** Character mode: tail toward the speaker's side. */
  tail?: Side;
  portrait?: boolean;
  clamp?: boolean;
  children: React.ReactNode;
}> = ({
  lang,
  fontFamily,
  metrics: m,
  speaker,
  tail,
  portrait = false,
  clamp = true,
  children,
}) => {
  const look = useContext(SubtitleLookContext);
  const boxless = look.background === 'none';
  const box = (
    <div
      lang={lang}
      style={{
        fontFamily: look.fontFamily ?? fontFamily,
        fontSize: m.fontSize,
        fontWeight: 600,
        lineHeight: m.lineHeight,
        color: look.color,
        textAlign: 'center',
        maxWidth: m.maxWidth,
        boxSizing: 'border-box',
        padding: `${m.paddingY}px ${m.paddingX}px`,
        background: boxless ? 'transparent' : look.background,
        borderRadius: 16,
        // Without a box the text needs an outline to stay readable on any picture.
        ...(boxless
          ? {
              WebkitTextStroke: `${Math.max(4, Math.round(m.fontSize * 0.14))}px rgba(0, 0, 0, 0.85)`,
              paintOrder: 'stroke fill',
            }
          : {}),
        ...(clamp
          ? {
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical' as const,
              WebkitLineClamp: m.maxLines,
              overflow: 'hidden',
            }
          : { display: 'block', width: 'fit-content' }),
        // ja: phrase-aware breaking (Chrome `auto-phrase`, needs lang="ja") + kinsoku
        ...(lang === 'ja'
          ? {
              lineBreak: 'strict' as const,
              wordBreak: 'auto-phrase' as React.CSSProperties['wordBreak'],
            }
          : { wordBreak: 'keep-all' as const, overflowWrap: 'anywhere' as const }),
      }}
    >
      {children}
    </div>
  );
  if (!speaker && !tail) return box;
  return (
    <div style={{ position: 'relative', maxWidth: m.maxWidth }}>
      {speaker ? (
        <div
          style={{
            position: 'absolute',
            top: -22,
            left: 24,
            fontFamily,
            fontWeight: 700,
            fontSize: Math.round(m.fontSize * 0.55),
            lineHeight: 1.3,
            color: '#ffffff',
            background: speaker.color,
            padding: '2px 14px',
            borderRadius: 999,
          }}
        >
          {speaker.name}
        </div>
      ) : null}
      {box}
      {tail && !boxless ? <Tail at={tail} portrait={portrait} color={look.background} /> : null}
    </div>
  );
};

export const Subtitles: React.FC<{
  subtitles: TimelineSubtitle[];
  lang: string;
  fontFamily: string;
  mode: 'sentence' | 'word';
  metrics: SubtitleMetrics;
  portrait: boolean;
  /** Name tags (dialogue without character art). */
  speakers?: Record<string, { name: string; color: string }>;
  /** Character mode: side of each speaker; subtitles sit next to it with a tail. */
  sideOf?: Record<string, Side>;
  /** Character mode: per-subtitle metrics (a reacting group beside it narrows the box). */
  metricsFor?: (s: TimelineSubtitle) => SubtitleMetrics;
}> = ({
  subtitles,
  lang,
  fontFamily,
  mode,
  metrics: m,
  portrait,
  speakers,
  sideOf,
  metricsFor,
}) => {
  const frame = useCurrentFrame();
  const look = useContext(SubtitleLookContext);
  const current = subtitles.filter((s) => frame >= s.startFrame && frame < s.endFrame);
  if (current.length === 0) return null;
  const box = (s: TimelineSubtitle, i: number, tail?: Side) => (
    <SubtitleBox
      key={i}
      lang={lang}
      fontFamily={fontFamily}
      metrics={metricsFor?.(s) ?? m}
      portrait={portrait}
      {...(tail ? { tail } : {})}
      {...(!tail && speakers?.[s.cast] ? { speaker: speakers[s.cast] } : {})}
    >
      {mode === 'word' ? wordSpans(s, frame, look) : s.text}
    </SubtitleBox>
  );
  if (sideOf && m.sideInset) {
    // One column per side, so overlapping lines from both sides sit next to their speakers.
    const column = (side: Side) => {
      const list = current.filter((s) => (sideOf[s.cast] ?? 'left') === side);
      if (list.length === 0) return null;
      const inset = (metricsFor?.(list[0]!) ?? m).sideInset ?? m.sideInset!;
      return (
        <div
          style={{
            position: 'absolute',
            bottom: m.bottom,
            [side]: inset[side] + (portrait ? 0 : TAIL + 4),
            display: 'flex',
            flexDirection: 'column',
            alignItems: side === 'left' ? 'flex-start' : 'flex-end',
            gap: portrait ? TAIL + 16 : 12,
          }}
        >
          {list.map((s, i) => box(s, i, side))}
        </div>
      );
    };
    return (
      <AbsoluteFill>
        {column('left')}
        {column('right')}
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill
      style={{
        justifyContent:
          m.anchor === 'top' ? 'flex-start' : m.anchor === 'middle' ? 'center' : 'flex-end',
        alignItems: 'center',
        ...(m.anchor === 'top' ? { paddingTop: m.bottom } : {}),
        ...(m.anchor === 'bottom' ? { paddingBottom: m.bottom } : {}),
        gap: speakers ? 40 : 12,
      }}
    >
      {current.map((s, i) => box(s, i))}
    </AbsoluteFill>
  );
};

const CODE_FONT = '"S2V JetBrains Mono", ui-monospace, monospace';

/** Parse a cue `line` attribute: "3" or "2-4" (1-based, inclusive). */
function lineRange(v: string | undefined): [number, number] | null {
  const m = /^(\d+)(?:-(\d+))?$/.exec(v ?? '');
  if (!m) return null;
  const a = Number(m[1]);
  return [a, Number(m[2] ?? a)];
}

export const CodeVisual: React.FC<{ code: string; cues: TimelineCue[] }> = ({ code, cues }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const { width, portrait, reserved } = useVisualArea();
  const lines = code.replace(/\n$/, '').split('\n');
  const panelWidth = Math.min(portrait ? 980 : 1600, width - 48);
  const longest = Math.max(...lines.map((l) => l.length), 1);
  // ~0.6em per monospace glyph; leave room for line numbers.
  const fontSize = Math.max(
    18,
    Math.min(portrait ? 30 : 38, Math.floor((panelWidth - 160) / (longest * 0.6))),
  );
  const active = [...cues].reverse().find((c) => c.frame <= frame && lineRange(c.attrs.line));
  const range = active ? lineRange(active.attrs.line) : null;
  const t = active
    ? interpolate(frame, [active.frame, active.frame + HL_FRAMES], [0, 1], clamp)
    : 0;
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        paddingBottom: reserved ? 24 : portrait ? 300 : 120,
      }}
    >
      <div
        style={{
          width: panelWidth,
          background: theme.code,
          border: `1px solid ${theme.codeEdge}`,
          borderRadius: 24,
          padding: '36px 0',
          boxShadow: `0 12px 40px ${theme.shadow}`,
          fontFamily: CODE_FONT,
          fontSize,
          lineHeight: 1.6,
          color: '#e2e8f0',
        }}
      >
        {lines.map((line, i) => {
          const n = i + 1;
          const hit = range !== null && n >= range[0] && n <= range[1];
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                padding: '0 40px 0 0',
                whiteSpace: 'pre',
                opacity: range ? (hit ? 1 : 1 - 0.55 * t) : 1,
                background: hit ? alpha(theme.accent, 0.22 * t) : 'transparent',
                boxShadow: hit ? `inset 6px 0 0 ${alpha(theme.accent, t)}` : 'none',
              }}
            >
              <span
                style={{
                  width: 96,
                  textAlign: 'right',
                  paddingRight: 28,
                  color: '#64748b',
                  flexShrink: 0,
                }}
              >
                {n}
              </span>
              <span>{line || ' '}</span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/**
 * `:::table`: header + rows. A cue with `row=2` (or `row=2-3`, 1-based body rows) highlights
 * those rows and dims the rest, like code lines. Font size shrinks to fit the widest row.
 */
export const TableVisual: React.FC<{
  rows: string[][];
  cues: TimelineCue[];
  fontFamily: string;
}> = ({ rows, cues, fontFamily }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const { width, height, portrait, reserved } = useVisualArea();
  const [header = [], ...body] = rows;
  const cols = Math.max(header.length, ...body.map((r) => r.length), 1);
  const panelWidth = Math.min(portrait ? 980 : 1600, width - 48);
  // Character budget per column ~ the longest cell (CJK glyphs count double).
  const glyphs = (s: string) =>
    [...s].reduce((n, ch) => n + (/[\u3000-\u9fff\uac00-\ud7af]/.test(ch) ? 2 : 1), 0);
  const colChars = Array.from({ length: cols }, (_, c) =>
    Math.max(4, ...rows.map((r) => glyphs(r[c] ?? ''))),
  );
  const totalChars = colChars.reduce((a, b) => a + b, 0);
  const byWidth = Math.floor((panelWidth - cols * 48) / (totalChars * 0.55));
  const byHeight = Math.floor(
    (height - (reserved ? 80 : portrait ? 380 : 200)) / (rows.length * 2.1),
  );
  const fontSize = Math.max(18, Math.min(portrait ? 34 : 40, byWidth, byHeight));
  const active = [...cues].reverse().find((c) => c.frame <= frame && lineRange(c.attrs.row));
  const range = active ? lineRange(active.attrs.row) : null;
  const t = active
    ? interpolate(frame, [active.frame, active.frame + HL_FRAMES], [0, 1], clamp)
    : 0;
  const cell: React.CSSProperties = { padding: `${fontSize * 0.45}px ${fontSize * 0.7}px` };
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        paddingBottom: reserved ? 24 : portrait ? 300 : 120,
      }}
    >
      <div
        style={{
          width: panelWidth,
          borderRadius: 20,
          overflow: 'hidden',
          boxShadow: `0 12px 40px ${theme.shadow}`,
          background: theme.panel,
          fontFamily,
          fontSize,
          lineHeight: 1.35,
          color: theme.text,
          display: 'grid',
          gridTemplateColumns: colChars.map((n) => `${n}fr`).join(' '),
          wordBreak: 'keep-all',
          overflowWrap: 'anywhere',
        }}
      >
        {header.map((h, c) => (
          <div
            key={`h${c}`}
            style={{ ...cell, background: theme.header, color: theme.onHeader, fontWeight: 700 }}
          >
            {h}
          </div>
        ))}
        {body.flatMap((r, i) => {
          const n = i + 1;
          const hit = range !== null && n >= range[0] && n <= range[1];
          return Array.from({ length: cols }, (_, c) => (
            <div
              key={`${i}:${c}`}
              style={{
                ...cell,
                background: hit
                  ? interpolateColors(t, [0, 1], [i % 2 ? theme.panelAlt : theme.panel, theme.tint])
                  : i % 2
                    ? theme.panelAlt
                    : theme.panel,
                opacity: range ? (hit ? 1 : 1 - 0.55 * t) : 1,
                fontWeight: hit && t > 0.5 ? 700 : 500,
                boxShadow: hit && c === 0 ? `inset 6px 0 0 ${alpha(theme.accent, t)}` : undefined,
              }}
            >
              {r[c] ?? ''}
            </div>
          ));
        })}
      </div>
    </AbsoluteFill>
  );
};

/** `:::quote{by="MDN"}`: quoted paragraphs with their source. */
export const QuoteVisual: React.FC<{ items: string[]; by?: string; fontFamily: string }> = ({
  items,
  by,
  fontFamily,
}) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const { width, portrait, reserved } = useVisualArea();
  const panelWidth = Math.min(portrait ? 940 : 1400, width - 80);
  const chars = items.reduce((n, s) => n + [...s].length, 0);
  // Long quotes get smaller type so they stay readable in one panel.
  const fontSize = Math.round(
    Math.max(28, Math.min(portrait ? 52 : 56, (portrait ? 3400 : 5200) / Math.sqrt(chars + 30))),
  );
  const appear = interpolate(frame, [0, 10], [0, 1], clamp);
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        paddingBottom: reserved ? 24 : portrait ? 300 : 120,
      }}
    >
      <div
        style={{
          width: panelWidth,
          opacity: appear,
          transform: `translateY(${(1 - appear) * 16}px)`,
          fontFamily,
          color: theme.text,
          borderLeft: `10px solid ${theme.accent}`,
          paddingLeft: 48,
        }}
      >
        <div
          style={{
            fontSize: fontSize * 2.2,
            lineHeight: 0.6,
            color: theme.accent,
            fontWeight: 800,
          }}
        >
          “
        </div>
        {items.map((p, i) => (
          <p
            key={i}
            style={{
              fontSize,
              lineHeight: 1.5,
              fontWeight: 600,
              margin: '0 0 0.5em',
              whiteSpace: 'pre-line',
              wordBreak: 'keep-all',
              overflowWrap: 'anywhere',
            }}
          >
            {keepHyphenated(p)}
          </p>
        ))}
        {by ? (
          <div style={{ fontSize: fontSize * 0.6, color: theme.muted, textAlign: 'right' }}>
            — {by}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

/** Which item a cue's `highlight=` (0-based) points at, eased in; null before any cue. */
function highlighted(cues: TimelineCue[], frame: number): { index: number; t: number } | null {
  const active = [...cues]
    .reverse()
    .find((c) => c.frame <= frame && c.attrs.highlight !== undefined);
  if (!active) return null;
  return {
    index: Number(active.attrs.highlight),
    t: interpolate(frame, [active.frame, active.frame + HL_FRAMES], [0, 1], clamp),
  };
}

/** `:::compare`: 2–3 columns (### title + list); `highlight=1` brings a column forward. */
export const CompareVisual: React.FC<{
  columns: { title: string; items: string[] }[];
  cues: TimelineCue[];
  fontFamily: string;
}> = ({ columns, cues, fontFamily }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const { width, portrait, reserved } = useVisualArea();
  const hl = highlighted(cues, frame);
  const panelWidth = Math.min(portrait ? 980 : 1600, width - 64);
  const longest = Math.max(...columns.flatMap((c) => c.items.map((i) => [...i].length)), 8);
  const fontSize = Math.max(
    22,
    Math.min(portrait ? 34 : 40, Math.floor(panelWidth / columns.length / (longest * 0.62))),
  );
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        paddingBottom: reserved ? 24 : portrait ? 300 : 120,
      }}
    >
      <div
        style={{
          width: panelWidth,
          display: 'flex',
          flexDirection: portrait && columns.length > 2 ? 'column' : 'row',
          gap: 28,
          fontFamily,
        }}
      >
        {columns.map((col, i) => {
          const on = hl?.index === i;
          const t = hl ? hl.t : 0;
          return (
            <div
              key={i}
              style={{
                flex: 1,
                background: theme.panel,
                borderRadius: 20,
                overflow: 'hidden',
                boxShadow: `0 10px 30px ${theme.shadow}`,
                opacity: hl ? (on ? 1 : 1 - 0.5 * t) : 1,
                transform: `scale(${on ? 1 + 0.03 * t : 1})`,
                outline: on ? `${Math.round(5 * t)}px solid ${theme.accent}` : 'none',
              }}
            >
              <div
                style={{
                  background: on
                    ? interpolateColors(t, [0, 1], [theme.header, theme.accent])
                    : theme.header,
                  color: on
                    ? interpolateColors(t, [0, 1], [theme.onHeader, theme.onAccent])
                    : theme.onHeader,
                  fontSize: fontSize * 1.1,
                  fontWeight: 800,
                  padding: `${fontSize * 0.5}px ${fontSize * 0.8}px`,
                }}
              >
                {keepHyphenated(col.title)}
              </div>
              <ul
                style={{
                  margin: 0,
                  padding: `${fontSize * 0.6}px ${fontSize * 0.8}px ${fontSize * 0.6}px ${fontSize * 1.8}px`,
                  color: theme.text,
                  fontSize,
                  lineHeight: 1.45,
                  fontWeight: 600,
                }}
              >
                {col.items.map((it, j) => (
                  <li
                    key={j}
                    style={{
                      marginBottom: '0.3em',
                      wordBreak: 'keep-all',
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {keepHyphenated(it)}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/** `:::gallery`: 2–6 images in a grid; `highlight=2` enlarges one and dims the rest. */
export const GalleryVisual: React.FC<{
  images: { src: string; caption?: string }[];
  cues: TimelineCue[];
  fontFamily: string;
}> = ({ images, cues, fontFamily }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const { width, height, portrait, reserved } = useVisualArea();
  const hl = highlighted(cues, frame);
  const cols = portrait
    ? images.length <= 3
      ? 1
      : 2
    : images.length <= 3
      ? images.length
      : Math.ceil(images.length / 2);
  const rows = Math.ceil(images.length / cols);
  const w = Math.min(portrait ? 980 : 1700, width - 64);
  // Leave the subtitle band free (captions sit under the images).
  const h = Math.max(200, height - (reserved ? 80 : portrait ? 520 : 320));
  const cellH = (h - (rows - 1) * 24) / rows;
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        paddingBottom: reserved ? 24 : portrait ? 300 : 120,
      }}
    >
      <div
        style={{ width: w, display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 24 }}
      >
        {images.map((img, i) => {
          const on = hl?.index === i;
          const t = hl ? hl.t : 0;
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
                opacity: hl ? (on ? 1 : 1 - 0.6 * t) : 1,
                transform: `scale(${on ? 1 + 0.06 * t : 1})`,
                zIndex: on ? 2 : 1,
              }}
            >
              <Img
                src={staticFile(img.src)}
                style={{
                  width: '100%',
                  height: img.caption ? cellH - 56 : cellH,
                  objectFit: 'contain',
                  borderRadius: 12,
                  boxShadow: on
                    ? `0 0 0 ${Math.round(6 * t)}px ${theme.accent}`
                    : `0 8px 24px ${theme.shadow}`,
                  background: theme.panel,
                }}
              />
              {img.caption ? (
                <div style={{ fontFamily, fontSize: 30, fontWeight: 700, color: theme.text }}>
                  {img.caption}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/** `:::chart`: horizontal bars that grow in; `row=2` highlights a bar; `unit=ms` labels values. */
export const ChartVisual: React.FC<{
  rows: string[][];
  cues: TimelineCue[];
  unit?: string;
  fontFamily: string;
}> = ({ rows, cues, unit = '', fontFamily }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const { width, height, portrait, reserved } = useVisualArea();
  const [header = [], ...data] = rows;
  const values = data.map((r) => Number((r[1] ?? '0').replace(/,/g, '')));
  const max = Math.max(...values, 1e-9);
  const active = [...cues].reverse().find((c) => c.frame <= frame && lineRange(c.attrs.row));
  const range = active ? lineRange(active.attrs.row) : null;
  const t = active
    ? interpolate(frame, [active.frame, active.frame + HL_FRAMES], [0, 1], clamp)
    : 0;
  const panelWidth = Math.min(portrait ? 980 : 1500, width - 64);
  const barH = Math.max(
    28,
    Math.min(64, (height - (reserved ? 160 : portrait ? 480 : 320)) / (data.length * 1.6)),
  );
  const labelW = Math.min(
    panelWidth * 0.32,
    Math.max(...data.map((r) => [...(r[0] ?? '')].length)) * barH * 0.55 + 20,
  );
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        paddingBottom: reserved ? 24 : portrait ? 300 : 120,
      }}
    >
      <div style={{ width: panelWidth, fontFamily, color: theme.text }}>
        {header[1] ? (
          <div
            style={{
              fontSize: barH * 0.55,
              fontWeight: 700,
              color: theme.muted,
              marginBottom: barH * 0.4,
              marginLeft: labelW,
            }}
          >
            {header[1]}
          </div>
        ) : null}
        {data.map((r, i) => {
          const n = i + 1;
          const hit = range !== null && n >= range[0] && n <= range[1];
          // Bars grow one after another.
          const grow = interpolate(frame, [i * 4, i * 4 + 18], [0, 1], {
            ...clamp,
            easing: Easing.out(Easing.cubic),
          });
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                height: barH,
                marginBottom: barH * 0.45,
                opacity: range ? (hit ? 1 : 1 - 0.5 * t) : 1,
              }}
            >
              <div
                style={{
                  width: labelW,
                  fontSize: barH * 0.5,
                  fontWeight: 700,
                  textAlign: 'right',
                  paddingRight: 20,
                  whiteSpace: 'nowrap',
                }}
              >
                {r[0]}
              </div>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 14 }}>
                <div
                  style={{
                    height: barH,
                    width: `${(values[i]! / max) * 85 * grow}%`,
                    borderRadius: 10,
                    background: hit ? theme.accent : alpha(theme.accent, 0.45),
                  }}
                />
                <div style={{ fontSize: barH * 0.5, fontWeight: 800, opacity: grow }}>
                  {r[1]}
                  {unit}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/** `::video{src=clip.mp4}`: a muted clip fitted into the visual area (`start=` seconds in). */
export const VideoVisual: React.FC<{ src: string; start?: number }> = ({ src, start = 0 }) => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: 40 }}>
      <OffthreadVideo
        src={staticFile(src)}
        muted
        trimBefore={Math.round(start * fps)}
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      />
    </AbsoluteFill>
  );
};

let mermaidReady: Promise<typeof import('mermaid').default> | null = null;
let diagramCount = 0;

/**
 * `:::diagram` (mermaid). Rendered once to SVG, held with delayRender until ready. A cue with
 * `node=A` lights node A (flowchart ids) and dims the rest.
 */
export const DiagramVisual: React.FC<{ code: string; cues: TimelineCue[]; fontFamily: string }> = ({
  code,
  cues,
  fontFamily,
}) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const { width, height, portrait, reserved } = useVisualArea();
  const [svg, setSvg] = useState<string | null>(null);
  const [handle] = useState(() => delayRender('mermaid diagram'));
  const dark =
    theme.background.toLowerCase() !== '#f3f4f6' && theme.text.toLowerCase() === '#f3f4f6';
  useEffect(() => {
    mermaidReady ??= import('mermaid').then((m) => m.default);
    let alive = true;
    void mermaidReady.then(async (mermaid) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: dark ? 'dark' : 'default',
        fontFamily,
        securityLevel: 'strict',
        flowchart: { htmlLabels: false },
      });
      const { svg: out } = await mermaid.render(`s2v-diagram-${++diagramCount}`, code);
      if (alive) setSvg(out);
      continueRender(handle);
    });
    return () => {
      alive = false;
    };
  }, [code, dark, fontFamily, handle]);

  const active = [...cues].reverse().find((c) => c.frame <= frame && c.attrs.node);
  const t = active
    ? interpolate(frame, [active.frame, active.frame + HL_FRAMES], [0, 1], clamp)
    : 0;
  const node = active?.attrs.node?.replace(/[^\w-]/g, '');
  const css = node
    ? `.node, .edgePath, .flowchart-link { opacity: ${1 - 0.6 * t}; transition: none; }
       [id*="flowchart-${node}-"] { opacity: 1 !important; }
       [id*="flowchart-${node}-"] rect, [id*="flowchart-${node}-"] polygon, [id*="flowchart-${node}-"] circle, [id*="flowchart-${node}-"] path {
         stroke: ${theme.accent} !important; stroke-width: ${2 + 3 * t}px !important; }`
    : '';
  const maxW = Math.min(portrait ? 980 : 1600, width - 80);
  const maxH = height - (reserved ? 80 : portrait ? 420 : 240);
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        paddingBottom: reserved ? 24 : portrait ? 300 : 120,
      }}
    >
      {svg ? (
        <div
          style={{
            width: maxW,
            height: maxH,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <style>{`.s2v-diagram svg { width: 100% !important; height: 100% !important; max-width: ${maxW}px !important; max-height: ${maxH}px !important; }
            .s2v-diagram text, .s2v-diagram .nodeLabel { font-family: ${fontFamily}; font-weight: 600; }
            ${css}`}</style>
          <div
            className="s2v-diagram"
            style={{ width: '100%', height: '100%' }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

/** `:::markdown`: a text card (headings, paragraphs, list items, **bold**, `code`). */
export const MarkdownVisual: React.FC<{
  md: { kind: 'h' | 'p' | 'li'; runs: { text: string; bold?: boolean; code?: boolean }[] }[];
  cues: TimelineCue[];
  fontFamily: string;
  /** Inside another visual (split): the box to fill instead of the visual area. */
  box?: { width: number; height: number };
}> = ({ md, cues, fontFamily, box }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const area = useVisualArea();
  const { portrait } = area;
  const reserved = box ? true : area.reserved;
  const hl = highlighted(cues, frame);
  const panelWidth = box ? box.width : Math.min(portrait ? 960 : 1400, area.width - 80);
  const chars = md.reduce((n, b) => n + b.runs.reduce((m, r) => m + [...r.text].length, 0), 0);
  const avail = box ? box.height - 40 : area.height - (reserved ? 100 : portrait ? 480 : 300);
  // Shrink type for long cards so everything fits the panel.
  const fontSize = Math.round(
    Math.max(
      24,
      Math.min(portrait ? 46 : 44, Math.sqrt((panelWidth * avail) / (Math.max(chars, 20) * 2.6))),
    ),
  );
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        paddingBottom: reserved ? 24 : portrait ? 300 : 120,
      }}
    >
      <div
        style={{
          width: panelWidth,
          background: theme.panel,
          borderRadius: 24,
          padding: `${fontSize}px ${fontSize * 1.3}px`,
          boxShadow: `0 12px 40px ${theme.shadow}`,
          fontFamily,
          color: theme.text,
          fontSize,
          lineHeight: 1.5,
          wordBreak: 'keep-all',
          overflowWrap: 'anywhere',
        }}
      >
        {md.map((b, i) => {
          const on = hl?.index === i;
          const t = hl ? hl.t : 0;
          const content = b.runs.map((r, j) =>
            r.code ? (
              <code
                key={j}
                style={{
                  fontFamily: CODE_FONT,
                  fontSize: '0.85em',
                  background: alpha(theme.accent, 0.12),
                  color: theme.accent,
                  padding: '0.05em 0.35em',
                  borderRadius: 6,
                }}
              >
                {r.text}
              </code>
            ) : (
              <span key={j} style={r.bold ? { fontWeight: 800 } : undefined}>
                {r.text}
              </span>
            ),
          );
          return (
            <div
              key={i}
              style={{
                fontSize: b.kind === 'h' ? '1.35em' : '1em',
                fontWeight: b.kind === 'h' ? 800 : 500,
                margin: b.kind === 'h' ? '0 0 0.45em' : '0 0 0.35em',
                paddingLeft: b.kind === 'li' ? '1.2em' : 0,
                position: 'relative',
                opacity: hl ? (on ? 1 : 1 - 0.5 * t) : 1,
                background: on ? alpha(theme.accent, 0.12 * t) : 'transparent',
                borderRadius: 8,
              }}
            >
              {b.kind === 'li' ? (
                <span style={{ position: 'absolute', left: '0.3em', color: theme.accent }}>•</span>
              ) : null}
              {content}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/** `:::split`: one image and a text card side by side (stacked on portrait); `side=right` puts the image right. */
export const SplitVisual: React.FC<{
  image: { src: string; caption?: string };
  md: { kind: 'h' | 'p' | 'li'; runs: { text: string; bold?: boolean; code?: boolean }[] }[];
  cues: TimelineCue[];
  imageRight: boolean;
  fontFamily: string;
}> = ({ image, md, cues, imageRight, fontFamily }) => {
  const theme = useTheme();
  const { width, height, portrait, reserved } = useVisualArea();
  const avail = height - (reserved ? 80 : portrait ? 420 : 220);
  const w = Math.min(portrait ? 980 : 1700, width - 64);
  const picture = (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        minWidth: 0,
      }}
    >
      <Img
        src={staticFile(image.src)}
        style={{
          maxWidth: '100%',
          maxHeight: portrait ? avail * 0.45 : avail,
          objectFit: 'contain',
          borderRadius: 14,
          boxShadow: `0 10px 30px ${theme.shadow}`,
        }}
      />
      {image.caption ? (
        <div style={{ fontFamily, fontSize: 28, fontWeight: 700, color: theme.muted }}>
          {image.caption}
        </div>
      ) : null}
    </div>
  );
  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: portrait ? 'column' : imageRight ? 'row-reverse' : 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 40,
          padding: `0 ${(width - w) / 2}px ${reserved ? 24 : portrait ? 300 : 120}px`,
        }}
      >
        {picture}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            position: 'relative',
            height: portrait ? avail * 0.5 : avail,
          }}
        >
          <MarkdownVisual
            md={md}
            cues={cues}
            fontFamily={fontFamily}
            box={{
              width: portrait ? w : (w - 40) / 2,
              height: portrait ? avail * 0.5 : avail,
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};

import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { dialogueGeometry, type DialogueShape } from '../shared';
import { customFont, fontFor, fontsReady, withFallback } from './fonts';
import { DEFAULT_LOOK, SubtitleBox, SubtitleLookContext } from './visuals';

export type ProbeItem = { id: string; text: string };
export type ProbeResult = { id: string; lines: number; maxLines: number; width: number };

/**
 * Lay each subtitle out in a hidden node with the exact component used for rendering and count
 * the lines it needs (PLAN 5.12 `s2v check`). Runs inside the bundle, in Remotion's browser.
 */
export async function measureSubtitles(
  items: ProbeItem[],
  lang: string,
  /** Speakers on screen narrow the subtitle box (avatars / characters beside it). */
  shape: DialogueShape,
  style: { size?: number; position?: 'bottom' | 'middle' | 'top'; font?: string },
): Promise<ProbeResult[]> {
  await fontsReady;
  const font = style.font ? customFont(style.font) : null;
  if (font) await font.ready;
  await document.fonts.ready;
  const m = dialogueGeometry(shape, style).subtitle;
  const look = {
    ...DEFAULT_LOOK,
    ...(font ? { fontFamily: withFallback(font.family, lang) } : {}),
  };
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;width:4000px';
  document.body.appendChild(host);
  const root = createRoot(host);
  const out: ProbeResult[] = [];
  try {
    for (const it of items) {
      flushSync(() =>
        root.render(
          <SubtitleLookContext.Provider value={look}>
            <SubtitleBox lang={lang} fontFamily={fontFor(lang)} metrics={m} clamp={false}>
              {it.text}
            </SubtitleBox>
          </SubtitleLookContext.Provider>,
        ),
      );
      const box = host.firstElementChild as HTMLElement;
      const rect = box.getBoundingClientRect();
      out.push({
        id: it.id,
        lines: Math.round((rect.height - 2 * m.paddingY) / (m.fontSize * m.lineHeight)),
        maxLines: m.maxLines,
        width: Math.round(rect.width),
      });
    }
  } finally {
    root.unmount();
    host.remove();
  }
  return out;
}

import { loadFont } from '@remotion/fonts';
import { staticFile } from 'remotion';

const FAMILY = {
  ko: 'S2V Noto Sans KR',
  ja: 'S2V Noto Sans JP',
  en: 'S2V Noto Sans KR', // Noto Sans KR includes Latin glyphs
} as const;

// loadFont() holds rendering (delayRender) until the face is in document.fonts, so the very first
// captured frame already uses the right font. Called at module scope: once per browser tab.
export const fontsReady = Promise.all([
  loadFont({
    family: FAMILY.ko,
    url: staticFile('fonts/NotoSansKR-Variable.ttf'),
    weight: '100 900',
  }),
  loadFont({
    family: 'S2V JetBrains Mono',
    url: staticFile('fonts/JetBrainsMono-Variable.ttf'),
    weight: '100 800',
  }),
  loadFont({
    family: FAMILY.ja,
    url: staticFile('fonts/NotoSansJP-Variable.ttf'),
    weight: '100 900',
  }),
]);

export const fontFor = (lang: string): string =>
  `"${FAMILY[lang as keyof typeof FAMILY] ?? FAMILY.ko}", sans-serif`;

const custom = new Map<string, { family: string; ready: Promise<unknown> }>();

/**
 * A font file from the script (`subtitleStyle.font`), loaded once per bundle. Use it in front
 * of the language font (`withFallback`): glyphs the file lacks (e.g. Hangul in a Latin font)
 * come from the bundled Noto Sans, never from a system font. loadFont holds the
 * render until the face is ready, so the first frame already uses it.
 */
export function customFont(publicPath: string): { family: string; ready: Promise<unknown> } {
  let f = custom.get(publicPath);
  if (!f) {
    const family = `S2V Custom ${custom.size + 1}`;
    f = {
      family: `"${family}", sans-serif`,
      ready: loadFont({ family, url: staticFile(publicPath) }),
    };
    custom.set(publicPath, f);
  }
  return f;
}

export const withFallback = (custom: string, lang: string): string => `${custom}, ${fontFor(lang)}`;

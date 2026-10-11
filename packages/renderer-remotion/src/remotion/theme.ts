import { createContext, useContext } from 'react';

/** Colors every visual draws with (frontmatter `theme`). Code panels stay dark in both themes. */
export interface Theme {
  /** Base theme is dark (for libraries with their own light / dark styles, e.g. mermaid). */
  dark: boolean;
  background: string;
  text: string;
  muted: string;
  accent: string;
  /** Text on an accent fill. */
  onAccent: string;
  panel: string;
  panelAlt: string;
  header: string;
  onHeader: string;
  /** Tint behind a highlighted table row / bullet. */
  tint: string;
  shadow: string;
  /** Code panel (dark in both themes) and its edge. */
  code: string;
  codeEdge: string;
}

const LIGHT: Theme = {
  dark: false,
  background: '#f3f4f6',
  text: '#111827',
  muted: '#4b5563',
  accent: '#ef4444',
  onAccent: '#ffffff',
  panel: '#ffffff',
  panelAlt: '#f9fafb',
  header: '#1f2937',
  onHeader: '#ffffff',
  tint: '#fee2e2',
  shadow: 'rgba(0, 0, 0, 0.18)',
  code: '#0f172a',
  codeEdge: 'transparent',
};

const DARK: Theme = {
  dark: true,
  background: '#0b1020',
  text: '#f3f4f6',
  muted: '#9ca3af',
  accent: '#f87171',
  onAccent: '#111827',
  panel: '#1f2937',
  panelAlt: '#18202d',
  header: '#374151',
  onHeader: '#f9fafb',
  tint: '#5b2530',
  shadow: 'rgba(0, 0, 0, 0.45)',
  code: '#161e30',
  codeEdge: 'rgba(255, 255, 255, 0.12)',
};

export type ThemeProp = {
  base: 'light' | 'dark';
  background?: string;
  text?: string;
  accent?: string;
};

export function resolveTheme(t: ThemeProp | undefined): Theme {
  const base = t?.base === 'dark' ? DARK : LIGHT;
  return {
    ...base,
    ...(t?.background ? { background: t.background } : {}),
    ...(t?.text ? { text: t.text } : {}),
    ...(t?.accent ? { accent: t.accent } : {}),
  };
}

/** `#rrggbb` (or `#rgb`) with an alpha, for translucent accents. */
export function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return hex;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export const ThemeContext = createContext<Theme>(LIGHT);
export const useTheme = () => useContext(ThemeContext);

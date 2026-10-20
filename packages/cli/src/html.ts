import { spawn } from 'node:child_process';

/** Text for HTML element content and double-quoted attributes. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Open a page in the default browser; the path is printed when there is no opener. S2V_NO_OPEN
 * (any value) opens nothing, for every page s2v writes (scripts, CI, tests).
 */
export function openPage(path: string): void {
  if (process.env.S2V_NO_OPEN) return;
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(opener, [path], { stdio: 'ignore', detached: true })
      .on('error', () => console.error(`open it yourself: ${path}`))
      .unref();
  } catch {
    console.error(`open it yourself: ${path}`);
  }
}

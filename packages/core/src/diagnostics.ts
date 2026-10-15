/** `info`: no effect on the exit code (a hint, e.g. an attribute this voice cannot act). */
export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  line?: number;
}

export class Diagnostics {
  readonly items: Diagnostic[] = [];

  error(code: string, message: string, line?: number): void {
    this.items.push({ severity: 'error', code, message, line });
  }

  warn(code: string, message: string, line?: number): void {
    this.items.push({ severity: 'warning', code, message, line });
  }

  info(code: string, message: string, line?: number): void {
    this.items.push({ severity: 'info', code, message, line });
  }

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === 'error');
  }
}

export function formatDiagnostic(d: Diagnostic, file = 'script'): string {
  const where = d.line === undefined ? file : `${file}:${d.line}`;
  return `${where} ${d.severity} [${d.code}] ${d.message}`;
}

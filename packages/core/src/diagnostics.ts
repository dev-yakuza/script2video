export type Severity = 'error' | 'warning';

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

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === 'error');
  }
}

export function formatDiagnostic(d: Diagnostic, file = 'script'): string {
  const where = d.line === undefined ? file : `${file}:${d.line}`;
  return `${where} ${d.severity} [${d.code}] ${d.message}`;
}

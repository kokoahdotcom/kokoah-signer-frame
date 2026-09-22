// Plain-text table rendering for terminal output.

export type Result = 'PASS' | 'FAIL' | 'INFO';

export interface CheckRow {
  check: string;
  result: Result;
  detail: string;
}

export function renderTable(headers: string[], rows: string[][], maxCol = 100): string {
  const clip = (s: string): string => (s.length > maxCol ? `${s.slice(0, maxCol - 1)}…` : s);
  const cells = rows.map((r) => r.map((c) => clip(c.replace(/\s+/g, ' '))));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]): string => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n');
}

export function renderChecks(rows: CheckRow[]): string {
  return renderTable(
    ['CHECK', 'RESULT', 'DETAIL'],
    rows.map((r) => [r.check, r.result, r.detail]),
  );
}

export function countFailures(rows: CheckRow[]): number {
  return rows.filter((r) => r.result === 'FAIL').length;
}

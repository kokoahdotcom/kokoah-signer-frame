#!/usr/bin/env node
// hl-status: print upcoming Hyperliquid scheduled maintenance and unresolved
// incidents from HL's public Statuspage JSON. Read-only GET requests.
import { EXIT_CHECK_FAILED, EXIT_OK, UsageError, parseCli, parsePositiveInt, runCli } from './lib/cli.ts';
import { getJson } from './lib/http.ts';
import { renderTable } from './lib/table.ts';

export const DEFAULT_BASE_URL = 'https://hyperliquid.statuspage.io';

export const USAGE = `Usage: hl-status [options]

Fetches Hyperliquid's public Statuspage JSON
  ${DEFAULT_BASE_URL}/api/v2/scheduled-maintenances.json
  ${DEFAULT_BASE_URL}/api/v2/incidents.json
and prints scheduled or in-progress maintenance and unresolved incidents.

Hyperliquid network upgrades usually mean ~10 minutes of downtime, often on
Saturday mornings UTC, followed by a post-only period in which market-style and
TWAP orders do not fill. See docs/RUNBOOKS.md "HL scheduled maintenance".

Options:
  --recent <n>        Also show the n most recent completed maintenances
  --fail-on-active    Exit 1 if maintenance is in progress or an incident is unresolved
  --base-url <url>    Statuspage base URL (default ${DEFAULT_BASE_URL})
  --timeout-ms <n>    Per-request timeout in milliseconds (default 10000)
  --json              Print JSON instead of text
  -h, --help          Show this help

Exit codes: 0 ok, 1 active maintenance or incident (only with --fail-on-active),
2 usage error or the status page could not be read.`;

export interface StatusUpdate {
  status: string;
  body: string;
  created_at: string;
}

export interface Maintenance {
  id: string;
  name: string;
  status: string;
  impact: string;
  shortlink?: string;
  scheduled_for: string | null;
  scheduled_until: string | null;
  incident_updates: StatusUpdate[];
}

export interface Incident {
  id: string;
  name: string;
  status: string;
  impact: string;
  shortlink?: string;
  created_at: string;
  resolved_at: string | null;
  incident_updates: StatusUpdate[];
}

/** Statuspage maintenance states that are not finished. */
export const OPEN_MAINTENANCE = new Set(['scheduled', 'in_progress', 'verifying']);
/** Statuspage incident states that are finished. */
export const CLOSED_INCIDENT = new Set(['resolved', 'postmortem']);

export interface StatusSummary {
  checkedAt: string;
  upcoming: Maintenance[];
  inProgress: Maintenance[];
  recentCompleted: Maintenance[];
  unresolvedIncidents: Incident[];
}

function latestUpdate(u: StatusUpdate[]): StatusUpdate | undefined {
  return [...u].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

export function summarize(
  maintenances: Maintenance[],
  incidents: Incident[],
  now: Date,
  recent = 0,
): StatusSummary {
  const open = maintenances.filter((m) => OPEN_MAINTENANCE.has(m.status));
  const byStart = (a: Maintenance, b: Maintenance): number => (a.scheduled_for ?? '').localeCompare(b.scheduled_for ?? '');
  return {
    checkedAt: now.toISOString(),
    upcoming: open.filter((m) => m.status === 'scheduled').sort(byStart),
    inProgress: open.filter((m) => m.status !== 'scheduled').sort(byStart),
    recentCompleted: maintenances
      .filter((m) => !OPEN_MAINTENANCE.has(m.status))
      .sort((a, b) => byStart(b, a))
      .slice(0, recent),
    unresolvedIncidents: incidents.filter((i) => !CLOSED_INCIDENT.has(i.status)),
  };
}

export function formatRelative(target: string | null, now: Date): string {
  if (target === null) return 'unknown';
  const ms = Date.parse(target) - now.getTime();
  const totalMin = Math.round(Math.abs(ms) / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const span = d >= 2 ? `${d}d${String(h).padStart(2, '0')}h` : d * 24 + h > 0 ? `${d * 24 + h}h${String(m).padStart(2, '0')}m` : `${m}m`;
  return ms >= 0 ? `in ${span}` : `${span} ago`;
}

export function renderSummary(s: StatusSummary, now: Date): string {
  const lines: string[] = [`Hyperliquid status (${s.checkedAt})`, ''];
  const mRows = (list: Maintenance[]): string[][] =>
    list.map((m) => [
      m.status,
      m.scheduled_for ?? '?',
      m.scheduled_until ?? '?',
      formatRelative(m.scheduled_for, now),
      m.name,
      latestUpdate(m.incident_updates)?.body ?? '',
    ]);
  const mHead = ['STATUS', 'STARTS (UTC)', 'ENDS (UTC)', 'WHEN', 'NAME', 'LATEST UPDATE'];

  if (s.inProgress.length > 0) {
    lines.push('MAINTENANCE IN PROGRESS: expect downtime, then a post-only period (market/TWAP orders do not fill).');
    lines.push(renderTable(mHead, mRows(s.inProgress)), '');
  }
  if (s.upcoming.length > 0) {
    lines.push('Upcoming maintenance:', renderTable(mHead, mRows(s.upcoming)), '');
  } else {
    lines.push('No upcoming scheduled maintenance announced. (HL often announces only ~2 hours ahead.)', '');
  }
  if (s.unresolvedIncidents.length > 0) {
    lines.push(
      'UNRESOLVED INCIDENTS:',
      renderTable(
        ['STATUS', 'IMPACT', 'CREATED (UTC)', 'NAME', 'LATEST UPDATE'],
        s.unresolvedIncidents.map((i) => [i.status, i.impact, i.created_at, i.name, latestUpdate(i.incident_updates)?.body ?? '']),
      ),
      '',
    );
  } else {
    lines.push('No unresolved incidents.', '');
  }
  if (s.recentCompleted.length > 0) {
    lines.push('Recently completed maintenance:', renderTable(mHead, mRows(s.recentCompleted)), '');
  }
  return lines.join('\n');
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseCli<{
    recent?: string;
    'fail-on-active'?: boolean;
    'base-url'?: string;
    'timeout-ms'?: string;
    json?: boolean;
  }>(argv, {
    recent: { type: 'string' },
    'fail-on-active': { type: 'boolean' },
    'base-url': { type: 'string' },
    'timeout-ms': { type: 'string' },
    json: { type: 'boolean' },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_OK;
  }
  const base = (values['base-url'] ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  if (!/^https?:\/\//.test(base)) throw new UsageError('--base-url must be an http(s) URL');
  const timeoutMs = parsePositiveInt('timeout-ms', values['timeout-ms'], 10_000);
  const recent = values.recent === undefined ? 0 : parsePositiveInt('recent', values.recent, 0);

  const [maint, inc] = await Promise.all([
    getJson<{ scheduled_maintenances?: Maintenance[] }>(`${base}/api/v2/scheduled-maintenances.json`, { timeoutMs }),
    getJson<{ incidents?: Incident[] }>(`${base}/api/v2/incidents.json`, { timeoutMs }),
  ]);
  if (!Array.isArray(maint.scheduled_maintenances) || !Array.isArray(inc.incidents)) {
    throw new Error('unexpected Statuspage JSON shape');
  }
  const now = new Date();
  const summary = summarize(maint.scheduled_maintenances, inc.incidents, now, recent);
  if (values.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else process.stdout.write(renderSummary(summary, now));

  const active = summary.inProgress.length > 0 || summary.unresolvedIncidents.length > 0;
  return values['fail-on-active'] === true && active ? EXIT_CHECK_FAILED : EXIT_OK;
}

if (import.meta.main) {
  await runCli(USAGE, () => main(process.argv.slice(2)));
}

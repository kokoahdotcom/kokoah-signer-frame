#!/usr/bin/env node
// monitor-deploy: verify that what a site serves right now is byte-for-byte the
// release described by a release manifest. Read-only GET requests.
import { readFile } from 'node:fs/promises';
import { EXIT_CHECK_FAILED, EXIT_OK, UsageError, parseCli, parsePositiveInt, runCli } from './lib/cli.ts';
import { extractResources, isExecutableInline, requiresSri, type HtmlResource } from './lib/html.ts';
import { httpGet, mapLimit } from './lib/http.ts';
import { manifestKeyFor, parseManifest, type ReleaseManifest } from './lib/manifest.ts';
import { integrityMatches, sriDigest } from './lib/sri.ts';
import { countFailures, renderChecks, type CheckRow } from './lib/table.ts';

export const USAGE = `Usage: monitor-deploy --url <site-url> --manifest <path-or-url> [options]

Fetches the site's HTML, extracts every <script> and <link> (stylesheet,
modulepreload, preload) with its integrity attribute, fetches each one, computes
SHA-384 and compares it with the integrity attribute and with the release
manifest. Exits non-zero on any mismatch. Read-only (GET requests only).

Checks:
  - the HTML itself matches the entrypoint hash of one of the given manifests
  - every script/style is same-origin (or in --allow-origin) and has integrity
  - every fetched script/style matches its integrity attribute and the manifest
  - every executable inline <script> is listed in the manifest's inlineScripts
  - with --scope all (default): every file in the manifest (lazy chunks, the
    service worker, workers) is fetched and matches its hash

Options:
  --url <url>            Page to check, e.g. https://app.kokoah.example/
  --manifest <src>       Manifest JSON: a file path or https:// URL. Repeat to allow
                         several releases (e.g. current and previous during a rollout);
                         the HTML hash decides which manifest applies. Fetch it from a
                         channel the CDN cannot change (e.g. a GitHub release asset).
  --scope <html|all>     html = only resources referenced by the HTML; all = also every
                         manifest file (default: all)
  --allow-origin <o>     Extra origin allowed to serve scripts (repeatable). Default: none.
  --concurrency <n>      Parallel fetches (default 8)
  --timeout-ms <n>       Per-request timeout in milliseconds (default 15000)
  --user-agent <ua>      User-Agent to send. Payloads can target specific visitors, so
                         run monitors from several regions and with browser-like UAs.
  --json                 Print JSON instead of a table
  -h, --help             Show this help

Exit codes: 0 everything matches, 1 mismatch or policy violation, 2 usage or fatal error
(HTML or manifest unreachable).

Manifest format: docs/RELEASE_MANIFEST.md`;

export interface MonitorOptions {
  url: string;
  manifests: ReleaseManifest[];
  scope: 'html' | 'all';
  allowOrigins: string[];
  concurrency: number;
  timeoutMs: number;
  userAgent?: string;
}

export interface MonitorReport {
  url: string;
  checkedAt: string;
  release: { version: string; gitCommit: string } | null;
  checks: CheckRow[];
  failures: number;
}

async function loadManifest(src: string, timeoutMs: number): Promise<ReleaseManifest> {
  let text: string;
  if (/^https?:\/\//.test(src)) {
    const res = await httpGet(src, { timeoutMs, accept: 'application/json' });
    if (res.status !== 200) throw new Error(`manifest ${src}: HTTP ${res.status}`);
    text = new TextDecoder().decode(res.body);
  } else {
    text = await readFile(src, 'utf8');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`manifest ${src} is not valid JSON`);
  }
  return parseManifest(json);
}

function label(r: HtmlResource): string {
  return r.ref ?? '(inline)';
}

export async function monitorDeploy(opts: MonitorOptions): Promise<MonitorReport> {
  const checks: CheckRow[] = [];
  const fetchOpts = { timeoutMs: opts.timeoutMs, ...(opts.userAgent !== undefined ? { userAgent: opts.userAgent } : {}) };

  // 1. The HTML must be exactly one known release's entrypoint.
  const page = await httpGet(opts.url, fetchOpts);
  if (page.status !== 200) throw new Error(`GET ${opts.url} returned HTTP ${page.status}`);
  const htmlHash = sriDigest(page.body, 'sha384');
  const manifest = opts.manifests.find((m) => m.files[m.entrypoint] === htmlHash) ?? null;
  checks.push({
    check: 'html',
    result: manifest ? 'PASS' : 'FAIL',
    detail: manifest
      ? `${new URL(page.finalUrl).pathname} = ${manifest.entrypoint} of release ${manifest.version} (${manifest.gitCommit.slice(0, 12)})`
      : `served HTML ${htmlHash} matches no given manifest entrypoint`,
  });
  // Without a matching manifest, still check assets against the first manifest so
  // the report shows what else changed.
  const ref = manifest ?? opts.manifests[0];
  if (ref === undefined) throw new Error('no manifest given');
  const siteOrigin = ref.site;
  const allowed = new Set([siteOrigin, ...opts.allowOrigins]);

  const resources = extractResources(new TextDecoder().decode(page.body), page.finalUrl);

  // 2. Inline scripts must be known.
  for (const r of resources.filter(isExecutableInline)) {
    const h = sriDigest(new TextEncoder().encode(r.inlineContent ?? ''), 'sha384');
    const known = ref.inlineScripts.includes(h);
    checks.push({ check: 'inline script', result: known ? 'PASS' : 'FAIL', detail: known ? h : `unlisted inline script ${h}` });
  }

  // 3. Scripts and styles referenced by the HTML.
  const sriResources = resources.filter(requiresSri);
  const checkedUrls = new Set<string>();
  const htmlRows = await mapLimit(sriResources, opts.concurrency, async (r): Promise<CheckRow[]> => {
    const rows: CheckRow[] = [];
    const name = `${r.kind} ${label(r)}`;
    if (r.url === null) return [{ check: name, result: 'FAIL', detail: 'unparseable URL' }];
    const origin = new URL(r.url).origin;
    if (!allowed.has(origin)) rows.push({ check: name, result: 'FAIL', detail: `third-party origin ${origin}` });
    if (r.integrity === null || r.integrity.trim() === '') rows.push({ check: name, result: 'FAIL', detail: 'no integrity attribute' });
    let body: Uint8Array;
    try {
      const res = await httpGet(r.url, fetchOpts);
      if (res.status !== 200) return [...rows, { check: name, result: 'FAIL', detail: `HTTP ${res.status}` }];
      body = res.body;
    } catch (err) {
      return [...rows, { check: name, result: 'FAIL', detail: `fetch failed: ${(err as Error).message}` }];
    }
    checkedUrls.add(r.url);
    const actual = sriDigest(body, 'sha384');
    if (r.integrity !== null && r.integrity.trim() !== '' && !integrityMatches(r.integrity, body)) {
      rows.push({ check: name, result: 'FAIL', detail: `content does not match its integrity attribute (served ${actual})` });
    }
    const key = manifestKeyFor(r.url, ref);
    if (key === null) {
      if (allowed.has(origin) && origin !== siteOrigin) rows.push({ check: name, result: 'INFO', detail: `allowed origin, not in manifest (${actual})` });
    } else if (!(key in ref.files)) {
      rows.push({ check: name, result: 'FAIL', detail: `${key} is not in the manifest (served ${actual})` });
    } else if (ref.files[key] !== actual) {
      rows.push({ check: name, result: 'FAIL', detail: `hash differs from manifest: served ${actual}, expected ${ref.files[key]}` });
    }
    if (!rows.some((x) => x.result === 'FAIL')) rows.push({ check: name, result: 'PASS', detail: actual });
    return rows;
  });
  checks.push(...htmlRows.flat());

  // 4. Every other file in the manifest (lazy chunks, service worker, workers).
  if (opts.scope === 'all') {
    const rest = Object.entries(ref.files).filter(
      ([path]) => path !== ref.entrypoint && !checkedUrls.has(new URL(path, siteOrigin).href),
    );
    const restRows = await mapLimit(rest, opts.concurrency, async ([path, expected]): Promise<CheckRow> => {
      const u = new URL(path, siteOrigin).href;
      try {
        const res = await httpGet(u, fetchOpts);
        if (res.status !== 200) return { check: `file ${path}`, result: 'FAIL', detail: `HTTP ${res.status}` };
        const actual = sriDigest(res.body, 'sha384');
        return actual === expected
          ? { check: `file ${path}`, result: 'PASS', detail: actual }
          : { check: `file ${path}`, result: 'FAIL', detail: `hash differs from manifest: served ${actual}, expected ${expected}` };
      } catch (err) {
        return { check: `file ${path}`, result: 'FAIL', detail: `fetch failed: ${(err as Error).message}` };
      }
    });
    checks.push(...restRows);
  }

  return {
    url: opts.url,
    checkedAt: new Date().toISOString(),
    release: manifest ? { version: manifest.version, gitCommit: manifest.gitCommit } : null,
    checks,
    failures: countFailures(checks),
  };
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseCli<{
    url?: string;
    manifest?: string[];
    scope?: string;
    'allow-origin'?: string[];
    concurrency?: string;
    'timeout-ms'?: string;
    'user-agent'?: string;
    json?: boolean;
  }>(argv, {
    url: { type: 'string' },
    manifest: { type: 'string', multiple: true },
    scope: { type: 'string' },
    'allow-origin': { type: 'string', multiple: true },
    concurrency: { type: 'string' },
    'timeout-ms': { type: 'string' },
    'user-agent': { type: 'string' },
    json: { type: 'boolean' },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_OK;
  }
  if (values.url === undefined) throw new UsageError('--url is required');
  if (values.manifest === undefined || values.manifest.length === 0) throw new UsageError('--manifest is required');
  const scope = values.scope ?? 'all';
  if (scope !== 'html' && scope !== 'all') throw new UsageError('--scope must be html or all');
  const allowOrigins = (values['allow-origin'] ?? []).map((o) => {
    try {
      return new URL(o).origin;
    } catch {
      throw new UsageError(`--allow-origin ${o} is not a URL origin`);
    }
  });
  const timeoutMs = parsePositiveInt('timeout-ms', values['timeout-ms'], 15_000);
  const manifests = await Promise.all(values.manifest.map((m) => loadManifest(m, timeoutMs)));

  const report = await monitorDeploy({
    url: values.url,
    manifests,
    scope,
    allowOrigins,
    concurrency: parsePositiveInt('concurrency', values.concurrency, 8),
    timeoutMs,
    ...(values['user-agent'] !== undefined ? { userAgent: values['user-agent'] } : {}),
  });

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const rel = report.release ? `release ${report.release.version} (${report.release.gitCommit.slice(0, 12)})` : 'UNKNOWN RELEASE';
    process.stdout.write(
      `monitor-deploy ${report.url} ${rel} (${report.checkedAt})\n\n${renderChecks(report.checks)}\n\n` +
        `${report.checks.length} check(s), ${report.failures} FAIL(s)\n`,
    );
  }
  return report.failures > 0 ? EXIT_CHECK_FAILED : EXIT_OK;
}

if (import.meta.main) {
  await runCli(USAGE, () => main(process.argv.slice(2)));
}

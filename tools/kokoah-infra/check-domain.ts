#!/usr/bin/env node
// check-domain: report DNSSEC, CAA and HTTP security headers for a domain as a
// PASS/FAIL table. Read-only: DNS-over-HTTPS queries and plain GET requests.
import { EXIT_CHECK_FAILED, EXIT_OK, UsageError, parseCli, parsePositiveInt, runCli } from './lib/cli.ts';
import { RESOLVERS, checkDnssec, dohClient, findRelevantCaa, type DohQuery } from './lib/dns.ts';
import { extractResources, requiresSri } from './lib/html.ts';
import { httpGet } from './lib/http.ts';
import { evaluateHeaders } from './lib/security-headers.ts';
import { countFailures, renderChecks, type CheckRow } from './lib/table.ts';

export const USAGE = `Usage: check-domain <domain> [options]

Checks a domain against the Kokoah security baseline and prints a PASS/FAIL table:
  - DNSSEC: a DS record exists for the domain's zone, and a validating resolver
    authenticates answers for the name (AD flag)
  - CAA: a CAA record set applies to the name (RFC 8659 tree climbing), with notes
    on accounturi / iodef
  - HTTP: http:// redirects to https://; HSTS, CSP, Trusted Types, framing,
    nosniff, Referrer-Policy, Permissions-Policy, COOP on the HTML response
  - SRI: every script / stylesheet / modulepreload in the HTML has an integrity attribute

Everything is read-only (DNS-over-HTTPS lookups and GET requests).

Options:
  --url <url>          Page to fetch (default: https://<domain>/)
  --resolver <name|url>  DoH JSON endpoint: cloudflare (default), google, or a URL
  --timeout-ms <n>     Per-request timeout in milliseconds (default 10000)
  --skip-http          Only run the DNS checks
  --no-fail            Always exit 0 (report only)
  --json               Print JSON instead of a table
  -h, --help           Show this help

Exit codes: 0 all checks passed, 1 at least one FAIL, 2 usage or fatal error.

Examples:
  node scripts/src/check-domain.ts example.com
  node scripts/src/check-domain.ts app.hyperliquid.xyz --resolver google --json`;

export interface CheckDomainOptions {
  domain: string;
  url: string;
  query: DohQuery;
  timeoutMs: number;
  skipHttp: boolean;
}

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

export async function dnsChecks(query: DohQuery, domain: string): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  const sec = await checkDnssec(query, domain);
  rows.push({
    check: 'DNSSEC: DS record at zone',
    result: sec.dsRecords.length > 0 ? 'PASS' : 'FAIL',
    detail:
      sec.zone === null
        ? 'could not determine the zone apex (no SOA found)'
        : sec.dsRecords.length > 0
          ? `${sec.zone}: ${sec.dsRecords.length} DS record(s)`
          : `${sec.zone}: no DS record in the parent zone (unsigned delegation)`,
  });
  rows.push({
    check: 'DNSSEC: answer validated (AD)',
    result: sec.authenticated ? 'PASS' : 'FAIL',
    detail: sec.authenticated ? 'resolver set AD=1 for the A lookup' : 'resolver did not authenticate the answer (AD=0)',
  });

  const caa = await findRelevantCaa(query, domain);
  if (caa.records.length === 0) {
    rows.push({ check: 'CAA', result: 'FAIL', detail: 'no CAA records at the name or any parent: any CA may issue certificates' });
  } else {
    const issuers = caa.records.filter((r) => r.tag === 'issue' || r.tag === 'issuewild').map((r) => `${r.tag} ${r.value || ';'}`);
    const hasIssue = caa.records.some((r) => r.tag === 'issue');
    rows.push({
      check: 'CAA',
      result: hasIssue ? 'PASS' : 'FAIL',
      detail: `at ${caa.foundAt}: ${issuers.join(' | ') || 'no issue tag'}`,
    });
    const accountBound = caa.records.some((r) => r.tag === 'issue' && /accounturi=/i.test(r.value));
    rows.push({
      check: 'CAA: accounturi binding',
      result: 'INFO',
      detail: accountBound ? 'issue restricted to a specific CA account' : 'not set (recommended: bind issuance to your ACME account)',
    });
    rows.push({
      check: 'CAA: iodef',
      result: 'INFO',
      detail: caa.records.some((r) => r.tag === 'iodef') ? 'incident reporting address set' : 'not set',
    });
  }
  return rows;
}

export async function httpChecks(domain: string, pageUrl: string, timeoutMs: number): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];

  // 1. Plain HTTP should redirect to HTTPS.
  try {
    const plain = await httpGet(`http://${domain}/`, { timeoutMs, redirect: 'manual' });
    const loc = plain.headers.get('location') ?? '';
    const ok = [301, 302, 303, 307, 308].includes(plain.status) && loc.startsWith('https://');
    rows.push({
      check: 'HTTP -> HTTPS redirect',
      result: ok ? 'PASS' : 'FAIL',
      detail: ok ? `${plain.status} -> ${loc}` : `HTTP ${plain.status}${loc ? ` -> ${loc}` : ''}`,
    });
  } catch (err) {
    rows.push({ check: 'HTTP -> HTTPS redirect', result: 'INFO', detail: `port 80 not reachable (${(err as Error).message})` });
  }

  // 2. Headers of the HTML document.
  const page = await httpGet(pageUrl, { timeoutMs });
  rows.push({ check: 'Fetch page', result: page.status === 200 ? 'PASS' : 'FAIL', detail: `HTTP ${page.status} ${page.finalUrl}` });
  rows.push(...evaluateHeaders(page.headers, page.finalUrl.startsWith('https://')));

  // 3. SRI coverage of scripts and styles referenced by the HTML.
  const contentType = page.headers.get('content-type') ?? '';
  if (contentType.includes('html')) {
    const resources = extractResources(new TextDecoder().decode(page.body), page.finalUrl).filter(requiresSri);
    const missing = resources.filter((r) => r.integrity === null || r.integrity.trim() === '');
    const origin = new URL(page.finalUrl).origin;
    const thirdParty = resources.filter((r) => r.kind === 'script' && r.url !== null && new URL(r.url).origin !== origin);
    rows.push({
      check: 'SRI on scripts/styles',
      result: resources.length > 0 && missing.length === 0 ? 'PASS' : missing.length > 0 ? 'FAIL' : 'INFO',
      detail:
        resources.length === 0
          ? 'no external scripts or styles in the HTML'
          : `${resources.length - missing.length}/${resources.length} have integrity${missing.length ? `; missing: ${missing.slice(0, 3).map((r) => r.ref).join(', ')}${missing.length > 3 ? ', ...' : ''}` : ''}`,
    });
    rows.push({
      check: 'Third-party scripts',
      result: thirdParty.length === 0 ? 'PASS' : 'FAIL',
      detail: thirdParty.length === 0 ? 'none in the HTML' : [...new Set(thirdParty.map((r) => new URL(r.url as string).origin))].join(', '),
    });
  } else {
    rows.push({ check: 'SRI on scripts/styles', result: 'INFO', detail: `not HTML (${contentType || 'no content-type'})` });
  }
  return rows;
}

export async function checkDomain(opts: CheckDomainOptions): Promise<CheckRow[]> {
  const rows = await dnsChecks(opts.query, opts.domain);
  if (!opts.skipHttp) rows.push(...(await httpChecks(opts.domain, opts.url, opts.timeoutMs)));
  return rows;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseCli<{
    url?: string;
    resolver?: string;
    'timeout-ms'?: string;
    'skip-http'?: boolean;
    'no-fail'?: boolean;
    json?: boolean;
  }>(
    argv,
    {
      url: { type: 'string' },
      resolver: { type: 'string' },
      'timeout-ms': { type: 'string' },
      'skip-http': { type: 'boolean' },
      'no-fail': { type: 'boolean' },
      json: { type: 'boolean' },
    },
    true,
  );
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_OK;
  }
  if (positionals.length !== 1) throw new UsageError('exactly one domain is required');
  const domain = (positionals[0] as string).toLowerCase().replace(/\.$/, '');
  if (!DOMAIN_RE.test(domain)) throw new UsageError(`not a valid domain name: ${domain}`);
  const timeoutMs = parsePositiveInt('timeout-ms', values['timeout-ms'], 10_000);
  const resolverArg = values.resolver ?? 'cloudflare';
  const endpoint = RESOLVERS[resolverArg] ?? resolverArg;
  if (!endpoint.startsWith('https://')) throw new UsageError('--resolver must be cloudflare, google or an https:// URL');

  const rows = await checkDomain({
    domain,
    url: values.url ?? `https://${domain}/`,
    query: dohClient(endpoint, timeoutMs),
    timeoutMs,
    skipHttp: values['skip-http'] === true,
  });
  const failures = countFailures(rows);
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ domain, checkedAt: new Date().toISOString(), failures, checks: rows }, null, 2)}\n`);
  } else {
    process.stdout.write(`check-domain ${domain} (${new Date().toISOString()})\n\n${renderChecks(rows)}\n\n${failures} FAIL(s)\n`);
  }
  return failures > 0 && values['no-fail'] !== true ? EXIT_CHECK_FAILED : EXIT_OK;
}

if (import.meta.main) {
  await runCli(USAGE, () => main(process.argv.slice(2)));
}

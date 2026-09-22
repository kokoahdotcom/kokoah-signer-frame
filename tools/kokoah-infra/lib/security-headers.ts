// Pure evaluation of HTTP security headers against the Kokoah baseline
// (docs/SECURITY_BASELINE.md §3). Each function returns one table row.
import type { CheckRow } from './table.ts';

export type HeaderGetter = (name: string) => string | null;

export function headerGetter(headers: Headers | Record<string, string>): HeaderGetter {
  if (headers instanceof Headers) return (n) => headers.get(n);
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return (n) => lower[n.toLowerCase()] ?? null;
}

export type CspPolicy = Map<string, string[]>;

/** Parse a CSP header value. A comma separates multiple policies (all are enforced). */
export function parseCsp(value: string): CspPolicy[] {
  return value
    .split(',')
    .map((policy) => {
      const map: CspPolicy = new Map();
      for (const part of policy.split(';')) {
        const tokens = part.trim().split(/\s+/).filter(Boolean);
        const name = tokens[0]?.toLowerCase();
        if (name === undefined || map.has(name)) continue; // first directive wins
        map.set(name, tokens.slice(1));
      }
      return map;
    })
    .filter((p) => p.size > 0);
}

/** Effective script sources: script-src, falling back to default-src. */
function scriptSources(p: CspPolicy): string[] | undefined {
  return p.get('script-src') ?? p.get('default-src');
}

function isNonceOrHash(src: string): boolean {
  return /^'(nonce-|sha256-|sha384-|sha512-)/i.test(src);
}

/** Problems with one policy's script controls; empty means strict enough. */
export function scriptPolicyProblems(p: CspPolicy): string[] {
  const problems: string[] = [];
  const srcs = scriptSources(p);
  if (srcs === undefined) return ['no script-src or default-src'];
  const lower = srcs.map((s) => s.toLowerCase());
  const hasNonceOrHash = lower.some(isNonceOrHash);
  // With a nonce or hash present, browsers ignore 'unsafe-inline'.
  if (lower.includes("'unsafe-inline'") && !hasNonceOrHash) problems.push("script-src allows 'unsafe-inline'");
  if (lower.includes("'unsafe-eval'")) problems.push("script-src allows 'unsafe-eval'");
  const broad = lower.filter((s) => s === '*' || s === 'https:' || s === 'http:' || s === 'data:' || s === 'blob:');
  if (broad.length > 0 && !lower.includes("'strict-dynamic'")) problems.push(`script-src allows ${broad.join(' ')}`);
  const objectSrc = p.get('object-src') ?? p.get('default-src');
  if (!(objectSrc?.length === 1 && objectSrc[0] === "'none'")) problems.push("object-src is not 'none'");
  if (!p.has('base-uri')) problems.push('base-uri not set');
  return problems;
}

export function checkCsp(get: HeaderGetter): CheckRow {
  const raw = get('content-security-policy');
  if (raw === null) {
    const ro = get('content-security-policy-report-only');
    return {
      check: 'Content-Security-Policy',
      result: 'FAIL',
      detail: ro === null ? 'missing' : 'only Report-Only is set (not enforced)',
    };
  }
  const policies = parseCsp(raw);
  const perPolicy = policies.map(scriptPolicyProblems);
  // All enforced policies apply, so the strictest one decides.
  const best = perPolicy.reduce<string[] | null>((a, b) => (a === null || b.length < a.length ? b : a), null) ?? ['empty policy'];
  if (best.length === 0) return { check: 'Content-Security-Policy', result: 'PASS', detail: 'script-src strict; object-src none; base-uri set' };
  return { check: 'Content-Security-Policy', result: 'FAIL', detail: best.join('; ') };
}

export function checkTrustedTypes(get: HeaderGetter): CheckRow {
  const raw = get('content-security-policy');
  const on = raw !== null && parseCsp(raw).some((p) => (p.get('require-trusted-types-for') ?? []).includes("'script'"));
  return {
    check: 'Trusted Types',
    result: on ? 'PASS' : 'FAIL',
    detail: on ? "require-trusted-types-for 'script'" : "CSP lacks require-trusted-types-for 'script'",
  };
}

export function checkFraming(get: HeaderGetter): CheckRow {
  const raw = get('content-security-policy');
  const fa = raw === null ? undefined : parseCsp(raw).map((p) => p.get('frame-ancestors')).find((v) => v !== undefined);
  const xfo = get('x-frame-options');
  if (fa !== undefined) return { check: 'Framing (clickjacking)', result: 'PASS', detail: `frame-ancestors ${fa.join(' ')}` };
  if (xfo !== null && /^(deny|sameorigin)$/i.test(xfo.trim())) return { check: 'Framing (clickjacking)', result: 'PASS', detail: `X-Frame-Options ${xfo}` };
  return { check: 'Framing (clickjacking)', result: 'FAIL', detail: 'no frame-ancestors and no valid X-Frame-Options' };
}

export const HSTS_MIN_MAX_AGE = 31_536_000; // one year

export function checkHsts(get: HeaderGetter, isHttps: boolean): CheckRow {
  const raw = get('strict-transport-security');
  if (!isHttps) return { check: 'Strict-Transport-Security', result: 'FAIL', detail: 'page not served over HTTPS' };
  if (raw === null) return { check: 'Strict-Transport-Security', result: 'FAIL', detail: 'missing' };
  const maxAge = Number(/max-age\s*=\s*"?(\d+)"?/i.exec(raw)?.[1] ?? 'NaN');
  const flags = [/includesubdomains/i.test(raw) ? 'includeSubDomains' : null, /preload/i.test(raw) ? 'preload' : null].filter(Boolean).join(', ');
  if (!(maxAge >= HSTS_MIN_MAX_AGE)) return { check: 'Strict-Transport-Security', result: 'FAIL', detail: `max-age ${Number.isNaN(maxAge) ? 'missing' : maxAge} < ${HSTS_MIN_MAX_AGE}` };
  return { check: 'Strict-Transport-Security', result: 'PASS', detail: `max-age=${maxAge}${flags ? `; ${flags}` : ''}` };
}

export function checkNosniff(get: HeaderGetter): CheckRow {
  const v = get('x-content-type-options');
  const ok = v !== null && v.trim().toLowerCase() === 'nosniff';
  return { check: 'X-Content-Type-Options', result: ok ? 'PASS' : 'FAIL', detail: v ?? 'missing' };
}

const WEAK_REFERRER = new Set(['unsafe-url', 'no-referrer-when-downgrade', 'origin-when-cross-origin']);

export function checkReferrer(get: HeaderGetter): CheckRow {
  const v = get('referrer-policy');
  if (v === null) return { check: 'Referrer-Policy', result: 'FAIL', detail: 'missing (browser default applies)' };
  // The last recognised token wins in browsers.
  const last = v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).at(-1) ?? '';
  return { check: 'Referrer-Policy', result: WEAK_REFERRER.has(last) ? 'FAIL' : 'PASS', detail: v };
}

export function checkPermissionsPolicy(get: HeaderGetter): CheckRow {
  const v = get('permissions-policy');
  return { check: 'Permissions-Policy', result: v === null ? 'FAIL' : 'PASS', detail: v === null ? 'missing' : `${v.split(',').length} feature(s) restricted` };
}

export function checkCoop(get: HeaderGetter): CheckRow {
  const v = get('cross-origin-opener-policy');
  const ok = v !== null && /^(same-origin|same-origin-allow-popups|noopener-allow-popups)$/i.test(v.trim());
  return { check: 'Cross-Origin-Opener-Policy', result: ok ? 'PASS' : 'FAIL', detail: v ?? 'missing' };
}

export function evaluateHeaders(headers: Headers | Record<string, string>, isHttps: boolean): CheckRow[] {
  const get = headerGetter(headers);
  return [
    checkHsts(get, isHttps),
    checkCsp(get),
    checkTrustedTypes(get),
    checkFraming(get),
    checkNosniff(get),
    checkReferrer(get),
    checkPermissionsPolicy(get),
    checkCoop(get),
  ];
}

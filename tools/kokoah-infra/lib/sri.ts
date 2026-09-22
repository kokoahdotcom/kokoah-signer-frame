// Subresource Integrity helpers (https://www.w3.org/TR/SRI/).
import { createHash } from 'node:crypto';

export type SriAlgorithm = 'sha256' | 'sha384' | 'sha512';
const STRENGTH: Record<SriAlgorithm, number> = { sha256: 1, sha384: 2, sha512: 3 };

/** Returns e.g. "sha384-<base64>". */
export function sriDigest(bytes: Uint8Array, alg: SriAlgorithm = 'sha384'): string {
  return `${alg}-${createHash(alg).update(bytes).digest('base64')}`;
}

export interface IntegrityEntry {
  alg: SriAlgorithm;
  /** Full token without options, e.g. "sha384-abc...". */
  token: string;
}

/**
 * Parse an integrity attribute value. Unknown algorithms and malformed tokens are
 * ignored, as browsers do. Options after "?" are dropped.
 */
export function parseIntegrity(value: string): IntegrityEntry[] {
  const out: IntegrityEntry[] = [];
  for (const raw of value.trim().split(/\s+/)) {
    if (raw === '') continue;
    const token = raw.split('?')[0] ?? '';
    const m = /^(sha256|sha384|sha512)-([A-Za-z0-9+/_-]+={0,2})$/.exec(token);
    if (m === null) continue;
    out.push({ alg: m[1] as SriAlgorithm, token });
  }
  return out;
}

/**
 * Browser matching rule: only the strongest algorithm present counts, and the
 * resource matches if its digest equals any token of that algorithm.
 * Returns false when the attribute has no usable token (browsers would then not
 * enforce anything, which Kokoah treats as a failure).
 */
export function integrityMatches(value: string, bytes: Uint8Array): boolean {
  const entries = parseIntegrity(value);
  if (entries.length === 0) return false;
  const strongest = entries.reduce((a, b) => (STRENGTH[b.alg] > STRENGTH[a.alg] ? b : a)).alg;
  const actual = sriDigest(bytes, strongest);
  return entries.some((e) => e.alg === strongest && e.token === actual);
}

export function isSriToken(value: string, alg?: SriAlgorithm): boolean {
  const entries = parseIntegrity(value);
  return entries.length === 1 && entries[0]?.token === value && (alg === undefined || entries[0].alg === alg);
}

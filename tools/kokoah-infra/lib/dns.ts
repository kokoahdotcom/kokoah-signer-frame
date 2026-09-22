// DNS lookups over HTTPS (DoH, JSON API). Node's built-in resolver cannot query
// DS records and does not expose the DNSSEC "AD" (authenticated data) flag, so we
// ask a validating public resolver instead. Read-only.
import { getJson } from './http.ts';

export const RR = { A: 1, NS: 2, CNAME: 5, SOA: 6, AAAA: 28, DS: 43, DNSKEY: 48, CAA: 257 } as const;
export type RRType = keyof typeof RR;

export interface DohRecord {
  name: string;
  type: number;
  TTL?: number;
  data: string;
}

export interface DohResponse {
  Status: number;
  AD?: boolean;
  Answer?: DohRecord[];
  Authority?: DohRecord[];
}

export type DohQuery = (name: string, type: RRType) => Promise<DohResponse>;

export const RESOLVERS: Record<string, string> = {
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/resolve',
};

export function dohClient(endpoint: string, timeoutMs: number): DohQuery {
  return async (name, type) => {
    // do=1 (DNSSEC OK) is required for a reliable AD flag: without it Cloudflare's
    // resolver intermittently returned AD=0 for signed names (observed 2026-09-21).
    const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type}&do=1`;
    return getJson<DohResponse>(url, { timeoutMs, accept: 'application/dns-json' });
  };
}

/** Lower-case and strip the trailing dot some resolvers return. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

function answersOfType(res: DohResponse, type: RRType): DohRecord[] {
  return (res.Answer ?? []).filter((r) => r.type === RR[type]);
}

/**
 * Find the zone apex that contains `name`: the owner of the SOA record in the
 * answer (name is an apex) or in the authority section (name is inside a zone).
 */
export async function findZoneApex(query: DohQuery, name: string): Promise<string | null> {
  const res = await query(name, 'SOA');
  const soa = [...answersOfType(res, 'SOA'), ...(res.Authority ?? []).filter((r) => r.type === RR.SOA)][0];
  return soa ? normalizeName(soa.name) : null;
}

export interface DnssecResult {
  zone: string | null;
  dsRecords: string[];
  /** Resolver validated the answer for the queried name. */
  authenticated: boolean;
}

export async function checkDnssec(query: DohQuery, name: string): Promise<DnssecResult> {
  const zone = await findZoneApex(query, name);
  const ds = zone === null ? [] : answersOfType(await query(zone, 'DS'), 'DS').map((r) => r.data);
  const a = await query(name, 'A');
  return { zone, dsRecords: ds, authenticated: a.AD === true };
}

export interface CaaRecord {
  flags: number;
  tag: string;
  value: string;
}

/**
 * Parse CAA RDATA as returned by DoH JSON APIs: either presentation format
 * (`0 issue "letsencrypt.org"`) or RFC 3597 generic hex (`\# 22 00 05 69 73 ...`).
 */
export function parseCaa(data: string): CaaRecord | null {
  const generic = /^\\#\s+\d+\s+([0-9a-fA-F\s]+)$/.exec(data.trim());
  if (generic !== null) {
    const bytes = Buffer.from((generic[1] ?? '').replace(/\s+/g, ''), 'hex');
    if (bytes.length < 2) return null;
    const flags = bytes[0] ?? 0;
    const tagLen = bytes[1] ?? 0;
    const tag = bytes.subarray(2, 2 + tagLen).toString('ascii').toLowerCase();
    const value = bytes.subarray(2 + tagLen).toString('utf8');
    return { flags, tag, value };
  }
  const m = /^(\d+)\s+([A-Za-z0-9]+)\s+"?(.*?)"?$/.exec(data.trim());
  if (m === null) return null;
  return { flags: Number(m[1]), tag: (m[2] ?? '').toLowerCase(), value: (m[3] ?? '').replace(/\\"/g, '"') };
}

export interface CaaResult {
  /** The name at which the relevant CAA RRset was found (RFC 8659 tree climbing). */
  foundAt: string | null;
  records: CaaRecord[];
}

/**
 * RFC 8659 §3: the relevant RRset is the first non-empty CAA RRset found by
 * climbing from the name towards the root. We stop before the TLD.
 */
export async function findRelevantCaa(query: DohQuery, name: string): Promise<CaaResult> {
  const labels = normalizeName(name).split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    const records = answersOfType(await query(candidate, 'CAA'), 'CAA')
      .map((r) => parseCaa(r.data))
      .filter((r): r is CaaRecord => r !== null);
    if (records.length > 0) return { foundAt: candidate, records };
  }
  return { foundAt: null, records: [] };
}

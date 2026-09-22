// Read-only HTTP helpers built on the global fetch (Node 24). GET/HEAD only.

export const DEFAULT_USER_AGENT = 'kokoah-infra-scripts/0.1 (read-only monitor)';
/** Refuse bodies larger than this, so a hostile server cannot exhaust memory. */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;

export interface FetchOptions {
  timeoutMs: number;
  userAgent?: string;
  /** 'follow' (default) or 'manual' to inspect redirects yourself. */
  redirect?: 'follow' | 'manual';
  accept?: string;
}

export interface FetchedBody {
  url: string;
  finalUrl: string;
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export async function httpGet(url: string, opts: FetchOptions): Promise<FetchedBody> {
  const headers: Record<string, string> = {
    'user-agent': opts.userAgent ?? DEFAULT_USER_AGENT,
  };
  if (opts.accept !== undefined) headers['accept'] = opts.accept;
  const res = await fetch(url, {
    method: 'GET',
    headers,
    redirect: opts.redirect ?? 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  const body = await readLimited(res, MAX_BODY_BYTES);
  return { url, finalUrl: res.url || url, status: res.status, headers: res.headers, body };
}

async function readLimited(res: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > limit) {
    await res.body?.cancel();
    throw new Error(`response from ${res.url} is too large (${declared} bytes > ${limit})`);
  }
  if (res.body === null) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > limit) {
      await res.body.cancel();
      throw new Error(`response from ${res.url} exceeded ${limit} bytes`);
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function getJson<T>(url: string, opts: FetchOptions): Promise<T> {
  const res = await httpGet(url, { ...opts, accept: opts.accept ?? 'application/json' });
  if (res.status !== 200) throw new Error(`GET ${url} returned HTTP ${res.status}`);
  try {
    return JSON.parse(new TextDecoder().decode(res.body)) as T;
  } catch {
    throw new Error(`GET ${url} did not return valid JSON`);
  }
}

/** Run async tasks with a concurrency limit, preserving input order in the result. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Minimal Hyperliquid HTTP client for the frame: `POST /info` (read-only) and `POST /exchange` (signed actions).
 * Timeouts, a response size cap, no credentials, no referrer, no redirects. The CSP `connect-src` allows only the
 * HL API origin, so even injected code can't reach anything else with `fetch`.
 *
 * @module
 */
import type { ExchangeRequestBody } from "@kokoah/shared/signing";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Thrown by {@link HlHttp.info} on any failure (network, timeout, HTTP error, non-JSON, oversize). */
export class HlInfoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HlInfoError";
  }
}

/** Result of {@link HlHttp.exchange}. */
export type ExchangeTransportResult =
  /** HL answered; `body` is the parsed JSON (or the raw text when it wasn't JSON). */
  | { kind: "response"; httpStatus: number; body: unknown }
  /** The request may or may not have reached HL. */
  | { kind: "unknown"; reason: string };

export interface HlHttpOptions {
  fetch: FetchLike;
  infoUrl: string;
  exchangeUrl: string;
  infoTimeoutMs?: number;
  exchangeTimeoutMs?: number;
  maxResponseBytes?: number;
}

const COMMON_INIT: RequestInit = {
  method: "POST",
  headers: { "content-type": "application/json" },
  credentials: "omit",
  cache: "no-store",
  redirect: "error",
  referrerPolicy: "no-referrer",
  mode: "cors",
};

export class HlHttp {
  private readonly opts: Required<HlHttpOptions>;

  constructor(options: HlHttpOptions) {
    this.opts = {
      infoTimeoutMs: 8_000,
      exchangeTimeoutMs: 10_000,
      maxResponseBytes: 8 * 1024 * 1024,
      ...options,
    };
  }

  /** `POST /info`. Returns parsed JSON. */
  async info(body: Record<string, unknown>): Promise<unknown> {
    let res: Response;
    try {
      res = await this.opts.fetch(this.opts.infoUrl, { ...COMMON_INIT, body: JSON.stringify(body), signal: AbortSignal.timeout(this.opts.infoTimeoutMs) });
    } catch (e) {
      throw new HlInfoError(`HL /info ${String(body.type)} failed: ${errorName(e)}`);
    }
    const text = await this.readCapped(res).catch((e: unknown) => {
      throw new HlInfoError(`HL /info ${String(body.type)} failed while reading: ${errorName(e)}`);
    });
    if (!res.ok) throw new HlInfoError(`HL /info ${String(body.type)} returned HTTP ${res.status}`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HlInfoError(`HL /info ${String(body.type)} returned non-JSON`);
    }
  }

  /**
   * `POST /exchange`. Never throws: transport failures and 5xx answers are reported as `unknown` (the action may have
   * been processed), everything else as a `response`.
   */
  async exchange(body: ExchangeRequestBody): Promise<ExchangeTransportResult> {
    let res: Response;
    try {
      res = await this.opts.fetch(this.opts.exchangeUrl, { ...COMMON_INIT, body: JSON.stringify(body), signal: AbortSignal.timeout(this.opts.exchangeTimeoutMs) });
    } catch (e) {
      return { kind: "unknown", reason: `request failed: ${errorName(e)}` };
    }
    let text: string;
    try {
      text = await this.readCapped(res);
    } catch (e) {
      return { kind: "unknown", reason: `reading the response failed: ${errorName(e)}` };
    }
    if (res.status >= 500) return { kind: "unknown", reason: `HTTP ${res.status}` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      // 4xx: HL (or its CDN) refused the request; it was not processed.
      const msg = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      return { kind: "response", httpStatus: res.status, body: res.status === 429 ? `HTTP 429: rate limit exceeded. ${msg}` : `HTTP ${res.status}: ${msg}` };
    }
    return { kind: "response", httpStatus: res.status, body: parsed };
  }

  private async readCapped(res: Response): Promise<string> {
    const declared = Number(res.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > this.opts.maxResponseBytes) throw new RangeError("response too large");
    const text = await res.text();
    if (text.length > this.opts.maxResponseBytes) throw new RangeError("response too large");
    return text;
  }
}

/** A short, secret-free description of an error (its name, or "error"). */
export function errorName(e: unknown): string {
  if (e instanceof Error) return e.name === "Error" ? "Error" : e.name;
  return "error";
}

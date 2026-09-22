/**
 * The frame's own market data. Prices, market metadata and the registry are **never** taken from the parent: the
 * frame fetches them from Hyperliquid `/info` itself, per perp dex (HIP-3 dexes separately), and caches them briefly.
 *
 * - `metaAndAssetCtxs` (per dex) gives the dex's `meta` (for `MarketRegistry`) and each asset's mark and mid price.
 * - `perpDexs` gives dex indices, needed for HIP-3 asset ids (cached longer; the registry cross-checks names).
 * - `activeAssetData` gives the user's current leverage for a market (only needed when the parent tightened
 *   `maxLeverage` below the market maximum).
 *
 * @module
 */
import { MarketRegistry, parseCoin, type PerpDexLike, type PerpMetaLike } from "@kokoah/shared/markets";
import type { HlHttp } from "./hl.js";

/** Everything the signing pipeline needs about the markets an intent touches. */
export interface MarketSnapshot {
  registry: MarketRegistry;
  /** Mark price by coin (policy: price band, notional). */
  markPrices: Record<string, number>;
  /** Mid price by coin (compiler: market-order IOC price). Missing when the book is empty. */
  midPrices: Record<string, string>;
}

/** Thrown when market data can't be fetched or is malformed. */
export class MarketDataError extends Error {
  readonly code: "MARKET_DATA_UNAVAILABLE" | "UNKNOWN_DEX" | "UNSUPPORTED_MARKET";
  constructor(code: MarketDataError["code"], message: string) {
    super(message);
    this.name = "MarketDataError";
    this.code = code;
  }
}

interface DexSnapshot {
  meta: PerpMetaLike;
  markPrices: Record<string, number>;
  midPrices: Record<string, string>;
}

interface CacheEntry<T> {
  at: number;
  value: Promise<T>;
}

export interface MarketDataOptions {
  hl: HlHttp;
  now: () => number;
  /** TTL of mark/mid prices and dex metadata. Default 3 s. */
  priceTtlMs?: number;
  /** TTL of the `perpDexs` list. Default 60 s. */
  dexListTtlMs?: number;
  /** TTL of the user's leverage per market. Default 3 s. */
  leverageTtlMs?: number;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function positiveNumber(x: unknown): number | undefined {
  if (typeof x !== "string" && typeof x !== "number") return undefined;
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export class MarketData {
  private readonly opts: Required<MarketDataOptions>;
  private readonly dexCache = new Map<string, CacheEntry<DexSnapshot>>();
  private perpDexsCache: CacheEntry<ReadonlyArray<PerpDexLike>> | undefined;
  private readonly leverageCache = new Map<string, CacheEntry<number | undefined>>();

  constructor(options: MarketDataOptions) {
    this.opts = { priceTtlMs: 3_000, dexListTtlMs: 60_000, leverageTtlMs: 3_000, ...options };
  }

  /** Registry, mark and mid prices covering every coin in `coins` (perps and HIP-3 only). */
  async snapshotFor(coins: readonly string[]): Promise<MarketSnapshot> {
    const dexes = new Set<string>();
    for (const coin of coins) {
      const parsed = parseCoin(coin);
      if (!parsed) throw new MarketDataError("UNSUPPORTED_MARKET", `"${coin}" is not a valid market name`);
      if (parsed.kind !== "perp" && parsed.kind !== "hip3") {
        throw new MarketDataError("UNSUPPORTED_MARKET", `${coin} is not a perpetual market; the signer frame trades perps and HIP-3 perps only`);
      }
      dexes.add(parsed.kind === "hip3" ? parsed.dex : "");
    }
    if (dexes.size === 0) dexes.add("");
    const hip3 = [...dexes].filter((d) => d !== "");
    const perpDexs = hip3.length > 0 ? await this.perpDexs() : undefined;
    if (perpDexs) {
      for (const d of hip3) {
        if (!perpDexs.some((x, i) => i > 0 && x !== null && x.name === d)) throw new MarketDataError("UNKNOWN_DEX", `Unknown HIP-3 dex "${d}"`);
      }
    }
    const snaps = await Promise.all([...dexes].map(async (d) => [d, await this.dex(d)] as const));
    const markPrices: Record<string, number> = {};
    const midPrices: Record<string, string> = {};
    const dexMetas: Record<string, PerpMetaLike> = {};
    let meta: PerpMetaLike | undefined;
    for (const [d, s] of snaps) {
      Object.assign(markPrices, s.markPrices);
      Object.assign(midPrices, s.midPrices);
      if (d === "") meta = s.meta;
      else dexMetas[d] = s.meta;
    }
    let registry: MarketRegistry;
    try {
      registry = MarketRegistry.fromInfo({
        ...(meta ? { meta } : {}),
        ...(hip3.length > 0 ? { dexMetas, perpDexs: perpDexs as ReadonlyArray<PerpDexLike> } : {}),
      });
    } catch (e) {
      throw new MarketDataError("MARKET_DATA_UNAVAILABLE", `Inconsistent market metadata: ${e instanceof Error ? e.message : "error"}`);
    }
    return { registry, markPrices, midPrices };
  }

  /** The user's current leverage setting for `coin`, or undefined when HL doesn't report one. */
  async leverageFor(user: `0x${string}`, coin: string): Promise<number | undefined> {
    const key = `${user}|${coin}`;
    return await this.cached(this.leverageCache, key, this.opts.leverageTtlMs, async () => {
      const r = await this.opts.hl.info({ type: "activeAssetData", user, coin });
      if (!isRecord(r) || !isRecord(r.leverage)) throw new MarketDataError("MARKET_DATA_UNAVAILABLE", "Malformed activeAssetData response");
      const value = r.leverage.value;
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
    });
  }

  private async perpDexs(): Promise<ReadonlyArray<PerpDexLike>> {
    const now = this.opts.now();
    if (this.perpDexsCache && now - this.perpDexsCache.at < this.opts.dexListTtlMs) return await this.perpDexsCache.value;
    const value = (async () => {
      const r = await this.opts.hl.info({ type: "perpDexs" });
      if (!Array.isArray(r) || r.length === 0) throw new MarketDataError("MARKET_DATA_UNAVAILABLE", "Malformed perpDexs response");
      for (const d of r) {
        if (d !== null && (!isRecord(d) || typeof d.name !== "string")) throw new MarketDataError("MARKET_DATA_UNAVAILABLE", "Malformed perpDexs entry");
      }
      return r as ReadonlyArray<PerpDexLike>;
    })();
    this.perpDexsCache = { at: now, value };
    value.catch(() => {
      if (this.perpDexsCache?.value === value) this.perpDexsCache = undefined;
    });
    return await value;
  }

  private async dex(dex: string): Promise<DexSnapshot> {
    return await this.cached(this.dexCache, dex, this.opts.priceTtlMs, async () => {
      const r = await this.opts.hl.info(dex === "" ? { type: "metaAndAssetCtxs" } : { type: "metaAndAssetCtxs", dex });
      if (!Array.isArray(r) || r.length !== 2 || !isRecord(r[0]) || !Array.isArray(r[0].universe) || !Array.isArray(r[1])) {
        throw new MarketDataError("MARKET_DATA_UNAVAILABLE", `Malformed metaAndAssetCtxs response for dex "${dex}"`);
      }
      const meta = r[0] as unknown as PerpMetaLike;
      const ctxs = r[1] as unknown[];
      if (ctxs.length !== meta.universe.length) throw new MarketDataError("MARKET_DATA_UNAVAILABLE", `Asset contexts don't match the universe for dex "${dex}"`);
      const markPrices: Record<string, number> = {};
      const midPrices: Record<string, string> = {};
      meta.universe.forEach((u, i) => {
        const ctx = ctxs[i];
        if (!isRecord(u) || typeof u.name !== "string" || !isRecord(ctx)) return;
        const mark = positiveNumber(ctx.markPx);
        if (mark !== undefined) markPrices[u.name] = mark;
        if (positiveNumber(ctx.midPx) !== undefined) midPrices[u.name] = String(ctx.midPx);
      });
      return { meta, markPrices, midPrices };
    });
  }

  private async cached<T>(map: Map<string, CacheEntry<T>>, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const now = this.opts.now();
    const hit = map.get(key);
    if (hit && now - hit.at < ttl) return await hit.value;
    const value = load();
    map.set(key, { at: now, value });
    value.catch(() => {
      if (map.get(key)?.value === value) map.delete(key);
    });
    try {
      return await value;
    } catch (e) {
      if (e instanceof MarketDataError) throw e;
      throw new MarketDataError("MARKET_DATA_UNAVAILABLE", e instanceof Error ? e.message : "Market data unavailable");
    }
  }
}

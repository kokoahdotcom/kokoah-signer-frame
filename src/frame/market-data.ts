/**
 * The frame's own market data. Prices, market metadata and the registry are **never** taken from the parent: the
 * frame fetches them from Hyperliquid `/info` itself, per perp dex (HIP-3 dexes separately), and caches them briefly.
 *
 * - `metaAndAssetCtxs` (per dex) gives the dex's `meta` (for `MarketRegistry`) and each asset's mark and mid price.
 * - `perpDexs` gives dex indices, needed for HIP-3 asset ids (cached longer; the registry cross-checks names).
 * - `activeAssetData` gives the user's current leverage for a market (only needed when the parent tightened
 *   `maxLeverage` below the market maximum).
 * - `spotMetaAndAssetCtxs` (Convert and spot trading) gives the spot pairs, their mark and mid and 24 h volume. Only
 *   the network's pinned pairs (stablecoins and verified tokens against USDC) that this `spotMeta` confirms exactly
 *   (`verifiedSpotPairs`) enter the registry; any other spot coin is `UNSUPPORTED_MARKET`.
 *
 * @module
 */
import { MarketRegistry, parseCoin, type PerpDexLike, type PerpMetaLike, type SpotMetaLike } from "@kokoah/shared/markets";
import { STABLECOIN_PAIRS, VERIFIED_SPOT_PAIRS, verifiedSpotPairs } from "@kokoah/shared/policy";
import type { HlHttp } from "./hl.js";

/** Everything the signing pipeline needs about the markets an intent touches. */
export interface MarketSnapshot {
  registry: MarketRegistry;
  /** Mark price by coin (policy: price band, notional). */
  markPrices: Record<string, number>;
  /** Mid price by coin (compiler: market-order IOC price). Missing when the book is empty. */
  midPrices: Record<string, string>;
  /** 24 h notional volume (USD) by spot coin in the registry (the per-order cap on verified pairs). */
  spotDayVolumes: Record<string, number>;
  /** Verified (non-stablecoin) spot pairs in the registry. */
  verifiedSpotCoins: string[];
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
  /** Network whose pinned stablecoin pairs Convert may trade. Default testnet. */
  network?: "mainnet" | "testnet";
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

interface SpotSnapshot {
  /** `spotMeta` narrowed to the pinned pairs it confirms and their tokens. */
  meta: SpotMetaLike;
  markPrices: Record<string, number>;
  midPrices: Record<string, string>;
  dayVolumes: Record<string, number>;
  /** Confirmed pairs that are verified tokens (not stablecoins). */
  verified: string[];
}

export class MarketData {
  private readonly opts: Required<MarketDataOptions>;
  private readonly dexCache = new Map<string, CacheEntry<DexSnapshot>>();
  private readonly spotCache = new Map<string, CacheEntry<SpotSnapshot>>();
  private perpDexsCache: CacheEntry<ReadonlyArray<PerpDexLike>> | undefined;
  private readonly leverageCache = new Map<string, CacheEntry<number | undefined>>();

  constructor(options: MarketDataOptions) {
    this.opts = { priceTtlMs: 3_000, dexListTtlMs: 60_000, leverageTtlMs: 3_000, network: "testnet", ...options };
  }

  /** Coins of the network's pinned stablecoin pairs (Convert). */
  get stablecoinPairCoins(): string[] {
    return STABLECOIN_PAIRS[this.opts.network].map((p) => p.coin);
  }

  /** Coins of the network's pinned verified token/USDC pairs (spot trading, once the user turns it on). */
  get tradingPairCoins(): string[] {
    return VERIFIED_SPOT_PAIRS[this.opts.network].map((p) => p.coin);
  }

  /** Registry, prices and spot volumes covering every coin in `coins` (perps, HIP-3 perps and the pinned spot pairs). */
  async snapshotFor(coins: readonly string[]): Promise<MarketSnapshot> {
    const dexes = new Set<string>();
    const spotCoins: string[] = [];
    for (const coin of coins) {
      const parsed = parseCoin(coin);
      if (!parsed) throw new MarketDataError("UNSUPPORTED_MARKET", `"${coin}" is not a valid market name`);
      if (parsed.kind === "spotIndex" || parsed.kind === "spotPair") {
        if (!this.stablecoinPairCoins.includes(coin) && !this.tradingPairCoins.includes(coin)) {
          throw new MarketDataError("UNSUPPORTED_MARKET", `${coin} is not a verified spot pair; the signer frame trades verified tokens against USDC only`);
        }
        spotCoins.push(coin);
        continue;
      }
      if (parsed.kind !== "perp" && parsed.kind !== "hip3") {
        throw new MarketDataError("UNSUPPORTED_MARKET", `${coin} is not a perpetual market; the signer frame trades perps, HIP-3 perps and verified spot pairs only`);
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
    const [snaps, spot] = await Promise.all([
      Promise.all([...dexes].map(async (d) => [d, await this.dex(d)] as const)),
      spotCoins.length > 0 ? this.spot() : Promise.resolve(undefined),
    ]);
    if (spot) {
      for (const coin of spotCoins) {
        if (!spot.meta.universe.some((u) => u.name === coin)) {
          throw new MarketDataError("UNSUPPORTED_MARKET", `${coin} does not match the spot pair the signer expects on Hyperliquid; nothing was signed`);
        }
      }
    }
    const markPrices: Record<string, number> = { ...spot?.markPrices };
    const midPrices: Record<string, string> = { ...spot?.midPrices };
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
        ...(spot ? { spotMeta: spot.meta } : {}),
      });
    } catch (e) {
      throw new MarketDataError("MARKET_DATA_UNAVAILABLE", `Inconsistent market metadata: ${e instanceof Error ? e.message : "error"}`);
    }
    const spotDayVolumes: Record<string, number> = {};
    for (const coin of spotCoins) {
      const volume = spot?.dayVolumes[coin];
      if (volume !== undefined) spotDayVolumes[coin] = volume;
    }
    return { registry, markPrices, midPrices, spotDayVolumes, verifiedSpotCoins: spotCoins.filter((c) => spot?.verified.includes(c)) };
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

  /**
   * The pinned spot pairs `spotMetaAndAssetCtxs` confirms exactly: the spot meta narrowed to them (and their tokens),
   * with their mark and mid prices and 24 h volume. Contexts are matched by `coin`, never by position.
   */
  private async spot(): Promise<SpotSnapshot> {
    return await this.cached(this.spotCache, "spot", this.opts.priceTtlMs, async () => {
      const r = await this.opts.hl.info({ type: "spotMetaAndAssetCtxs" });
      if (!Array.isArray(r) || r.length !== 2 || !isRecord(r[0]) || !Array.isArray(r[0].universe) || !Array.isArray(r[0].tokens) || !Array.isArray(r[1])) {
        throw new MarketDataError("MARKET_DATA_UNAVAILABLE", "Malformed spotMetaAndAssetCtxs response");
      }
      const full = r[0] as unknown as SpotMetaLike;
      const pairs = verifiedSpotPairs(this.opts.network, full);
      const coins = new Set(pairs.map((p) => p.coin));
      const tokenIndexes = new Set(pairs.flatMap((p) => [p.base.index, p.quote.index]));
      const meta: SpotMetaLike = {
        universe: full.universe.filter((u) => coins.has(u.name)),
        tokens: full.tokens.filter((t) => tokenIndexes.has(t.index)),
      };
      const markPrices: Record<string, number> = {};
      const midPrices: Record<string, string> = {};
      const dayVolumes: Record<string, number> = {};
      for (const ctx of r[1] as unknown[]) {
        if (!isRecord(ctx) || typeof ctx.coin !== "string" || !coins.has(ctx.coin)) continue;
        const mark = positiveNumber(ctx.markPx);
        if (mark !== undefined) markPrices[ctx.coin] = mark;
        if (positiveNumber(ctx.midPx) !== undefined) midPrices[ctx.coin] = String(ctx.midPx);
        const volume = Number(ctx.dayNtlVlm);
        if ((typeof ctx.dayNtlVlm === "string" || typeof ctx.dayNtlVlm === "number") && Number.isFinite(volume) && volume >= 0) dayVolumes[ctx.coin] = volume;
      }
      return { meta, markPrices, midPrices, dayVolumes, verified: pairs.filter((p) => p.trust === "verified").map((p) => p.coin) };
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

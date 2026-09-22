/**
 * Read-only integration test against Hyperliquid TESTNET `/info`. Skipped unless HL_INTEGRATION=testnet.
 * It never calls `/exchange`: the HTTP client is wrapped so any non-/info request fails the test.
 */
import { describe, expect, it } from "vitest";
import { HlHttp, type FetchLike } from "../../src/frame/hl.js";
import { MarketData } from "../../src/frame/market-data.js";
import { testConfig } from "../helpers.js";

const enabled = process.env.HL_INTEGRATION === "testnet";

describe.skipIf(!enabled)("testnet /info (read-only)", () => {
  const network = testConfig().network;
  const readOnlyFetch: FetchLike = async (url, init) => {
    if (!url.startsWith("https://api.hyperliquid-testnet.xyz/") || !url.endsWith("/info")) throw new Error(`refusing non-/info request: ${url}`);
    return await globalThis.fetch(url, init);
  };
  const hl = new HlHttp({ fetch: readOnlyFetch, infoUrl: network.infoUrl, exchangeUrl: "https://invalid.invalid/exchange" });

  it("builds a registry with mark and mid prices for BTC and ETH", async () => {
    expect(network.name).toBe("testnet");
    const md = new MarketData({ hl, now: () => Date.now() });
    const snap = await md.snapshotFor(["BTC", "ETH"]);
    expect(snap.registry.require("BTC").assetId).toBe(3);
    expect(snap.markPrices.BTC).toBeGreaterThan(0);
    expect(snap.markPrices.ETH).toBeGreaterThan(0);
  });

  it("builds a registry for a HIP-3 market from per-dex metadata", async () => {
    const dexs = (await hl.info({ type: "perpDexs" })) as Array<{ name: string } | null>;
    const idx = dexs.findIndex((d, i) => i > 0 && d !== null);
    expect(idx).toBeGreaterThan(0);
    const dex = (dexs[idx] as { name: string }).name;
    const [meta] = (await hl.info({ type: "metaAndAssetCtxs", dex })) as [{ universe: Array<{ name: string; isDelisted?: boolean }> }];
    const live = meta.universe.findIndex((u) => !u.isDelisted);
    if (live < 0) return; // an empty dex: nothing to check
    const coin = (meta.universe[live] as { name: string }).name;
    const md = new MarketData({ hl, now: () => Date.now() });
    const snap = await md.snapshotFor([coin]);
    expect(snap.registry.require(coin).assetId).toBe(100_000 + idx * 10_000 + live);
  });

  it("reads exchangeStatus server time close to the local clock", async () => {
    const r = (await hl.info({ type: "exchangeStatus" })) as { time: number };
    expect(Math.abs(r.time - Date.now())).toBeLessThan(5 * 60_000);
  });
});

/**
 * PHASE3 SPOT: spot trading the user turns on (`setLimits({ spotTrading: true })`), on the verified token/USDC pairs
 * (shared `VERIFIED_SPOT_PAIRS`) that the frame confirms against its own `spotMetaAndAssetCtxs`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { VERIFIED_SPOT_PAIRS } from "@kokoah/shared/policy";
import { BUILDER, FrameHarness, SPOT_META, SPOT_META_AND_CTXS, subAccountEntry, testConfig, USER } from "./helpers.js";

let h: FrameHarness;
afterEach(() => h?.destroy());

const MAINNET = { VITE_HL_NETWORK: "mainnet", VITE_ALLOW_MAINNET_WRITES: "true" };
// Mock mainnet spot meta: @107 HYPE/USDC (mark 40, mid 40.01, $1M a day) and the two stablecoin pairs.
const hype = (o: Record<string, unknown> = {}) => ({ kind: "order", coin: "@107", side: "buy", orderType: "limit", size: "1", price: "39", tif: "Gtc", origin: "manual", ...o });
const market = (o: Record<string, unknown> = {}) => hype({ orderType: "market", price: undefined, tif: undefined, slippageBps: 100, ...o });
const codes = (e: { details?: { violations?: Array<{ code: string }> } }) => (e.details?.violations ?? []).map((v) => v.code);
type Ctx = { coin: string; markPx: string; midPx: string; prevDayPx: string; dayNtlVlm: string };
const CTXS = SPOT_META_AND_CTXS[1] as Ctx[];
const sent = (i: number) => h.hl.exchangeCalls[i]!.body.action as unknown as { type: string; orders: Array<Record<string, unknown>>; builder?: unknown; grouping: string };

async function mainnetTrading() {
  h = await FrameHarness.create({ config: testConfig(MAINNET) });
  await h.activeAgent();
  await h.loosen({ spotTrading: true });
}

describe("spot trading: the switch", () => {
  it("is off by default, on with setLimits({ spotTrading: true }), and off again with {}", async () => {
    h = await FrameHarness.create({ config: testConfig(MAINNET) });
    await h.ok("hello", { protocolVersion: 1 });
    const off = (await h.ok("getStatus")).policy;
    expect(off).toMatchObject({ spotTrading: false, spotCoins: ["@166", "@150"], userLimits: null });
    expect(off.spotTradingCoins).toEqual(VERIFIED_SPOT_PAIRS.mainnet.map((p) => p.coin));
    // Turning it on loosens: the user confirms in the frame.
    const on = (await h.loosen({ spotTrading: true, maxLeverage: 5 })).policy;
    expect(on.spotTrading).toBe(true);
    expect(on.spotCoins).toEqual(["@166", "@150", ...VERIFIED_SPOT_PAIRS.mainnet.map((p) => p.coin)]);
    expect(on.userLimits).toEqual({ maxLeverage: 5, spotTrading: true });
    expect((await h.loosen({ spotTrading: false })).policy.spotTrading).toBe(false);
    expect((await h.loosen({ spotTrading: true })).policy.spotTrading).toBe(true);
    // Off again only tightens: no prompt.
    const reset = (await h.ok("setLimits", {})).policy;
    expect(reset).toMatchObject({ spotTrading: false, spotCoins: ["@166", "@150"], userLimits: null });
    expect((await h.fail("setLimits", { spotTrading: "yes" })).code).toBe("INVALID_REQUEST");
  });

  it("denies a verified pair while spot trading is off, and IOC conversions keep working", async () => {
    h = await FrameHarness.create({ config: testConfig(MAINNET) });
    await h.activeAgent();
    expect(codes(await h.fail("signAndSubmit", { requestId: "s1", intent: market() }))).toEqual(["SPOT_NOT_ALLOWED"]);
    expect((await h.ok("signAndSubmit", { requestId: "s2", intent: market({ coin: "@166", size: "25", slippageBps: 50 }) })).status).toBe("ok");
    expect(h.hl.exchangeCalls).toHaveLength(1);
  });
});

describe("spot trading: orders", () => {
  it("signs market buys without a builder and market sells with it", async () => {
    await mainnetTrading();
    const buy = await h.ok("signAndSubmit", { requestId: "s1", intent: market() });
    expect(buy.status).toBe("ok");
    expect(buy.marketOrder).toEqual({ midPrice: "40.01", limitPrice: "40.41", slippageBps: 100 });
    expect(sent(0).orders).toEqual([expect.objectContaining({ a: 10_107, b: true, s: "1", r: false, t: { limit: { tif: "Ioc" } } })]);
    expect(sent(0).builder).toBeUndefined();
    expect(sent(0).grouping).toBe("na");
    await h.ok("signAndSubmit", { requestId: "s2", intent: market({ side: "sell", size: "0.5" }) });
    expect(sent(1).orders[0]).toMatchObject({ a: 10_107, b: false, s: "0.5", r: false });
    expect(sent(1).builder).toEqual({ b: BUILDER, f: 25 });
  });

  it("signs GTC, post-only and IOC limits within the bands", async () => {
    await mainnetTrading();
    for (const [i, intent] of [hype({ tif: "Gtc" }), hype({ tif: "Alo", price: "30" }), hype({ tif: "Ioc", price: "40.5" }), hype({ side: "sell", price: "45" })].entries()) {
      expect((await h.ok("signAndSubmit", { requestId: `l${i}`, intent })).status).toBe("ok");
    }
    expect(h.hl.exchangeCalls.map((c) => (c.body.action as unknown as { orders: Array<{ t: { limit: { tif: string } } }> }).orders[0]!.t.limit.tif)).toEqual(["Gtc", "Alo", "Ioc", "Gtc"]);
    expect(sent(3).builder).toEqual({ b: BUILDER, f: 25 });
    expect(sent(0).builder).toBeUndefined();
  });

  it("keeps the price bands: executes-now within 10%, resting within 50% of the frame's own mark", async () => {
    await mainnetTrading();
    const far = await h.fail("signAndSubmit", { requestId: "b1", intent: hype({ tif: "Ioc", price: "45" }) });
    expect(codes(far)).toEqual(["PRICE_OUTSIDE_BAND"]);
    expect(codes(await h.fail("signAndSubmit", { requestId: "b2", intent: hype({ tif: "Gtc", price: "15" }) }))).toEqual(["PRICE_OUTSIDE_BAND"]);
    expect((await h.ok("signAndSubmit", { requestId: "b3", intent: hype({ tif: "Gtc", price: "22" }) })).status).toBe("ok");
    expect(h.hl.exchangeCalls).toHaveLength(1);
  });

  it("denies triggers, reduce-only, TP/SL legs and modifies of spot orders", async () => {
    await mainnetTrading();
    const denied = [
      { kind: "order", coin: "@107", side: "sell", orderType: "stopMarket", triggerPrice: "36", size: "1", origin: "manual" },
      { kind: "order", coin: "@107", side: "buy", orderType: "takeProfitLimit", triggerPrice: "38", price: "38", size: "1", origin: "manual" },
      hype({ side: "sell", reduceOnly: true, price: "41" }),
      market({ stopLoss: { triggerPrice: "35", orderType: "market" } }),
      { kind: "modify", origin: "manual", target: { oid: 7 }, order: { coin: "@107", side: "buy", orderType: "limit", size: "1", price: "38", reduceOnly: false } },
    ];
    for (const [i, intent] of denied.entries()) {
      const e = await h.fail("signAndSubmit", { requestId: `d${i}`, intent });
      expect(e.code).toBe("POLICY_DENIED");
      expect(codes(e)).toContain("SPOT_NOT_ALLOWED");
    }
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("counts notional, rate and personal limits", async () => {
    h = await FrameHarness.create({ config: testConfig(MAINNET) });
    await h.activeAgent();
    await h.loosen({ spotTrading: true, maxOrderNotionalUsd: 100, maxOrdersPerMinute: 2, maxLeverage: 2, requireStopLossForNewEntries: true });
    expect(codes(await h.fail("signAndSubmit", { requestId: "n1", intent: market({ size: "3" }) }))).toEqual(["ORDER_NOTIONAL_EXCEEDED"]);
    // Leverage and stop-loss rules are about perps: no activeAssetData read, no stop needed.
    await h.ok("signAndSubmit", { requestId: "n2", intent: market() });
    await h.ok("signAndSubmit", { requestId: "n3", intent: market({ side: "sell" }) });
    expect(codes(await h.fail("signAndSubmit", { requestId: "n4", intent: market() }))).toEqual(["ORDER_RATE_EXCEEDED"]);
    expect(h.hl.infoCalls.some((c) => c.type === "activeAssetData")).toBe(false);
  });

  it("caps one mainnet order at 10% of the pair's 24 h volume, read by the frame", async () => {
    await mainnetTrading();
    h.hl.spot = [SPOT_META, CTXS.map((c) => (c.coin === "@107" ? { ...c, dayNtlVlm: "1000" } : c))];
    expect((await h.ok("signAndSubmit", { requestId: "v1", intent: market({ size: "2" }) })).status).toBe("ok");
    const e = await h.fail("signAndSubmit", { requestId: "v2", intent: market({ size: "3" }) });
    expect(codes(e)).toEqual(["ORDER_NOTIONAL_EXCEEDED"]);
    expect((e.details as { violations: Array<{ message: string }> }).violations[0]!.message).toMatch(/at most 10% of what the pair traded in the last 24 hours \(\$100\)/);
    // A pair that has not traded at all can't be ordered; stablecoin conversions are exempt.
    h.hl.spot = [SPOT_META, CTXS.map((c) => ({ ...c, dayNtlVlm: "0" }))];
    h.clock.advance(5_000);
    expect(codes(await h.fail("signAndSubmit", { requestId: "v3", intent: market() }))).toEqual(["ORDER_NOTIONAL_EXCEEDED"]);
    expect((await h.ok("signAndSubmit", { requestId: "v4", intent: market({ coin: "@166", size: "25", slippageBps: 50 }) })).status).toBe("ok");
  });
});

describe("spot trading: which pairs and accounts", () => {
  it("refuses unverified and look-alike tokens before signing", async () => {
    await mainnetTrading();
    const meta = structuredClone(SPOT_META);
    // A look-alike: another token named HYPE with its own USDC pair.
    meta.tokens.push({ name: "HYPE", szDecimals: 2, weiDecimals: 8, index: 9999, tokenId: "0x11111111111111111111111111111111", isCanonical: false });
    meta.universe.push({ tokens: [9999, 0], name: "@9998", index: 9998, isCanonical: false });
    h.hl.spot = [meta, [...CTXS, { coin: "@9998", markPx: "40", midPx: "40", prevDayPx: "40", dayNtlVlm: "5000000" }]];
    for (const [i, coin] of ["@9998", "@999", "PURR/USDC"].entries()) {
      expect((await h.fail("signAndSubmit", { requestId: `u${i}`, intent: market({ coin }) })).code).toBe("UNSUPPORTED_MARKET");
    }
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("refuses a verified pair when the frame's spotMeta doesn't confirm it exactly", async () => {
    await mainnetTrading();
    const tampered = structuredClone(SPOT_META);
    tampered.tokens.find((t) => t.name === "HYPE")!.tokenId = "0x00000000000000000000000000000001";
    h.hl.spot = [tampered, SPOT_META_AND_CTXS[1]];
    expect((await h.fail("signAndSubmit", { requestId: "t1", intent: market() })).code).toBe("UNSUPPORTED_MARKET");
    h.hl.spot = null;
    h.clock.advance(5_000);
    expect((await h.fail("signAndSubmit", { requestId: "t2", intent: market() })).code).toBe("MARKET_DATA_UNAVAILABLE");
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("trades spot for the master only, even when a sub-account has spot trading in its own limits", async () => {
    await mainnetTrading();
    const sub = "0x5555555555555555555555555555555555555555";
    h.hl.subAccounts[USER] = [subAccountEntry(sub)];
    // The master has spot trading on already: nothing loosens, so no prompt.
    await h.ok("setLimits", { account: sub, spotTrading: true });
    const e = await h.fail("signAndSubmit", { requestId: "m1", intent: market({ vaultAddress: sub }) });
    expect(codes(e)).toContain("VAULT_NOT_ALLOWED");
    expect(e.details?.violations?.map((v) => v.message)).toContain("Spot orders are for the main account only.");
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("uses the testnet pins on testnet (no volume cap there)", async () => {
    h = await FrameHarness.create();
    await h.activeAgent();
    expect((await h.loosen({ spotTrading: true })).policy.spotTradingCoins).toEqual(VERIFIED_SPOT_PAIRS.testnet.map((p) => p.coin));
    // The mock's spot meta is mainnet's: the testnet pins don't match it, and the mainnet pairs aren't testnet pins.
    expect((await h.fail("signAndSubmit", { requestId: "n1", intent: market({ coin: "PURR/USDC", size: "4" }) })).code).toBe("UNSUPPORTED_MARKET");
    expect((await h.fail("signAndSubmit", { requestId: "n2", intent: market() })).code).toBe("UNSUPPORTED_MARKET");
    // With testnet's own PURR/USDC (no 24 h volume) a buy is signed: testnet has no volume cap.
    const purr = VERIFIED_SPOT_PAIRS.testnet.find((p) => p.coin === "PURR/USDC")!;
    h.hl.spot = [
      {
        universe: [{ tokens: [purr.base.index, 0], name: purr.coin, index: purr.index, isCanonical: true }],
        tokens: [
          { name: "USDC", szDecimals: 8, weiDecimals: 8, index: 0, tokenId: purr.quote.tokenId, isCanonical: true },
          { name: "PURR", szDecimals: 0, weiDecimals: 5, index: purr.base.index, tokenId: purr.base.tokenId, isCanonical: true },
        ],
      },
      [{ coin: "PURR/USDC", markPx: "4.58", midPx: "4.6", prevDayPx: "4.5", dayNtlVlm: "0" }],
    ];
    h.clock.advance(5_000);
    expect((await h.ok("signAndSubmit", { requestId: "n3", intent: market({ coin: "PURR/USDC", size: "4" }) })).status).toBe("ok");
    expect(sent(0).orders[0]).toMatchObject({ a: 10_000, b: true, s: "4", t: { limit: { tif: "Ioc" } } });
  });
});

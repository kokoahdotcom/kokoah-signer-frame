import { compileAction, type CompiledAction } from "@kokoah/shared/actions";
import { parseActionIntent } from "@kokoah/shared/intents";
import { MarketRegistry } from "@kokoah/shared/markets";
import { afterEach, describe, expect, it } from "vitest";
import { applyUserLimits, BASELINE_LIMITS, createBaselinePolicy, evaluateFramePolicy, hip3PinnedLegs } from "../src/frame/policy.js";
import { BUILDER, cloid, FrameHarness, limitOrder, META0, META_XYZ, PERP_DEXS, T0 } from "./helpers.js";

let h: FrameHarness;
afterEach(() => h?.destroy());

const registry = MarketRegistry.fromInfo({ meta: META0 });
const baseline = createBaselinePolicy({ address: BUILDER, feeTenthsBps: 25 });
const marks = { BTC: 100_000, ETH: 2_000, SOL: 150 };

function evalWire(action: Record<string, unknown>, extra: Partial<Parameters<typeof evaluateFramePolicy>[0]> = {}) {
  const compiled = { action, cloids: [], intent: parseActionIntent({ kind: "noop", origin: "manual" }) } as unknown as CompiledAction;
  return evaluateFramePolicy({ compiled, expiresAfter: T0 + 15_000, now: T0, policy: baseline, registry, markPrices: marks, ordersInLastMinute: 0, dailyNotionalUsedUsd: 0, ...extra });
}

function compiledOrder(overrides: Record<string, unknown> = {}, builder: { address: `0x${string}`; feeTenthsBps: number } | null = { address: BUILDER, feeTenthsBps: 25 }): CompiledAction {
  return compileAction(limitOrder(overrides) as never, { registry, builder });
}

const codes = (d: { violations: Array<{ code: string }> }) => d.violations.map((v) => v.code);

describe("baseline policy", () => {
  it("allows exactly the trading actions and requires builder and expiresAfter; no vault is listed in the policy object", () => {
    expect([...baseline.allowedActionTypes]).toEqual(["order", "cancel", "cancelByCloid", "modify", "batchModify", "updateLeverage", "updateIsolatedMargin", "scheduleCancel", "noop", "startFeeTrial"]);
    // No spot and no referral code unless the frame's configuration gives them.
    expect(baseline.allowedSpotCoins).toBeUndefined();
    expect(baseline.referralCode).toBeUndefined();
    expect(baseline.requiredBuilder).toEqual({ b: BUILDER, f: 25 });
    expect(baseline.allowedVaultAddresses).toEqual([]);
    expect(baseline.maxExpiresAfterWindowMs).toBe(BASELINE_LIMITS.maxExpiresAfterWindowMs);
    expect(baseline.maxOrdersPerMinute).toBe(60);
    expect(baseline.priceBandPct).toBe(5);
    expect(baseline.maxOrderNotionalUsd).toBe(250_000);
    expect(baseline.maxDailyNotionalUsd).toBe(25_000_000);
    expect(baseline.maxLeverage).toBe(50);
  });

  it("denies vault, transfer and withdrawal wire actions even though an agent key could sign them", () => {
    const vault = `0x${"33".repeat(20)}`;
    expect(codes(evalWire({ type: "vaultTransfer", vaultAddress: vault, isDeposit: true, usd: 1_000_000_000 }))).toContain("VAULT_ACTION_DENIED");
    expect(codes(evalWire({ type: "createVault", name: "x", description: "y", initialUsd: 1, nonce: 1 }))).toContain("VAULT_ACTION_DENIED");
    expect(codes(evalWire({ type: "usdSend", destination: vault, amount: "1", time: 1 }))).toContain("TRANSFER_DENIED");
    expect(codes(evalWire({ type: "withdraw3", destination: vault, amount: "1", time: 1 }))).toContain("WITHDRAWAL_DENIED");
    expect(codes(evalWire({ type: "subAccountTransfer", subAccountUser: vault, isDeposit: true, usd: 1 }))).toContain("TRANSFER_DENIED");
    expect(codes(evalWire({ type: "approveAgent", agentAddress: vault }))).toContain("APPROVAL_DENIED");
    expect(codes(evalWire({ type: "twapOrder", twap: {} }))).toContain("TWAP_DENIED");
    expect(codes(evalWire({ type: "reserveRequestWeight", weight: 1 }))).toContain("RATE_LIMIT_PURCHASE_DENIED");
    expect(codes(evalWire({ type: "somethingNew" }))).toContain("ACTION_TYPE_NOT_ALLOWED");
    expect(evalWire({ type: "noop" }).allowed).toBe(true);
  });

  it("denies a builder mismatch or a missing builder", () => {
    const ok = compiledOrder();
    expect(evaluateFramePolicy({ compiled: ok, expiresAfter: T0 + 15_000, now: T0, policy: baseline, registry, markPrices: marks, ordersInLastMinute: 0, dailyNotionalUsedUsd: 0 }).allowed).toBe(true);
    const other = compiledOrder({ cloid: cloid() }, { address: `0x${"44".repeat(20)}`, feeTenthsBps: 25 });
    expect(codes(evaluateFramePolicy({ compiled: other, expiresAfter: T0 + 15_000, now: T0, policy: baseline, registry, markPrices: marks, ordersInLastMinute: 0, dailyNotionalUsedUsd: 0 }))).toContain("BUILDER_MISMATCH");
    const higherFee = compiledOrder({ cloid: cloid() }, { address: BUILDER, feeTenthsBps: 100 });
    expect(codes(evaluateFramePolicy({ compiled: higherFee, expiresAfter: T0 + 15_000, now: T0, policy: baseline, registry, markPrices: marks, ordersInLastMinute: 0, dailyNotionalUsedUsd: 0 }))).toContain("BUILDER_MISMATCH");
    const none = compiledOrder({ cloid: cloid() }, null);
    expect(codes(evaluateFramePolicy({ compiled: none, expiresAfter: T0 + 15_000, now: T0, policy: baseline, registry, markPrices: marks, ordersInLastMinute: 0, dailyNotionalUsedUsd: 0 }))).toContain("BUILDER_REQUIRED");
  });

  it("requires expiresAfter within the window", () => {
    const c = compiledOrder({ cloid: cloid() });
    const far = evaluateFramePolicy({ compiled: c, expiresAfter: T0 + 120_000, now: T0, policy: baseline, registry, markPrices: marks, ordersInLastMinute: 0, dailyNotionalUsedUsd: 0 });
    expect(codes(far)).toContain("EXPIRES_AFTER_TOO_FAR");
    const past = evaluateFramePolicy({ compiled: c, expiresAfter: T0 - 1, now: T0, policy: baseline, registry, markPrices: marks, ordersInLastMinute: 0, dailyNotionalUsedUsd: 0 });
    expect(codes(past)).toContain("EXPIRES_AFTER_IN_PAST");
  });

  it("denies vaultAddress regardless of the policy object", () => {
    const vault = `0x${"55".repeat(20)}` as const;
    const c = compileAction(limitOrder({ vaultAddress: vault }) as never, { registry, builder: { address: BUILDER, feeTenthsBps: 25 } });
    const permissive = { ...baseline, allowedVaultAddresses: [vault] };
    const d = evaluateFramePolicy({ compiled: c, expiresAfter: T0 + 15_000, now: T0, policy: permissive, registry, markPrices: marks, ordersInLastMinute: 0, dailyNotionalUsedUsd: 0 });
    expect(codes(d)).toContain("VAULT_NOT_ALLOWED");
  });
});

describe("policy through signAndSubmit", () => {
  it("denies an intent acting for a vault or an account HL doesn't list as the master's sub-account", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    const e = await h.fail("signAndSubmit", { requestId: "v", intent: limitOrder({ vaultAddress: `0x${"66".repeat(20)}` }) });
    expect(e.code).toBe("POLICY_DENIED");
    expect(e.details?.violations?.map((v) => v.code)).toContain("VAULT_NOT_ALLOWED");
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("denies a limit price outside the band around HL's mark", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    const e = await h.fail("signAndSubmit", { requestId: "b", intent: limitOrder({ price: "2120" }) });
    expect(e.details?.violations?.map((v) => v.code)).toContain("PRICE_OUTSIDE_BAND");
    expect((await h.ok("signAndSubmit", { requestId: "b2", intent: limitOrder({ price: "2090" }) })).status).toBe("ok");
    expect((await h.ok("getStatus")).metrics.policyDenials).toBe(1);
  });

  it("caps one order at the baseline's $250,000, reduce-only orders exempt", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    const btc = (size: string, o: Record<string, unknown> = {}) => limitOrder({ coin: "BTC", size, price: "100000", ...o });
    const e = await h.fail("signAndSubmit", { requestId: "n1", intent: btc("2.6") });
    expect(e.details?.violations?.map((v) => v.code)).toEqual(["ORDER_NOTIONAL_EXCEEDED"]);
    expect(h.hl.exchangeCalls).toHaveLength(0);
    expect((await h.ok("signAndSubmit", { requestId: "n2", intent: btc("2.6", { side: "sell", reduceOnly: true }) })).status).toBe("ok");
  });

  it("lets resting limits sit up to 50% from HL's mark, but bands orders that execute now at 5%", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    // Resting GTC and ALO buys 20% below mark (1600 vs 2000) are signed.
    expect((await h.ok("signAndSubmit", { requestId: "r1", intent: limitOrder({ price: "1600" }) })).status).toBe("ok");
    expect((await h.ok("signAndSubmit", { requestId: "r2", intent: limitOrder({ price: "1600", tif: "Alo" }) })).status).toBe("ok");
    // A resting sell 20% above is signed too.
    expect((await h.ok("signAndSubmit", { requestId: "r3", intent: limitOrder({ side: "sell", price: "2400" }) })).status).toBe("ok");
    // A marketable buy 20% above mark executes now: denied with a message that says why.
    const above = await h.fail("signAndSubmit", { requestId: "a", intent: limitOrder({ price: "2400" }) });
    expect(above.code).toBe("POLICY_DENIED");
    expect(above.details?.violations).toEqual([
      { code: "PRICE_OUTSIDE_BAND", message: "ETH buy at 2400 is 20% from the mark price 2000 and would fill immediately; orders that execute now must be within 5% of the mark (a resting limit can be up to 50% away)." },
    ]);
    // IOC 20% below executes now (or not at all): denied.
    expect((await h.fail("signAndSubmit", { requestId: "i", intent: limitOrder({ price: "1600", tif: "Ioc" }) })).code).toBe("POLICY_DENIED");
    // A typo (200 for 2000) is still refused.
    const typo = await h.fail("signAndSubmit", { requestId: "t", intent: limitOrder({ price: "200" }) });
    expect(typo.details?.violations?.[0]?.message).toContain("resting limits must be within 50% of the mark");
  });

  it("classifies marketable limits with HL's own mid, and a tightened band keeps the resting band", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    // HL's book mid is far under the mark (thin book): a buy at 1600 crosses it, so it executes now.
    h.hl.mid.ETH = "1500";
    expect((await h.fail("signAndSubmit", { requestId: "m", intent: limitOrder({ price: "1600" }) })).code).toBe("POLICY_DENIED");
    h.destroy();
    h = await FrameHarness.create(); // fresh market-data cache
    await h.activeAgent("device");
    await h.ok("setLimits", { priceBandPct: 2 });
    expect((await h.fail("signAndSubmit", { requestId: "x", intent: limitOrder({ price: "2060" }) })).code).toBe("POLICY_DENIED"); // +3%, marketable
    expect((await h.ok("signAndSubmit", { requestId: "y", intent: limitOrder({ price: "1600" }) })).status).toBe("ok");
  });

  it("bands triggers: untriggered stops up to 50% from mark", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    const stop = (trigger: string) => ({ kind: "order", coin: "ETH", side: "sell", orderType: "stopMarket", size: "0.1", triggerPrice: trigger, reduceOnly: true, origin: "manual", cloid: cloid() });
    expect((await h.ok("signAndSubmit", { requestId: "s1", intent: stop("1600") })).status).toBe("ok");
    const far = await h.fail("signAndSubmit", { requestId: "s2", intent: stop("500") });
    expect(far.details?.violations?.[0]?.message).toContain("triggers must be within 50% of the mark");
  });

  it("caps leverage at the market maximum", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    const e = await h.fail("signAndSubmit", { requestId: "lev", intent: { kind: "updateLeverage", coin: "ETH", leverage: 26, marginMode: "cross", origin: "manual" } });
    expect(e.code).toBe("POLICY_DENIED");
    expect(e.details?.violations?.map((v) => v.code)).toEqual(["LEVERAGE_EXCEEDED"]);
    expect((await h.ok("signAndSubmit", { requestId: "lev2", intent: { kind: "updateLeverage", coin: "ETH", leverage: 25, marginMode: "cross", origin: "manual" } })).status).toBe("ok");
  });

  it("caps leverage at the baseline's 50x where a market allows more, reading the account's leverage only there", async () => {
    h = await FrameHarness.create();
    const meta = { ...META0, universe: [...META0.universe, { name: "WILD", szDecimals: 0, maxLeverage: 100 }] };
    const info = h.hl.info.bind(h.hl);
    h.hl.info = (body) => (body.type === "metaAndAssetCtxs" && body.dex === undefined ? [meta, h.hl.ctxs(meta)] : info(body));
    h.hl.mark.WILD = "2";
    h.hl.mid.WILD = "2";
    await h.activeAgent("device");
    const lev = (leverage: number) => ({ kind: "updateLeverage", coin: "WILD", leverage, marginMode: "cross", origin: "manual" });
    expect((await h.fail("signAndSubmit", { requestId: "w1", intent: lev(51) })).details?.violations?.map((v) => v.code)).toEqual(["LEVERAGE_EXCEEDED"]);
    expect((await h.ok("signAndSubmit", { requestId: "w2", intent: lev(50) })).status).toBe("ok");
    // Set above 50x outside Kokoah: new entries are refused, closing still works.
    h.hl.leverage.WILD = 75;
    const wild = (o: Record<string, unknown> = {}) => limitOrder({ coin: "WILD", size: "10", price: "2", ...o });
    expect((await h.fail("signAndSubmit", { requestId: "w3", intent: wild() })).details?.violations?.map((v) => v.code)).toContain("LEVERAGE_EXCEEDED");
    expect((await h.ok("signAndSubmit", { requestId: "w4", intent: wild({ side: "sell", reduceOnly: true }) })).status).toBe("ok");
    // ETH's own maximum (25x) is below the cap: no leverage read for it.
    expect((await h.ok("signAndSubmit", { requestId: "e1", intent: limitOrder() })).status).toBe("ok");
    expect(h.hl.infoCalls.filter((b) => b.type === "activeAssetData").map((b) => b.coin)).toEqual(["WILD"]);
  });

  it("caps leverage at a tightened user limit, for leverage changes and new entries", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    await h.ok("setLimits", { maxLeverage: 5 });
    const e = await h.fail("signAndSubmit", { requestId: "l1", intent: { kind: "updateLeverage", coin: "ETH", leverage: 10, marginMode: "isolated", origin: "manual" } });
    expect(e.details?.violations?.map((v) => v.code)).toContain("LEVERAGE_EXCEEDED");
    h.hl.leverage.ETH = 20; // the account's current ETH leverage on HL
    const entry = await h.fail("signAndSubmit", { requestId: "l2", intent: limitOrder() });
    expect(entry.details?.violations?.map((v) => v.code)).toContain("LEVERAGE_EXCEEDED");
    // Closing is still possible.
    expect((await h.ok("signAndSubmit", { requestId: "l3", intent: limitOrder({ side: "sell", reduceOnly: true }) })).status).toBe("ok");
    h.hl.leverage.ETH = 5;
    h.clock.advance(5_000);
    expect((await h.ok("signAndSubmit", { requestId: "l4", intent: limitOrder() })).status).toBe("ok");
  });

  it("enforces the per-minute order limit, persisted across reloads", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    for (let i = 0; i < 60; i++) {
      expect((await h.ok("signAndSubmit", { requestId: `r${i}`, intent: limitOrder() })).status).toBe("ok");
    }
    const e = await h.fail("signAndSubmit", { requestId: "r60", intent: limitOrder() });
    expect(e.details?.violations?.map((v) => v.code)).toContain("ORDER_RATE_EXCEEDED");
    // Cancels are exempt.
    expect((await h.ok("signAndSubmit", { requestId: "cx", intent: { kind: "cancel", cancels: [{ coin: "ETH", oid: 1 }], origin: "manual" } })).status).toBe("ok");
    // Reloading the frame does not reset the counter.
    const reloaded = await FrameHarness.create({ idb: h.idb, clock: h.clock, hl: h.hl });
    try {
      await reloaded.ok("hello", { protocolVersion: 1 });
      expect((await reloaded.fail("signAndSubmit", { requestId: "r61", intent: limitOrder() })).details?.violations?.map((v) => v.code)).toContain("ORDER_RATE_EXCEEDED");
      h.clock.advance(61_000);
      expect((await reloaded.ok("signAndSubmit", { requestId: "r62", intent: limitOrder() })).status).toBe("ok");
    } finally {
      reloaded.destroy();
    }
  });

  it("counts TP/SL legs as orders", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    await h.ok("setLimits", { maxOrdersPerMinute: 2 });
    const e = await h.fail("signAndSubmit", { requestId: "t", intent: limitOrder({ takeProfit: { triggerPrice: "2200" }, stopLoss: { triggerPrice: "1900" } }) });
    expect(e.details?.violations?.map((v) => v.code)).toContain("ORDER_RATE_EXCEEDED");
  });
});

describe("setLimits", () => {
  it("rejects any loosening with LIMIT_LOOSENING_REJECTED and changes nothing", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    await h.ok("setLimits", { maxOrdersPerMinute: 10 });
    const e = await h.fail("setLimits", { maxOrdersPerMinute: 61, priceBandPct: 20, maxOrderNotionalUsd: 2_000_000, maxDailyNotionalUsd: 30_000_000 });
    expect(e.code).toBe("LIMIT_LOOSENING_REJECTED");
    expect(e.details?.fields).toEqual(["maxOrderNotionalUsd", "maxDailyNotionalUsd", "maxOrdersPerMinute", "priceBandPct"]);
    expect((await h.ok("getStatus")).policy.maxOrdersPerMinute).toBe(10);
    // Action types outside the baseline can't even be expressed.
    expect((await h.fail("setLimits", { allowedActionTypes: ["order", "vaultTransfer"] })).code).toBe("INVALID_REQUEST");
  });

  it("refuses an account's limits while there is no key (no master to tell a sub-account from)", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const e = await h.fail("setLimits", { account: "0x" + "b".repeat(40), maxOrdersPerMinute: 10 });
    expect(e.code).toBe("NO_KEY");
    expect((await h.ok("getStatus")).policy.maxOrdersPerMinute).not.toBe(10);
  });

  it("applies tightening, reports it in status and emits statusChanged", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    const r = await h.ok("setLimits", { maxOrderNotionalUsd: 150, allowedCoins: ["ETH", "BTC"], priceBandPct: 2, requireStopLossForNewEntries: true, allowedActionTypes: ["order", "cancel"] });
    expect(r.policy).toMatchObject({ maxOrderNotionalUsd: 150, allowedCoins: ["ETH", "BTC"], priceBandPct: 2, requireStopLossForNewEntries: true, allowedActionTypes: ["order", "cancel"] });
    expect(r.policy.userLimits).toEqual({ maxOrderNotionalUsd: 150, priceBandPct: 2, allowedCoins: ["ETH", "BTC"], requireStopLossForNewEntries: true, allowedActionTypes: ["order", "cancel"] });
    expect(h.events("statusChanged").at(-1)?.policy.maxOrderNotionalUsd).toBe(150);

    const notional = await h.fail("signAndSubmit", { requestId: "n", intent: limitOrder({ size: "0.1", stopLoss: { triggerPrice: "1990" } }) });
    expect(notional.details?.violations?.map((v) => v.code)).toContain("ORDER_NOTIONAL_EXCEEDED");
    const coin = await h.fail("signAndSubmit", { requestId: "c", intent: limitOrder({ coin: "SOL", price: "150", size: "0.5" }) });
    expect(coin.details?.violations?.map((v) => v.code)).toContain("COIN_NOT_ALLOWED");
    const sl = await h.fail("signAndSubmit", { requestId: "s", intent: limitOrder({ size: "0.05" }) });
    expect(sl.details?.violations?.map((v) => v.code)).toContain("STOP_LOSS_REQUIRED");
    const lev = await h.fail("signAndSubmit", { requestId: "l", intent: { kind: "updateLeverage", coin: "ETH", leverage: 2, marginMode: "cross", origin: "manual" } });
    expect(lev.details?.violations?.map((v) => v.code)).toContain("ACTION_TYPE_NOT_ALLOWED");
    expect((await h.ok("signAndSubmit", { requestId: "ok", intent: limitOrder({ size: "0.05", stopLoss: { triggerPrice: "1990" } }) })).status).toBe("ok");

    // {} resets to the baseline, after the user's click in the frame.
    const reset = await h.loosen({});
    expect(reset.policy.userLimits).toBeNull();
    expect(reset.policy.maxOrderNotionalUsd).toBe(250_000);
  });

  it("tracks daily notional", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    await h.ok("setLimits", { maxDailyNotionalUsd: 1_000 });
    expect((await h.ok("signAndSubmit", { requestId: "d1", intent: limitOrder({ size: "0.3" }) })).status).toBe("ok"); // $600
    const e = await h.fail("signAndSubmit", { requestId: "d2", intent: limitOrder({ size: "0.3" }) });
    expect(e.details?.violations?.map((v) => v.code)).toContain("DAILY_NOTIONAL_EXCEEDED");
    // Reduce-only orders are exempt from notional caps so closing always works.
    expect((await h.ok("signAndSubmit", { requestId: "d3", intent: limitOrder({ side: "sell", size: "0.3", reduceOnly: true }) })).status).toBe("ok");
  });

  it("applyUserLimits is pure and tightening-only", () => {
    expect(applyUserLimits(baseline, { maxLeverage: 3 })).toMatchObject({ ok: true, limits: { maxLeverage: 3 } });
    expect(applyUserLimits(baseline, { requireStopLossForNewEntries: false })).toMatchObject({ ok: true, limits: null });
    const strict = { ...baseline, requireStopLossForNewEntries: true, allowedCoins: ["BTC"] };
    expect(applyUserLimits(strict, { requireStopLossForNewEntries: false })).toMatchObject({ ok: false, fields: ["requireStopLossForNewEntries"] });
    expect(applyUserLimits(strict, { allowedCoins: ["BTC", "ETH"] })).toMatchObject({ ok: false, fields: ["allowedCoins"] });
  });
});

describe("HIP-3 legs the mainnet dex pin applies to", () => {
  const hip3 = MarketRegistry.fromInfo({ meta: META0, dexMetas: { xyz: META_XYZ }, perpDexs: PERP_DEXS });
  const GOLD = 110001;
  const ETH = 1;
  const leg = (a: number, r: boolean) => ({ a, b: false, p: "3000", s: "0.01", r, t: { limit: { tif: "Gtc" } } });
  const gold = [{ coin: "xyz:GOLD", dex: "xyz" }];

  it("covers everything but cancels and reduce-only orders: entries, modifies that aren't reduce-only, every leverage and margin change", () => {
    expect(hip3PinnedLegs({ type: "order", orders: [leg(GOLD, false), leg(GOLD, true)], grouping: "normalTpsl" }, hip3)).toEqual(gold);
    expect(hip3PinnedLegs({ type: "modify", oid: 7, order: leg(GOLD, false) }, hip3)).toEqual(gold);
    expect(hip3PinnedLegs({ type: "batchModify", modifies: [{ oid: 7, order: leg(GOLD, true) }, { oid: 8, order: leg(GOLD, false) }] }, hip3)).toEqual(gold);
    expect(hip3PinnedLegs({ type: "updateLeverage", asset: GOLD, isCross: false, leverage: 3 }, hip3)).toEqual(gold);
    expect(hip3PinnedLegs({ type: "updateLeverage", asset: GOLD, isCross: false, leverage: 1 }, hip3)).toEqual(gold);
    expect(hip3PinnedLegs({ type: "updateIsolatedMargin", asset: GOLD, isBuy: true, ntli: -25_000_000 }, hip3)).toEqual(gold);
    expect(hip3PinnedLegs({ type: "updateIsolatedMargin", asset: GOLD, isBuy: true, ntli: 25_000_000 }, hip3)).toEqual(gold);
  });

  it("leaves out cancels, reduce-only orders and everything off HIP-3 dexes", () => {
    expect(hip3PinnedLegs({ type: "order", orders: [leg(GOLD, true)], grouping: "positionTpsl" }, hip3)).toEqual([]);
    expect(hip3PinnedLegs({ type: "modify", oid: 7, order: leg(GOLD, true) }, hip3)).toEqual([]);
    expect(hip3PinnedLegs({ type: "cancel", cancels: [{ a: GOLD, o: 7 }] }, hip3)).toEqual([]);
    expect(hip3PinnedLegs({ type: "cancelByCloid", cancels: [{ asset: GOLD, cloid: cloid() }] }, hip3)).toEqual([]);
    expect(hip3PinnedLegs({ type: "scheduleCancel", time: T0 + 60_000 }, hip3)).toEqual([]);
    expect(hip3PinnedLegs({ type: "noop" }, hip3)).toEqual([]);
    expect(hip3PinnedLegs({ type: "order", orders: [leg(ETH, false)], grouping: "na" }, hip3)).toEqual([]);
    expect(hip3PinnedLegs({ type: "updateLeverage", asset: ETH, isCross: true, leverage: 3 }, hip3)).toEqual([]);
    expect(hip3PinnedLegs({ type: "updateIsolatedMargin", asset: ETH, isBuy: true, ntli: -1_000_000 }, hip3)).toEqual([]);
  });
});

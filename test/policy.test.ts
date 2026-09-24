import { compileAction, type CompiledAction } from "@kokoah/shared/actions";
import { parseActionIntent } from "@kokoah/shared/intents";
import { MarketRegistry } from "@kokoah/shared/markets";
import { afterEach, describe, expect, it } from "vitest";
import { applyUserLimits, BASELINE_LIMITS, createBaselinePolicy, evaluateFramePolicy } from "../src/frame/policy.js";
import { BUILDER, cloid, FrameHarness, limitOrder, META0, T0 } from "./helpers.js";

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
    expect([...baseline.allowedActionTypes]).toEqual(["order", "cancel", "cancelByCloid", "modify", "batchModify", "updateLeverage", "updateIsolatedMargin", "scheduleCancel", "noop"]);
    expect(baseline.requiredBuilder).toEqual({ b: BUILDER, f: 25 });
    expect(baseline.allowedVaultAddresses).toEqual([]);
    expect(baseline.maxExpiresAfterWindowMs).toBe(BASELINE_LIMITS.maxExpiresAfterWindowMs);
    expect(baseline.maxOrdersPerMinute).toBe(60);
    expect(baseline.priceBandPct).toBe(10);
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
    const e = await h.fail("signAndSubmit", { requestId: "b", intent: limitOrder({ price: "2300" }) });
    expect(e.details?.violations?.map((v) => v.code)).toContain("PRICE_OUTSIDE_BAND");
    expect((await h.ok("signAndSubmit", { requestId: "b2", intent: limitOrder({ price: "2190" }) })).status).toBe("ok");
    expect((await h.ok("getStatus")).metrics.policyDenials).toBe(1);
  });

  it("lets resting limits sit up to 50% from HL's mark, but bands orders that execute now at 10%", async () => {
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
      { code: "PRICE_OUTSIDE_BAND", message: "ETH buy at 2400 is 20% from the mark price 2000 and would fill immediately; orders that execute now must be within 10% of the mark (a resting limit can be up to 50% away)." },
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

    // {} resets to the baseline.
    const reset = await h.ok("setLimits", {});
    expect(reset.policy.userLimits).toBeNull();
    expect(reset.policy.maxOrderNotionalUsd).toBe(1_000_000);
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

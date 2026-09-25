/**
 * PHASE3 REV: Kokoah's Hyperliquid referral code (setReferrer, once, only the frame's own code), the fee trial
 * (startFeeTrial) and Convert stablecoins (spot orders only on the pinned stablecoin pairs).
 */
import { IDBFactory } from "fake-indexeddb";
import { recoverL1Signer } from "@kokoah/shared/signing";
import { afterEach, describe, expect, it } from "vitest";
import { IdbSignerStore } from "../src/frame/storage.js";
import { BUILDER, Clock, FrameHarness, limitOrder, MockHl, SPOT_META, SPOT_META_AND_CTXS, subAccountEntry, T0, testConfig, USER, USER_FEES } from "./helpers.js";

let h: FrameHarness;
afterEach(() => h?.destroy());

const CODE = "KOKOAH";
const MAINNET = { VITE_HL_NETWORK: "mainnet", VITE_ALLOW_MAINNET_WRITES: "true" };
const referrer = { kind: "setReferrer", origin: "manual" };
const feeTrial = { kind: "startFeeTrial", origin: "manual", tier: 1 };
const convert = (o: Record<string, unknown> = {}) => ({ kind: "order", coin: "@166", side: "buy", orderType: "market", size: "25", slippageBps: 50, origin: "manual", ...o });
const codes = (e: { details?: { violations?: Array<{ code: string }> } }) => (e.details?.violations ?? []).map((v) => v.code);

describe("setReferrer", () => {
  it("is denied when the frame has no referral code, and nothing is sent", async () => {
    h = await FrameHarness.create();
    await h.activeAgent();
    const e = await h.fail("signAndSubmit", { requestId: "r1", intent: referrer });
    expect(e.code).toBe("POLICY_DENIED");
    expect(codes(e)).toEqual(["REFERRER_ACTION_DENIED"]);
    expect(h.hl.exchangeCalls).toHaveLength(0);
    expect((await h.ok("getStatus")).policy.referralCode).toBeNull();
  });

  it("signs exactly the configured code, for the master account, with the agent key", async () => {
    h = await FrameHarness.create({ config: testConfig({ VITE_HL_REFERRAL_CODE: CODE }) });
    const { address } = await h.activeAgent();
    expect((await h.ok("getStatus")).policy.referralCode).toBe(CODE);
    const r = await h.ok("signAndSubmit", { requestId: "r1", intent: referrer });
    expect(r).toMatchObject({ status: "ok", actionType: "setReferrer", cloids: [] });
    expect(h.hl.exchangeCalls).toHaveLength(1);
    const sent = h.hl.exchangeCalls[0]!.body;
    expect(sent.action).toEqual({ type: "setReferrer", code: CODE });
    expect(Object.keys(sent.action)).toEqual(["type", "code"]);
    expect(sent.vaultAddress).toBeUndefined();
    expect(sent.expiresAfter).toBe(T0 + 15_000);
    const signer = await recoverL1Signer({ action: sent.action, nonce: sent.nonce, network: testConfig().network, expiresAfter: sent.expiresAfter, signature: sent.signature as never });
    expect(signer.toLowerCase()).toBe(address);
    // The frame read the referrer itself, for the key's master.
    expect(h.hl.infoCalls.some((c) => c.type === "referral" && String(c.user).toLowerCase() === USER)).toBe(true);
  });

  it("never takes a code or an account from the parent", async () => {
    h = await FrameHarness.create({ config: testConfig({ VITE_HL_REFERRAL_CODE: CODE }) });
    await h.activeAgent();
    for (const intent of [
      { ...referrer, code: "ATTACKER" },
      { ...referrer, vaultAddress: "0x2222222222222222222222222222222222222222" },
      { ...referrer, origin: "ai_ticket" },
    ]) {
      expect((await h.fail("signAndSubmit", { requestId: `bad-${JSON.stringify(intent).length}`, intent })).code).toBe("INVALID_INTENT");
    }
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("is signed once per key, across reloads, even when Hyperliquid still reports no referrer", async () => {
    const clock = new Clock();
    const hl = new MockHl(clock);
    const idb = new IDBFactory();
    const config = testConfig({ VITE_HL_REFERRAL_CODE: CODE });
    h = await FrameHarness.create({ config, clock, hl, idb });
    await h.activeAgent();
    await h.ok("signAndSubmit", { requestId: "r1", intent: referrer });
    // Orders in between keep the record.
    await h.ok("signAndSubmit", { requestId: "o1", intent: limitOrder() });
    const again = await h.fail("signAndSubmit", { requestId: "r2", intent: referrer });
    expect(codes(again)).toEqual(["REFERRER_ACTION_DENIED"]);
    expect(again.details?.violations?.[0]?.message).toMatch(/already set the referral code once/);
    h.destroy();
    // A reload (a new frame on the same storage) still remembers it.
    h = await FrameHarness.create({ config, clock, hl, idb, store: await IdbSignerStore.open(idb) });
    await h.ok("hello", { protocolVersion: 1 });
    expect(codes(await h.fail("signAndSubmit", { requestId: "r3", intent: referrer }))).toEqual(["REFERRER_ACTION_DENIED"]);
    expect(hl.exchangeCalls.filter((c) => c.body.action.type === "setReferrer")).toHaveLength(1);
  });

  it("is denied when the account already has a referrer, and fails closed when HL can't be read", async () => {
    h = await FrameHarness.create({ config: testConfig({ VITE_HL_REFERRAL_CODE: CODE }) });
    await h.activeAgent();
    h.hl.referral[USER] = { referredBy: { referrer: "0x9999999999999999999999999999999999999999", code: "OTHER" }, cumVlm: "10" };
    const e = await h.fail("signAndSubmit", { requestId: "r1", intent: referrer });
    expect(e.details?.violations?.[0]?.message).toMatch(/already has a referrer/);
    delete h.hl.referral[USER];
    h.hl.infoFailure = (b) => b.type === "referral";
    const down = await h.fail("signAndSubmit", { requestId: "r2", intent: referrer });
    expect(down).toMatchObject({ code: "MARKET_DATA_UNAVAILABLE", retryable: true });
    h.hl.infoFailure = null;
    h.hl.referral[USER] = { unexpected: true };
    expect((await h.fail("signAndSubmit", { requestId: "r3", intent: referrer })).code).toBe("MARKET_DATA_UNAVAILABLE");
    expect(h.hl.exchangeCalls).toHaveLength(0);
    // Nothing was recorded: once HL answers "no referrer", the key may still set it.
    delete h.hl.referral[USER];
    expect((await h.ok("signAndSubmit", { requestId: "r4", intent: referrer })).status).toBe("ok");
  });

  it("rejects an invalid VITE_HL_REFERRAL_CODE at startup", () => {
    expect(() => testConfig({ VITE_HL_REFERRAL_CODE: "has space" })).toThrow(/VITE_HL_REFERRAL_CODE/);
    expect(() => testConfig({ VITE_HL_REFERRAL_CODE: "x".repeat(21) })).toThrow(/VITE_HL_REFERRAL_CODE/);
    expect(testConfig({ VITE_HL_REFERRAL_CODE: "" }).referralCode).toBeNull();
  });
});

describe("startFeeTrial", () => {
  it("signs the chosen VIP tier's rates from the fee schedule the frame read itself, for the master account", async () => {
    h = await FrameHarness.create();
    await h.activeAgent();
    const r = await h.ok("signAndSubmit", { requestId: "t1", intent: feeTrial });
    expect(r).toMatchObject({ status: "ok", actionType: "startFeeTrial", cloids: [] });
    expect(h.hl.exchangeCalls[0]!.body.action).toEqual({ type: "startFeeTrial", addBaseRate: "0.00012", crossBaseRate: "0.0004" });
    expect(Object.keys(h.hl.exchangeCalls[0]!.body.action)).toEqual(["type", "addBaseRate", "crossBaseRate"]);
    expect(h.hl.exchangeCalls[0]!.body.vaultAddress).toBeUndefined();
    expect(h.hl.infoCalls.some((c) => c.type === "userFees" && String(c.user).toLowerCase() === USER)).toBe(true);
    await h.ok("signAndSubmit", { requestId: "t2", intent: { ...feeTrial, tier: 4 } });
    expect(h.hl.exchangeCalls[1]!.body.action).toEqual({ type: "startFeeTrial", addBaseRate: "0.0", crossBaseRate: "0.00028" });
  });

  it("takes rates only from Hyperliquid: no rate fields, no tier outside the schedule", async () => {
    h = await FrameHarness.create();
    await h.activeAgent();
    expect((await h.fail("signAndSubmit", { requestId: "t1", intent: { ...feeTrial, crossBaseRate: "0.0" } })).code).toBe("INVALID_INTENT");
    expect((await h.fail("signAndSubmit", { requestId: "t2", intent: { ...feeTrial, tier: 9 } })).code).toBe("COMPILE_FAILED");
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("is refused while a trial runs or before the next one is available, and when HL can't be read", async () => {
    h = await FrameHarness.create();
    await h.activeAgent();
    const fees = h.hl.userFees as Record<string, unknown>;
    fees.trial = { perpCrossBaseRate: "0.0004", perpAddBaseRate: "0.00012", spotCrossBaseRate: "0.0006", spotAddBaseRate: "0.0003", endTimestamp: T0 + 86_400_000 };
    expect(codes(await h.fail("signAndSubmit", { requestId: "t1", intent: feeTrial }))).toEqual(["FEE_TRIAL_UNAVAILABLE"]);
    fees.trial = null;
    fees.nextTrialAvailableTimestamp = T0 + 3_600_000;
    expect(codes(await h.fail("signAndSubmit", { requestId: "t2", intent: feeTrial }))).toEqual(["FEE_TRIAL_UNAVAILABLE"]);
    fees.nextTrialAvailableTimestamp = T0 - 1;
    h.hl.infoFailure = (b) => b.type === "userFees";
    expect(await h.fail("signAndSubmit", { requestId: "t3", intent: feeTrial })).toMatchObject({ code: "MARKET_DATA_UNAVAILABLE", retryable: true });
    h.hl.infoFailure = null;
    h.hl.userFees = { trial: null };
    expect((await h.fail("signAndSubmit", { requestId: "t4", intent: feeTrial })).code).toBe("MARKET_DATA_UNAVAILABLE");
    expect(h.hl.exchangeCalls).toHaveLength(0);
    // Once available again, it signs.
    h.hl.userFees = { ...structuredClone(USER_FEES), nextTrialAvailableTimestamp: T0 - 1 };
    expect((await h.ok("signAndSubmit", { requestId: "t5", intent: feeTrial })).status).toBe("ok");
  });

  it("respects limits that leave it out", async () => {
    h = await FrameHarness.create();
    await h.activeAgent();
    await h.ok("setLimits", { allowedActionTypes: ["order", "cancel", "cancelByCloid"] });
    expect(codes(await h.fail("signAndSubmit", { requestId: "t1", intent: feeTrial }))).toEqual(["ACTION_TYPE_NOT_ALLOWED"]);
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });
});

describe("Convert stablecoins (spot)", () => {
  const mainnet = () => testConfig(MAINNET);

  it("lists only the network's pinned stablecoin pairs", async () => {
    h = await FrameHarness.create({ config: mainnet() });
    await h.ok("hello", { protocolVersion: 1 });
    expect((await h.ok("getStatus")).policy.spotCoins).toEqual(["@166", "@150"]);
  });

  it("buys with a spot IOC order and no builder, sells with the builder", async () => {
    h = await FrameHarness.create({ config: mainnet() });
    await h.activeAgent();
    const buy = await h.ok("signAndSubmit", { requestId: "c1", intent: convert() });
    expect(buy.status).toBe("ok");
    expect(buy.marketOrder).toEqual({ midPrice: "0.99985", limitPrice: "1.0048", slippageBps: 50 });
    const sentBuy = h.hl.exchangeCalls[0]!.body.action as unknown as { orders: Array<Record<string, unknown>>; builder?: unknown; grouping: string };
    expect(sentBuy.orders).toHaveLength(1);
    expect(sentBuy.orders[0]).toMatchObject({ a: 10_166, b: true, s: "25", r: false, t: { limit: { tif: "Ioc" } } });
    expect(sentBuy.builder).toBeUndefined();
    expect(sentBuy.grouping).toBe("na");
    await h.ok("signAndSubmit", { requestId: "c2", intent: convert({ coin: "@150", side: "sell", size: "12.5" }) });
    const sentSell = h.hl.exchangeCalls[1]!.body.action as unknown as { orders: Array<Record<string, unknown>>; builder?: unknown };
    expect(sentSell.orders[0]).toMatchObject({ a: 10_150, b: false, s: "12.5" });
    expect(sentSell.builder).toEqual({ b: BUILDER, f: 25 });
  });

  it("works with personal limits that tighten leverage and require stops (they are about perps)", async () => {
    h = await FrameHarness.create({ config: mainnet() });
    await h.activeAgent();
    await h.ok("setLimits", { maxLeverage: 3, requireStopLossForNewEntries: true });
    expect((await h.ok("signAndSubmit", { requestId: "c1", intent: convert() })).status).toBe("ok");
    expect(h.hl.infoCalls.some((c) => c.type === "activeAssetData")).toBe(false);
  });

  it("refuses every other spot market before signing", async () => {
    h = await FrameHarness.create({ config: mainnet() });
    await h.activeAgent();
    for (const [i, coin] of ["@107", "PURR/USDC", "@999"].entries()) {
      expect((await h.fail("signAndSubmit", { requestId: `x${i}`, intent: convert({ coin, size: "1" }) })).code).toBe("UNSUPPORTED_MARKET");
    }
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("refuses a pinned pair when Hyperliquid's spotMeta doesn't match it exactly", async () => {
    h = await FrameHarness.create({ config: mainnet() });
    await h.activeAgent();
    const tampered = structuredClone(SPOT_META);
    tampered.tokens.find((t) => t.name === "USDT0")!.tokenId = "0x00000000000000000000000000000001";
    h.hl.spot = [tampered, SPOT_META_AND_CTXS[1]];
    const e = await h.fail("signAndSubmit", { requestId: "c1", intent: convert() });
    expect(e.code).toBe("UNSUPPORTED_MARKET");
    // The other pair still matches.
    expect((await h.ok("signAndSubmit", { requestId: "c2", intent: convert({ coin: "@150" }) })).status).toBe("ok");
    h.hl.spot = null;
    h.clock.advance(5_000);
    expect((await h.fail("signAndSubmit", { requestId: "c3", intent: convert({ coin: "@150" }) })).code).toBe("MARKET_DATA_UNAVAILABLE");
  });

  it("denies resting orders, far prices and sub-accounts", async () => {
    h = await FrameHarness.create({ config: mainnet() });
    await h.activeAgent();
    const gtc = await h.fail("signAndSubmit", { requestId: "c1", intent: convert({ orderType: "limit", price: "0.99", tif: "Gtc", slippageBps: undefined }) });
    expect(codes(gtc)).toEqual(["SPOT_NOT_ALLOWED"]);
    const far = await h.fail("signAndSubmit", { requestId: "c2", intent: convert({ orderType: "limit", price: "1.2", tif: "Ioc", slippageBps: undefined }) });
    expect(codes(far)).toEqual(["PRICE_OUTSIDE_BAND"]);
    const sub = "0x5555555555555555555555555555555555555555";
    h.hl.subAccounts[USER] = [subAccountEntry(sub)];
    const e = await h.fail("signAndSubmit", { requestId: "c3", intent: convert({ vaultAddress: sub }) });
    expect(codes(e)).toContain("VAULT_NOT_ALLOWED");
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("uses the testnet pins on testnet, never the mainnet ones", async () => {
    h = await FrameHarness.create();
    await h.activeAgent();
    expect((await h.ok("getStatus")).policy.spotCoins).toEqual(["@1115", "@1200"]);
    // @166 is a mainnet pair; the mock's spot meta has no testnet pairs, so nothing matches.
    expect((await h.fail("signAndSubmit", { requestId: "c1", intent: convert() })).code).toBe("UNSUPPORTED_MARKET");
    expect((await h.fail("signAndSubmit", { requestId: "c2", intent: convert({ coin: "@1115" }) })).code).toBe("UNSUPPORTED_MARKET");
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });
});

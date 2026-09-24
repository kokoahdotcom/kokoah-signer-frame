/**
 * Sub-accounts ("strategy accounts"): the frame signs `vaultAddress` only for sub-accounts that Hyperliquid's own
 * `subAccounts` answer lists for the key's master, read by the frame itself and cached briefly. Vaults and anything
 * else stay denied. Personal limits and daily notional are kept per account; the baseline daily cap holds per agent.
 */
import { compileAction } from "@kokoah/shared/actions";
import { MarketRegistry } from "@kokoah/shared/markets";
import { recoverL1Signer } from "@kokoah/shared/signing";
type Signature = Parameters<typeof recoverL1Signer>[0]["signature"];
import { TESTNET } from "@kokoah/shared/network";
import { afterEach, describe, expect, it } from "vitest";
import { nextUsage, usageOf } from "../src/frame/nonces.js";
import { BASELINE_LIMITS, createBaselinePolicy, evaluateFramePolicy, limitsForAccount, policyForAccount } from "../src/frame/policy.js";
import { BUILDER, FrameHarness, limitOrder, META0, subAccountEntry, T0, USER } from "./helpers.js";

let h: FrameHarness;
afterEach(() => h?.destroy());

const SUB = "0x5ab0000000000000000000000000000000000001" as const;
const SUB2 = "0x5ab0000000000000000000000000000000000002" as const;
const OTHER_MASTER = "0x0e70c1fcf113afa33c47d8bd0f16e1e7bdd62744" as const;
const FOREIGN_SUB = "0xf0e1000000000000000000000000000000000003" as const;
const VAULT = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303" as const;

const registry = MarketRegistry.fromInfo({ meta: META0 });
const baseline = createBaselinePolicy({ address: BUILDER, feeTenthsBps: 25 });
const marks = { BTC: 100_000, ETH: 2_000, SOL: 150 };
const codes = (d: { violations: Array<{ code: string }> }) => d.violations.map((v) => v.code);
const violationCodes = (e: { details?: { violations?: Array<{ code: string }> } }) => e.details?.violations?.map((v) => v.code) ?? [];
const subInfoCalls = (h: FrameHarness) => h.hl.infoCalls.filter((c) => c.type === "subAccounts");

function evalFor(vault: `0x${string}` | undefined, extra: Partial<Parameters<typeof evaluateFramePolicy>[0]> = {}) {
  const compiled = compileAction(limitOrder(vault ? { vaultAddress: vault } : {}) as never, { registry, builder: { address: BUILDER, feeTenthsBps: 25 } });
  return evaluateFramePolicy({ compiled, expiresAfter: T0 + 15_000, now: T0, policy: baseline, registry, markPrices: marks, ordersInLastMinute: 0, dailyNotionalUsedUsd: 0, ...extra });
}

describe("frame policy: vaultAddress", () => {
  it("allows a vaultAddress only when it is the sub-account the frame verified", () => {
    expect(evalFor(SUB, { ownedSubAccount: SUB }).allowed).toBe(true);
    expect(evalFor(SUB.toUpperCase().replace("0X", "0x") as `0x${string}`, { ownedSubAccount: SUB }).allowed).toBe(true);
    expect(codes(evalFor(SUB))).toContain("VAULT_NOT_ALLOWED");
    expect(codes(evalFor(SUB, { ownedSubAccount: SUB2 }))).toContain("VAULT_NOT_ALLOWED");
    expect(evalFor(undefined, { ownedSubAccount: SUB }).allowed).toBe(true);
  });

  it("ignores the policy object's allowedVaultAddresses", () => {
    const permissive = { ...baseline, allowedVaultAddresses: [VAULT] };
    expect(codes(evalFor(VAULT, { policy: permissive }))).toContain("VAULT_NOT_ALLOWED");
    // A verified sub-account is allowed even though the policy object lists nothing.
    expect(evalFor(SUB, { policy: { ...baseline, allowedVaultAddresses: [] }, ownedSubAccount: SUB }).allowed).toBe(true);
  });

  it("denies a compiled action whose vaultAddress differs from the intent's", () => {
    const compiled = compileAction(limitOrder({ vaultAddress: SUB }) as never, { registry, builder: { address: BUILDER, feeTenthsBps: 25 } });
    const tampered = { ...compiled, vaultAddress: SUB2 };
    const d = evaluateFramePolicy({ compiled: tampered, expiresAfter: T0 + 15_000, now: T0, policy: baseline, registry, markPrices: marks, ordersInLastMinute: 0, dailyNotionalUsedUsd: 0, ownedSubAccount: SUB2 });
    expect(codes(d)).toContain("VAULT_NOT_ALLOWED");
  });

  it("keeps the baseline daily cap per agent, across accounts", () => {
    const near = BASELINE_LIMITS.maxDailyNotionalUsd - 100;
    // $200 order: the account itself has used nothing today, the agent has used almost everything.
    expect(codes(evalFor(SUB, { ownedSubAccount: SUB, dailyNotionalUsedUsd: 0, agentDailyNotionalUsedUsd: near }))).toContain("DAILY_NOTIONAL_EXCEEDED");
    expect(evalFor(SUB, { ownedSubAccount: SUB, dailyNotionalUsedUsd: 0, agentDailyNotionalUsedUsd: near - 200 }).allowed).toBe(true);
  });

  it("picks an account's own limits, else the master's", () => {
    const master = { ...baseline, maxOrderNotionalUsd: 500 };
    const own = { ...baseline, maxOrderNotionalUsd: 50 };
    const map = new Map([[SUB, { policy: own, limits: { maxOrderNotionalUsd: 50 } }]]);
    expect(policyForAccount(master, map, undefined)).toBe(master);
    expect(policyForAccount(master, map, SUB.toUpperCase().replace("0X", "0x"))).toBe(own);
    expect(policyForAccount(master, map, SUB2)).toBe(master);
    expect(limitsForAccount({ maxOrderNotionalUsd: 500 }, map, SUB)).toEqual({ maxOrderNotionalUsd: 50 });
    expect(limitsForAccount(null, map, SUB2)).toBeNull();
  });
});

describe("signAndSubmit for a sub-account", () => {
  async function ready(subs: unknown[] | null = [subAccountEntry(SUB), subAccountEntry(SUB2, USER, "Scalp")]) {
    h = await FrameHarness.create();
    h.hl.subAccounts[USER.toLowerCase()] = subs;
    return await h.activeAgent("device");
  }

  it("signs for the master's own sub-account with vaultAddress in the request and the signature", async () => {
    const agent = await ready();
    const r = await h.ok("signAndSubmit", { requestId: "s1", intent: limitOrder({ vaultAddress: SUB }) });
    expect(r.status).toBe("ok");
    const body = h.hl.exchangeCalls.at(-1)!.body;
    expect(body.vaultAddress).toBe(SUB);
    expect(body.action.type).toBe("order");
    expect((body.action as { builder?: unknown }).builder).toEqual({ b: BUILDER, f: 25 });
    // The signature covers the vault: it recovers to the agent only with it.
    const withVault = await recoverL1Signer({ action: body.action, nonce: body.nonce, network: TESTNET, vaultAddress: SUB, expiresAfter: body.expiresAfter, signature: body.signature as Signature });
    expect(withVault.toLowerCase()).toBe(agent.address.toLowerCase());
    const without = await recoverL1Signer({ action: body.action, nonce: body.nonce, network: TESTNET, expiresAfter: body.expiresAfter, signature: body.signature as Signature });
    expect(without.toLowerCase()).not.toBe(agent.address.toLowerCase());
    // The frame asked HL about the key's master, not about anything the parent said.
    expect(subInfoCalls(h)).toEqual([{ type: "subAccounts", user: USER.toLowerCase() }]);
  });

  it("signs cancels, leverage changes and the dead-man's switch for the sub-account too", async () => {
    await ready();
    await h.ok("signAndSubmit", { requestId: "c", intent: { kind: "cancel", cancels: [{ coin: "ETH", oid: 7 }], origin: "manual", vaultAddress: SUB } });
    await h.ok("signAndSubmit", { requestId: "l", intent: { kind: "updateLeverage", coin: "ETH", leverage: 3, marginMode: "isolated", origin: "manual", vaultAddress: SUB } });
    await h.ok("signAndSubmit", { requestId: "d", intent: { kind: "scheduleCancel", time: T0 + 60_000, origin: "manual", vaultAddress: SUB } });
    expect(h.hl.exchangeCalls.map((c) => c.body.vaultAddress)).toEqual([SUB, SUB, SUB]);
  });

  it("denies a vault the master leads, another master's sub-account and the master's own address", async () => {
    await ready([subAccountEntry(SUB), subAccountEntry(FOREIGN_SUB, OTHER_MASTER)]);
    for (const [id, address] of [
      ["v", VAULT],
      ["f", FOREIGN_SUB],
      ["m", USER],
    ] as const) {
      const e = await h.fail("signAndSubmit", { requestId: id, intent: limitOrder({ vaultAddress: address }) });
      expect(e.code).toBe("POLICY_DENIED");
      expect(violationCodes(e)).toContain("VAULT_NOT_ALLOWED");
    }
    expect(h.hl.exchangeCalls).toHaveLength(0);
    expect((await h.ok("getStatus")).metrics.policyDenials).toBe(3);
  });

  it("denies every vaultAddress when the master has no sub-accounts", async () => {
    await ready(null);
    const e = await h.fail("signAndSubmit", { requestId: "n", intent: limitOrder({ vaultAddress: SUB }) });
    expect(violationCodes(e)).toContain("VAULT_NOT_ALLOWED");
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("signs nothing when HL's sub-account list can't be read, and the requestId can be retried", async () => {
    await ready();
    h.hl.infoFailure = (b) => b.type === "subAccounts";
    const e = await h.fail("signAndSubmit", { requestId: "x", intent: limitOrder({ vaultAddress: SUB }) });
    expect(e.code).toBe("MARKET_DATA_UNAVAILABLE");
    expect(e.retryable).toBe(true);
    expect(h.hl.exchangeCalls).toHaveLength(0);
    h.hl.infoFailure = null;
    h.hl.subAccounts[USER.toLowerCase()] = { error: "unexpected" };
    expect((await h.fail("signAndSubmit", { requestId: "x", intent: limitOrder({ vaultAddress: SUB }) })).code).toBe("MARKET_DATA_UNAVAILABLE");
    h.hl.subAccounts[USER.toLowerCase()] = [subAccountEntry(SUB)];
    expect((await h.ok("signAndSubmit", { requestId: "x", intent: limitOrder({ vaultAddress: SUB }) })).status).toBe("ok");
  });

  it("caches the list briefly and finds a sub-account created a moment ago", async () => {
    await ready([subAccountEntry(SUB)]);
    await h.ok("signAndSubmit", { requestId: "a", intent: limitOrder({ vaultAddress: SUB }) });
    await h.ok("signAndSubmit", { requestId: "b", intent: limitOrder({ vaultAddress: SUB }) });
    expect(subInfoCalls(h)).toHaveLength(1);
    // A new sub-account: denied while the list is fresh, found once it is a few seconds old.
    expect(violationCodes(await h.fail("signAndSubmit", { requestId: "c", intent: limitOrder({ vaultAddress: SUB2 }) }))).toContain("VAULT_NOT_ALLOWED");
    h.hl.subAccounts[USER.toLowerCase()] = [subAccountEntry(SUB), subAccountEntry(SUB2)];
    h.clock.advance(5_000);
    expect((await h.ok("signAndSubmit", { requestId: "d", intent: limitOrder({ vaultAddress: SUB2 }) })).status).toBe("ok");
    expect(subInfoCalls(h)).toHaveLength(2);
    // Master orders never read the list.
    await h.ok("signAndSubmit", { requestId: "e", intent: limitOrder() });
    expect(subInfoCalls(h)).toHaveLength(2);
  });

  it("gives the parent no way to claim ownership", async () => {
    await ready([subAccountEntry(SUB)]);
    // Extra fields are rejected by the strict schemas; limits for an account grant nothing.
    expect((await h.fail("signAndSubmit", { requestId: "p", intent: limitOrder({ vaultAddress: VAULT }), ownedSubAccount: VAULT })).code).toBe("INVALID_REQUEST");
    expect((await h.fail("signAndSubmit", { requestId: "q", intent: { ...limitOrder({ vaultAddress: VAULT }), ownedSubAccount: VAULT } })).code).toBe("INVALID_INTENT");
    await h.ok("setLimits", { account: VAULT, maxOrderNotionalUsd: 100 });
    expect(violationCodes(await h.fail("signAndSubmit", { requestId: "r", intent: limitOrder({ vaultAddress: VAULT, size: "0.01" }) }))).toContain("VAULT_NOT_ALLOWED");
  });
});

describe("limits per account", () => {
  async function ready() {
    h = await FrameHarness.create();
    h.hl.subAccounts[USER.toLowerCase()] = [subAccountEntry(SUB), subAccountEntry(SUB2, USER, "Scalp")];
    await h.activeAgent("device");
  }

  it("applies a sub-account's own limits to that account only, and the master's to the others", async () => {
    await ready();
    await h.ok("setLimits", { maxOrderNotionalUsd: 500 });
    const r = await h.ok("setLimits", { account: SUB.toUpperCase().replace("0X", "0x"), maxOrderNotionalUsd: 100 });
    expect(r.policy.userLimits).toEqual({ maxOrderNotionalUsd: 500 });
    expect(r.policy.accountLimits).toEqual({ [SUB]: { maxOrderNotionalUsd: 100 } });
    expect(r.policy.maxOrderNotionalUsd).toBe(500);
    // $200 order: too big for SUB's own $100, fine for the master's $500 (master and SUB2).
    expect(violationCodes(await h.fail("signAndSubmit", { requestId: "a", intent: limitOrder({ vaultAddress: SUB }) }))).toContain("ORDER_NOTIONAL_EXCEEDED");
    expect((await h.ok("signAndSubmit", { requestId: "b", intent: limitOrder() })).status).toBe("ok");
    expect((await h.ok("signAndSubmit", { requestId: "c", intent: limitOrder({ vaultAddress: SUB2 }) })).status).toBe("ok");
    // SUB2 has no limits of its own, so the master's $500 applies to it.
    expect(violationCodes(await h.fail("signAndSubmit", { requestId: "d", intent: limitOrder({ vaultAddress: SUB2, size: "0.3" }) }))).toContain("ORDER_NOTIONAL_EXCEEDED");
    // `{ account }` alone: SUB uses the master's limits again.
    const reset = await h.ok("setLimits", { account: SUB });
    expect(reset.policy.accountLimits).toEqual({});
    expect((await h.ok("signAndSubmit", { requestId: "e", intent: limitOrder({ vaultAddress: SUB }) })).status).toBe("ok");
  });

  it("never lets an account's limits loosen the baseline, and setting the master's own address sets the master's", async () => {
    await ready();
    expect((await h.fail("setLimits", { account: SUB, maxOrderNotionalUsd: 2_000_000 })).code).toBe("LIMIT_LOOSENING_REJECTED");
    expect((await h.fail("setLimits", { account: "0x12" })).code).toBe("INVALID_REQUEST");
    const r = await h.ok("setLimits", { account: USER, maxLeverage: 4 });
    expect(r.policy.userLimits).toEqual({ maxLeverage: 4 });
    expect(r.policy.accountLimits).toEqual({});
  });

  it("reads the sub-account's own leverage for a tightened leverage cap", async () => {
    await ready();
    await h.ok("setLimits", { account: SUB, maxLeverage: 5 });
    h.hl.leverageByUser[SUB] = { ETH: 20 };
    h.hl.leverageByUser[USER.toLowerCase()] = { ETH: 3 };
    expect(violationCodes(await h.fail("signAndSubmit", { requestId: "a", intent: limitOrder({ vaultAddress: SUB }) }))).toContain("LEVERAGE_EXCEEDED");
    expect(h.hl.infoCalls.filter((c) => c.type === "activeAssetData").map((c) => c.user)).toEqual([SUB]);
    h.hl.leverageByUser[SUB] = { ETH: 5 };
    h.clock.advance(5_000);
    expect((await h.ok("signAndSubmit", { requestId: "b", intent: limitOrder({ vaultAddress: SUB }) })).status).toBe("ok");
  });

  it("counts daily notional per account for personal limits", async () => {
    await ready();
    await h.ok("setLimits", { maxDailyNotionalUsd: 1_000 });
    await h.ok("setLimits", { account: SUB, maxDailyNotionalUsd: 1_000 });
    expect((await h.ok("signAndSubmit", { requestId: "m1", intent: limitOrder({ size: "0.4" }) })).status).toBe("ok"); // master $800
    expect(violationCodes(await h.fail("signAndSubmit", { requestId: "m2", intent: limitOrder({ size: "0.2" }) }))).toContain("DAILY_NOTIONAL_EXCEEDED");
    // The sub-account's own $1,000 is untouched by the master's trading.
    expect((await h.ok("signAndSubmit", { requestId: "s1", intent: limitOrder({ vaultAddress: SUB, size: "0.4" }) })).status).toBe("ok");
    expect(violationCodes(await h.fail("signAndSubmit", { requestId: "s2", intent: limitOrder({ vaultAddress: SUB, size: "0.2" }) }))).toContain("DAILY_NOTIONAL_EXCEEDED");
  });
});

describe("usage records per account", () => {
  const master = { account: USER.toLowerCase(), master: USER.toLowerCase() };
  const sub = { account: SUB, master: USER.toLowerCase() };
  it("keeps agent totals and per-account notional, and resets both daily", () => {
    const a = nextUsage("0xA", undefined, T0, 1, 100, master);
    const b = nextUsage("0xa", a, T0 + 1, 1, 30, sub);
    expect(b.dayNotionalUsd).toBe(130);
    expect(b.accountNotionalUsd).toEqual({ [USER.toLowerCase()]: 100, [SUB]: 30 });
    expect(usageOf(b, T0 + 2, sub)).toEqual({ ordersInLastMinute: 2, dailyNotionalUsedUsd: 130, accountDailyNotionalUsd: 30 });
    expect(usageOf(b, T0 + 2, master).accountDailyNotionalUsd).toBe(100);
    const tomorrow = nextUsage("0xa", b, T0 + 86_400_000, 0, 5, sub);
    expect(tomorrow.accountNotionalUsd).toEqual({ [SUB]: 5 });
    expect(usageOf(b, T0 + 86_400_000, sub).accountDailyNotionalUsd).toBe(0);
  });
  it("reads a record from before sub-accounts as the master's", () => {
    const legacy = { agent: "0xa", lastNonce: T0, orderTimes: [T0], day: new Date(T0).toISOString().slice(0, 10), dayNotionalUsd: 400 };
    expect(usageOf(legacy, T0, master).accountDailyNotionalUsd).toBe(400);
    expect(usageOf(legacy, T0, sub).accountDailyNotionalUsd).toBe(0);
    const next = nextUsage("0xa", legacy, T0 + 1, 1, 50, sub);
    expect(next.accountNotionalUsd).toEqual({ [USER.toLowerCase()]: 400, [SUB]: 50 });
    expect(next.dayNotionalUsd).toBe(450);
  });
});

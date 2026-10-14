/**
 * Personal limits stored by the frame itself (IndexedDB on the signer origin, per network): they survive reloads, bind
 * every tab and need no key. Tightening and identical limits apply silently; anything looser waits for the user's
 * click on the frame's own prompt, so a compromised parent can't drop them.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBaselinePolicy, limitChanges, storedUserLimits } from "../src/frame/policy.js";
import type { UserLimits } from "../src/protocol/index.js";
import { BUILDER, FakeBus, FakeLocks, FrameHarness, limitOrder, subAccountEntry, testConfig, USER, waitFor, type HarnessOptions } from "./helpers.js";

const harnesses: FrameHarness[] = [];
async function frame(o: HarnessOptions = {}): Promise<FrameHarness> {
  const h = await FrameHarness.create(o);
  harnesses.push(h);
  return h;
}
afterEach(() => {
  for (const h of harnesses.splice(0)) h.destroy();
});

const SUB = "0x5ab0000000000000000000000000000000000001" as const;
const SUB2 = "0x5ab0000000000000000000000000000000000002" as const;
const feeTrial = { kind: "startFeeTrial", origin: "manual", tier: 1 };
const codes = (e: { details?: { violations?: Array<{ code: string }> } }) => (e.details?.violations ?? []).map((v) => v.code);
/** A $200 ETH buy (0.1 at 2000). */
const order = (requestId: string, o: Record<string, unknown> = {}) => ({ requestId, intent: limitOrder(o) });
const shownPrompts = (h: FrameHarness) => h.events("promptChanged").filter((e) => e.visible);

/** Sends a loosening setLimits and waits until the frame shows its prompt; `answer` is the frame's response. */
async function asking(h: FrameHarness, params: Record<string, unknown>) {
  const answer = h.request("setLimits", params);
  await waitFor(() => h.promptText() !== "");
  return { answer };
}

/** Two frames ("tabs") on one browser profile: shared IndexedDB and Web Locks, optionally a BroadcastChannel. */
async function twoTabs(o: { broadcast?: boolean } = {}) {
  const bus = o.broadcast === false ? undefined : new FakeBus();
  const locks = new FakeLocks();
  const a = await frame({ locks, ...(bus ? { bus } : {}) });
  await a.activeAgent("device");
  const b = await frame({ idb: a.idb, clock: a.clock, hl: a.hl, locks, ...(bus ? { bus } : {}) });
  await b.ok("hello", { protocolVersion: 1 });
  return { a, b, locks };
}

describe("limits stored by the frame", () => {
  it("announces confirmsLooserLimits in the handshake", async () => {
    const h = await frame();
    expect((await h.ok("hello", { protocolVersion: 1 })).capabilities.confirmsLooserLimits).toBe(true);
  });

  it("keeps a $100 cap through a reset until the user confirms it in the frame", async () => {
    const h = await frame();
    await h.activeAgent("device");
    expect((await h.ok("setLimits", { maxOrderNotionalUsd: 100 })).policy.maxOrderNotionalUsd).toBe(100);
    expect(shownPrompts(h)).toHaveLength(0);

    const reset = await asking(h, {});
    expect(h.events("promptChanged").at(-1)).toEqual({ visible: true, kind: "limits" });
    expect(h.root?.querySelector(".ks-title")?.textContent).toBe("Loosen your trading limits?");
    expect(h.promptText()).toContain("Largest order: $100 → $250,000");
    // Shown in the frame's own fixed style, whatever theme the parent set, and confirmed by pressing and holding.
    expect(h.root?.querySelector(".ks-prompt")?.classList.contains("ks-prompt--fixed")).toBe(true);
    expect(h.root?.querySelector(".ks-primary")?.classList.contains("ks-hold")).toBe(true);
    // While the prompt waits, the cap holds.
    expect(codes(await h.fail("signAndSubmit", order("o1")))).toContain("ORDER_NOTIONAL_EXCEEDED");
    expect((await h.ok("getStatus")).policy.maxOrderNotionalUsd).toBe(100);

    await h.clickPrompt();
    const r = await reset.answer;
    expect(r.ok && r.result.policy).toMatchObject({ maxOrderNotionalUsd: 250_000, userLimits: null });
    expect((await h.ok("signAndSubmit", order("o2"))).status).toBe("ok");
  });

  it("keeps it through an increase the user cancels or doesn't answer, and signing stays capped", async () => {
    const h = await frame();
    await h.activeAgent("device");
    await h.ok("setLimits", { maxOrderNotionalUsd: 100 });
    const raise = await asking(h, { maxOrderNotionalUsd: 5_000 });
    expect(h.promptText()).toContain("Largest order: $100 → $5,000");
    await h.clickPrompt("cancel");
    const cancelled = await raise.answer;
    expect(!cancelled.ok && cancelled.error).toMatchObject({ code: "USER_CANCELLED", retryable: true });
    expect((await h.ok("getStatus")).policy.userLimits).toEqual({ maxOrderNotionalUsd: 100 });
    expect(codes(await h.fail("signAndSubmit", order("o1")))).toContain("ORDER_NOTIONAL_EXCEEDED");

    const slow = await frame({ promptTimeoutMs: 50 });
    await slow.activeAgent("device");
    await slow.ok("setLimits", { maxOrderNotionalUsd: 100 });
    expect((await slow.fail("setLimits", { maxOrderNotionalUsd: 5_000 })).code).toBe("USER_TIMEOUT");
    expect((await slow.fail("setLimits", {})).code).toBe("USER_TIMEOUT");
    expect((await slow.ok("getStatus")).policy.userLimits).toEqual({ maxOrderNotionalUsd: 100 });
    expect(codes(await slow.fail("signAndSubmit", order("o2")))).toContain("ORDER_NOTIONAL_EXCEEDED");
    expect(slow.hl.exchangeCalls).toHaveLength(0);
  });

  it("never asks for a tightening or for identical limits", async () => {
    const h = await frame();
    await h.activeAgent("device");
    const steps: UserLimits[] = [
      { maxOrderNotionalUsd: 500 },
      { maxOrderNotionalUsd: 400, allowedCoins: ["ETH", "BTC"] },
      { maxOrderNotionalUsd: 400, allowedCoins: ["ETH"], maxLeverage: 5, requireStopLossForNewEntries: true },
      { maxOrderNotionalUsd: 400, allowedCoins: ["ETH"], maxLeverage: 3, requireStopLossForNewEntries: true, allowedActionTypes: ["order", "cancel"], priceBandPct: 2 },
    ];
    for (const limits of steps) expect((await h.ok("setLimits", limits)).policy.userLimits).toEqual(limits);
    // The app sends the same limits again at every handshake: nothing changes, nothing is emitted.
    const events = h.parent.posted.length;
    expect((await h.ok("setLimits", steps.at(-1)!)).policy.userLimits).toEqual(steps.at(-1));
    expect(h.parent.posted.length).toBe(events + 1);
    // Spot trading off and the same coins in another order are no loosening either.
    await h.ok("setLimits", { ...steps.at(-1)!, allowedCoins: ["ETH"], spotTrading: false });
    expect(shownPrompts(h)).toHaveLength(0);
  });

  it("asks for every kind of loosening, listing each change in plain words", async () => {
    const h = await frame();
    await h.ok("hello", { protocolVersion: 1 });
    const start: UserLimits = {
      maxOrderNotionalUsd: 500,
      maxDailyNotionalUsd: 5_000,
      maxLeverage: 5,
      maxOrdersPerMinute: 10,
      priceBandPct: 3,
      allowedCoins: ["ETH", "BTC"],
      requireStopLossForNewEntries: true,
      allowedActionTypes: ["order", "cancel"],
    };
    // No key needed for the master's limits.
    await h.ok("setLimits", start);
    const { maxLeverage: _, ...withoutLeverage } = start;
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ ...start, maxOrderNotionalUsd: 600 }, ["Largest order: $500 → $600"]],
      [{ ...start, maxDailyNotionalUsd: 6_000 }, ["Trading per day: $5,000 → $6,000"]],
      [{ ...start, maxOrdersPerMinute: 11 }, ["Orders per minute: 10 → 11"]],
      [{ ...start, priceBandPct: 4 }, ["Price distance from the market: 3% → 4%"]],
      [withoutLeverage, ["Leverage: up to 5x → up to 50x"]],
      [{ ...start, spotTrading: true }, ["Spot trading: off → on"]],
      [{ ...start, allowedCoins: ["ETH", "BTC", "SOL"] }, ["Markets: ETH, BTC → ETH, BTC, SOL"]],
      [{ ...start, allowedCoins: ["SOL"] }, ["Markets: ETH, BTC → SOL"]],
      // Coin names come from the parent: no control characters reach the frame's own text, and long lists are cut.
      [{ ...start, allowedCoins: ["ETH", "BTC", "A\u202eB", "C", "D", "E", "F", "G"] }, ["Markets: ETH, BTC → ETH, BTC, A?B, C, D, E and 2 more"]],
      [{ ...start, allowedActionTypes: ["order", "cancel", "modify"] }, ["Allowed actions: order, cancel → order, cancel, modify"]],
      [{ ...start, requireStopLossForNewEntries: false }, ["Stop-loss on new positions: required → not required"]],
      // A tightening next to a loosening: one prompt lists both.
      [{ ...start, maxOrderNotionalUsd: 100, maxLeverage: 10 }, ["Largest order: $500 → $100", "Leverage: up to 5x → up to 10x"]],
      [{}, ["Largest order: $500 → $250,000", "Trading per day: $5,000 → $25,000,000", "Price distance from the market: 3% → 5%", "Markets: ETH, BTC → all", "Allowed actions: order, cancel → all"]],
    ];
    for (const [limits, lines] of cases) {
      const pending = await asking(h, limits);
      for (const line of lines) expect(h.promptText()).toContain(line);
      await h.clickPrompt("cancel");
      const r = await pending.answer;
      expect(!r.ok && r.error.code).toBe("USER_CANCELLED");
      expect((await h.ok("getStatus")).policy.userLimits).toEqual(start);
    }
    expect(shownPrompts(h)).toHaveLength(cases.length);
  });

  it("still refuses anything above the baseline, without a prompt", async () => {
    const h = await frame();
    await h.ok("hello", { protocolVersion: 1 });
    await h.ok("setLimits", { maxOrderNotionalUsd: 100 });
    const e = await h.fail("setLimits", { maxOrderNotionalUsd: 300_000, maxLeverage: 51, priceBandPct: 6 });
    expect(e).toMatchObject({ code: "LIMIT_LOOSENING_REJECTED", details: { fields: ["maxOrderNotionalUsd", "priceBandPct", "maxLeverage"] } });
    expect(shownPrompts(h)).toHaveLength(0);
    expect((await h.ok("getStatus")).policy.maxOrderNotionalUsd).toBe(100);
  });

  it("refuses a loosening when the frame has no user interface to ask with", async () => {
    const h = await frame({ withUi: false });
    await h.ok("hello", { protocolVersion: 1 });
    await h.ok("setLimits", { maxOrderNotionalUsd: 100, maxLeverage: 3 });
    expect(await h.fail("setLimits", { maxLeverage: 3 })).toMatchObject({ code: "LIMIT_LOOSENING_REJECTED", details: { fields: ["maxOrderNotionalUsd"] } });
    expect((await h.ok("setLimits", { maxOrderNotionalUsd: 50, maxLeverage: 3 })).policy.maxOrderNotionalUsd).toBe(50);
  });

  it("applies a tightening before a request sent right after it", async () => {
    const h = await frame();
    await h.activeAgent("device");
    const [limits, signed] = await Promise.all([h.request("setLimits", { maxOrderNotionalUsd: 100 }), h.request("signAndSubmit", order("o1"))]);
    expect(limits.ok).toBe(true);
    expect(!signed.ok && codes(signed.error)).toContain("ORDER_NOTIONAL_EXCEEDED");
  });

  it("asks for a second loosening once the first prompt has closed", async () => {
    const h = await frame();
    await h.ok("hello", { protocolVersion: 1 });
    await h.ok("setLimits", { maxOrderNotionalUsd: 100 });
    const first = await asking(h, { maxOrderNotionalUsd: 200 });
    const second = h.request("setLimits", { maxOrderNotionalUsd: 300 });
    expect(h.promptText()).toContain("$100 → $200");
    await h.clickPrompt();
    expect((await first.answer).ok).toBe(true);
    await waitFor(() => h.promptText().includes("$200 → $300"));
    await h.clickPrompt();
    const r = await second;
    expect(r.ok && r.result.policy.maxOrderNotionalUsd).toBe(300);
  });

  it("applies a tightening at once while a loosening waits, and then refuses the loosening confirmed against older limits", async () => {
    const h = await frame();
    await h.ok("hello", { protocolVersion: 1 });
    await h.ok("setLimits", { maxOrderNotionalUsd: 500 });
    const raise = await asking(h, { maxOrderNotionalUsd: 5_000 });
    expect((await h.ok("setLimits", { maxOrderNotionalUsd: 100 })).policy.maxOrderNotionalUsd).toBe(100);
    await h.clickPrompt();
    const r = await raise.answer;
    expect(!r.ok && r.error).toMatchObject({ code: "SIGNER_BUSY", retryable: true });
    expect((await h.ok("getStatus")).policy.maxOrderNotionalUsd).toBe(100);
  });
});

describe("limits across reloads and tabs", () => {
  it("needs no key and survives a reload: a new frame on the same storage starts capped", async () => {
    const a = await frame();
    await a.ok("hello", { protocolVersion: 1 });
    await a.ok("setLimits", { maxOrderNotionalUsd: 100, spotTrading: false });
    a.destroy();

    const b = await frame({ idb: a.idb, clock: a.clock, hl: a.hl });
    const hello = await b.ok("hello", { protocolVersion: 1 });
    expect(hello.status.policy).toMatchObject({ maxOrderNotionalUsd: 100, userLimits: { maxOrderNotionalUsd: 100 } });
    await b.activeAgent("device");
    expect(codes(await b.fail("signAndSubmit", order("o1")))).toContain("ORDER_NOTIONAL_EXCEEDED");
    // Still the stored $100 the reset is compared with: it needs the click.
    const reset = await asking(b, {});
    expect(b.promptText()).toContain("Largest order: $100 → $250,000");
    await b.clickPrompt("cancel");
    expect((await reset.answer).ok).toBe(false);
  });

  it("keeps each network's limits apart", async () => {
    const a = await frame();
    await a.ok("hello", { protocolVersion: 1 });
    await a.ok("setLimits", { maxOrderNotionalUsd: 100 });
    const mainnet = await frame({ idb: a.idb, clock: a.clock, hl: a.hl, config: testConfig({ VITE_HL_NETWORK: "mainnet", VITE_ALLOW_MAINNET_WRITES: "true" }) });
    expect((await mainnet.ok("hello", { protocolVersion: 1 })).status.policy.userLimits).toBeNull();
    expect((await mainnet.ok("setLimits", { maxOrderNotionalUsd: 300 })).policy.maxOrderNotionalUsd).toBe(300);
    expect((await a.ok("getStatus")).policy.maxOrderNotionalUsd).toBe(100);
  });

  it("binds another tab at once: its status changes and its next signature is capped", async () => {
    const { a, b } = await twoTabs();
    await a.ok("setLimits", { maxOrderNotionalUsd: 100, allowedActionTypes: ["order", "cancel"] });
    await waitFor(() => b.events("statusChanged").some((s) => s.policy.maxOrderNotionalUsd === 100));
    expect(codes(await b.fail("signAndSubmit", order("b1")))).toContain("ORDER_NOTIONAL_EXCEEDED");
    // Account actions too (the master's limits leave out startFeeTrial).
    expect(codes(await b.fail("signAndSubmit", { requestId: "b2", intent: feeTrial }))).toEqual(["ACTION_TYPE_NOT_ALLOWED"]);
    // A loosening the user confirmed in one tab applies in the other.
    await a.loosen({ maxOrderNotionalUsd: 5_000 });
    expect((await b.ok("signAndSubmit", order("b3"))).status).toBe("ok");
    expect(shownPrompts(b)).toHaveLength(0);
  });

  it("binds another tab without a BroadcastChannel: limits are read again before each signature", async () => {
    const { a, b } = await twoTabs({ broadcast: false });
    expect((await b.ok("signAndSubmit", order("b1"))).status).toBe("ok");
    await a.ok("setLimits", { maxOrderNotionalUsd: 100 });
    expect(codes(await b.fail("signAndSubmit", order("b2")))).toContain("ORDER_NOTIONAL_EXCEEDED");
    expect((await b.ok("getStatus")).policy.maxOrderNotionalUsd).toBe(100);
  });

  it("reads the limits again under the signing lock: a change made while a signature waited for it binds it", async () => {
    const { a, b, locks } = await twoTabs();
    let answer!: () => void;
    const held = new Promise<void>((r) => (answer = r));
    a.hl.responder = async (call) => {
      await held;
      return a.hl.defaultExchange(call);
    };
    // Tab b holds the agent's signing lock while Hyperliquid answers; tab a checks its limits, then waits for the lock.
    const first = b.request("signAndSubmit", order("b1"));
    await waitFor(() => a.hl.exchangeCalls.length === 1);
    const second = a.request("signAndSubmit", order("a1"));
    await waitFor(() => locks.requests.filter((n) => n.includes("/sign/")).length === 2);
    await b.ok("setLimits", { maxOrderNotionalUsd: 100 });
    answer();
    expect((await first).ok).toBe(true);
    const r = await second;
    expect(!r.ok && codes(r.error)).toContain("ORDER_NOTIONAL_EXCEEDED");
    expect(a.hl.exchangeCalls).toHaveLength(1);
  });

  it("refuses a loosening confirmed in one tab after another tab changed the limits", async () => {
    const { a, b } = await twoTabs();
    await a.ok("setLimits", { maxOrderNotionalUsd: 500 });
    const raise = await asking(a, { maxOrderNotionalUsd: 5_000 });
    await b.ok("setLimits", { maxOrderNotionalUsd: 100 });
    await a.clickPrompt();
    const r = await raise.answer;
    expect(!r.ok && r.error.code).toBe("SIGNER_BUSY");
    expect((await a.ok("getStatus")).policy.maxOrderNotionalUsd).toBe(100);
    expect(codes(await a.fail("signAndSubmit", order("a1")))).toContain("ORDER_NOTIONAL_EXCEEDED");
  });
});

describe("sub-account limits", () => {
  async function ready(o: HarnessOptions = {}) {
    const h = await frame(o);
    h.hl.subAccounts[USER.toLowerCase()] = [subAccountEntry(SUB), subAccountEntry(SUB2, USER, "Scalp")];
    await h.activeAgent("device");
    await h.ok("setLimits", { maxOrderNotionalUsd: 500, maxDailyNotionalUsd: 1_000 });
    await h.ok("setLimits", { account: SUB, maxOrderNotionalUsd: 100 });
    expect(shownPrompts(h)).toHaveLength(0);
    return h;
  }

  it("asks before a sub-account falls back to the master's looser limits, and keeps its cap until then", async () => {
    const h = await ready();
    expect(codes(await h.fail("signAndSubmit", order("s1", { vaultAddress: SUB })))).toContain("ORDER_NOTIONAL_EXCEEDED");
    const removing = await asking(h, { account: SUB });
    expect(h.promptText()).toContain("the limits of sub-account 0x5ab0…0001");
    expect(h.promptText()).toContain("Largest order: $100 → $500");
    await h.clickPrompt("cancel");
    expect((await removing.answer).ok).toBe(false);
    expect((await h.ok("getStatus")).policy.accountLimits).toEqual({ [SUB]: { maxOrderNotionalUsd: 100 } });
    expect(codes(await h.fail("signAndSubmit", order("s2", { vaultAddress: SUB })))).toContain("ORDER_NOTIONAL_EXCEEDED");

    const raising = await asking(h, { account: SUB, maxOrderNotionalUsd: 300 });
    expect(h.promptText()).toContain("Largest order: $100 → $300");
    await h.clickPrompt();
    expect((await raising.answer).ok).toBe(true);
    expect((await h.ok("signAndSubmit", order("s3", { vaultAddress: SUB }))).status).toBe("ok");
  });

  it("times out without changing a sub-account's limits", async () => {
    const h = await ready({ promptTimeoutMs: 50 });
    expect((await h.fail("setLimits", { account: SUB })).code).toBe("USER_TIMEOUT");
    expect((await h.fail("setLimits", { account: SUB, maxOrderNotionalUsd: 300 })).code).toBe("USER_TIMEOUT");
    expect((await h.ok("getStatus")).policy.accountLimits).toEqual({ [SUB]: { maxOrderNotionalUsd: 100 } });
    expect(codes(await h.fail("signAndSubmit", order("s1", { vaultAddress: SUB })))).toContain("ORDER_NOTIONAL_EXCEEDED");
  });

  it("removes or tightens a sub-account's limits silently when the master's are as strict", async () => {
    const h = await ready();
    await h.ok("setLimits", { account: SUB, maxOrderNotionalUsd: 50 });
    // Equal to the master's: nothing loosens for the account, with or without limits of its own.
    await h.ok("setLimits", { account: SUB2, maxOrderNotionalUsd: 500 });
    await h.ok("setLimits", { account: SUB2 });
    expect(shownPrompts(h)).toHaveLength(0);
    expect((await h.ok("getStatus")).policy.accountLimits).toEqual({ [SUB]: { maxOrderNotionalUsd: 50 } });
  });

  it("asks before a sub-account gets a daily counter of its own next to the master's daily limit", async () => {
    const h = await ready();
    const own = await asking(h, { account: SUB2, maxDailyNotionalUsd: 500 });
    expect(h.promptText()).toContain("Trading per day: $1,000 shared with the main account → $500 of its own, on top of the main account's");
    await h.clickPrompt("cancel");
    expect((await own.answer).ok).toBe(false);
    expect((await h.ok("getStatus")).policy.accountLimits).toEqual({ [SUB]: { maxOrderNotionalUsd: 100 } });
  });

  it("keeps a sub-account's limits across a reload and in another tab", async () => {
    const h = await ready();
    const b = await frame({ idb: h.idb, clock: h.clock, hl: h.hl });
    expect((await b.ok("hello", { protocolVersion: 1 })).status.policy.accountLimits).toEqual({ [SUB]: { maxOrderNotionalUsd: 100 } });
    expect(codes(await b.fail("signAndSubmit", order("b1", { vaultAddress: SUB })))).toContain("ORDER_NOTIONAL_EXCEEDED");
    await h.ok("setLimits", { account: SUB2, maxOrderNotionalUsd: 150 });
    expect(codes(await b.fail("signAndSubmit", order("b2", { vaultAddress: SUB2 })))).toContain("ORDER_NOTIONAL_EXCEEDED");
    expect((await b.ok("signAndSubmit", order("b3"))).status).toBe("ok");
  });
});

describe("limitChanges and stored limits", () => {
  const baseline = createBaselinePolicy({ address: BUILDER, feeTenthsBps: 25 });
  const set = (master: UserLimits | null, accounts: Record<string, UserLimits> = {}) => ({ master, accounts: new Map(Object.entries(accounts).map(([a, limits]) => [a, { limits }])) });

  it("compares effective values: the account's own, else the master's, else the baseline's", () => {
    expect(limitChanges(baseline, set({ maxLeverage: 3 }), set({ maxLeverage: 3 }))).toEqual([]);
    expect(limitChanges(baseline, set(null), set({ maxLeverage: 3 }))).toEqual([{ field: "maxLeverage", text: "Leverage: up to 50x → up to 3x", looser: false }]);
    // The sub-account takes the master's value when it sets none: setting the same one is no change.
    expect(limitChanges(baseline, set({ maxLeverage: 3 }), set({ maxLeverage: 3 }, { [SUB]: { maxLeverage: 3 } }), SUB)).toEqual([]);
    expect(limitChanges(baseline, set({ maxLeverage: 3 }, { [SUB]: { maxLeverage: 2 } }), set({ maxLeverage: 3 }), SUB)).toEqual([
      { field: "maxLeverage", text: "Leverage: up to 2x → up to 3x", looser: true },
    ]);
    // A daily counter of its own is looser only next to a daily limit of the master's (else the baseline bounds the day).
    expect(limitChanges(baseline, set(null), set(null, { [SUB]: { maxDailyNotionalUsd: 500 } }), SUB)).toEqual([
      { field: "maxDailyNotionalUsd", text: "Trading per day: $25,000,000 → $500", looser: false },
    ]);
    expect(limitChanges(baseline, set({ maxDailyNotionalUsd: 1_000 }), set({ maxDailyNotionalUsd: 1_000 }, { [SUB]: { maxDailyNotionalUsd: 1_000 } }), SUB)[0]?.looser).toBe(true);
  });

  it("drops stored fields that no longer parse or fit the baseline, so the stricter baseline applies", () => {
    const tighter = { ...baseline, maxOrderNotionalUsd: 1_000 };
    expect(storedUserLimits(tighter, { maxOrderNotionalUsd: 5_000, maxLeverage: 3, unknown: 1, priceBandPct: "x" })).toEqual({ maxLeverage: 3 });
    expect(storedUserLimits(baseline, { allowedActionTypes: ["order", "somethingOld"] })).toEqual({ allowedActionTypes: ["order"] });
    expect(storedUserLimits(baseline, { requireStopLossForNewEntries: false })).toBeNull();
    expect(storedUserLimits(baseline, "garbage")).toBeNull();
    expect(storedUserLimits(baseline, null)).toBeNull();
  });
});

/**
 * Large orders: an action whose orders come to more than $25,000 in all (reduce-only ones included) is signed only after
 * the user presses and holds the button of the frame's own prompt, which says what will be sent. Smaller orders are
 * signed as before, with no prompt.
 */
import { MarketRegistry } from "@kokoah/shared/markets";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmationNeededError, nextUsage, SigningCoordinator, UNPROMPTED_DAY_MS, UNPROMPTED_WINDOW_MS, usageOf, type LockManagerLike } from "../src/frame/nonces.js";
import { CONFIRM_ORDERS_ABOVE_USD, CONFIRM_UNPROMPTED_ABOVE_USD, CONFIRM_UNPROMPTED_DAY_ABOVE_USD, describeOrders } from "../src/frame/policy.js";
import type { UsageRecord } from "../src/frame/storage.js";
import { MemorySignerStore } from "../src/frame/storage.js";
import { cloid, FakeLocks, FrameHarness, limitOrder, META0, subAccountEntry, USER, waitFor, type HarnessOptions } from "./helpers.js";

let h: FrameHarness;
afterEach(() => h?.destroy());

async function ready(o: HarnessOptions = {}): Promise<FrameHarness> {
  h = await FrameHarness.create(o);
  await h.activeAgent("device");
  return h;
}

const codes = (e: { details?: { violations?: Array<{ code: string }> } }) => (e.details?.violations ?? []).map((v) => v.code);
/** A BTC buy at the mark (100,000): 0.3 is $30,000. */
const btc = (size: string, o: Record<string, unknown> = {}) => limitOrder({ coin: "BTC", size, price: "100000", ...o });
const orderPrompts = () => h.promptEvents().filter((e) => e.visible && e.kind === "order");
const shown = () => waitFor(() => h.promptText() !== "");

describe("large orders", () => {
  it("are announced in the handshake with the threshold", async () => {
    h = await FrameHarness.create();
    const hello = await h.ok("hello", { protocolVersion: 1 });
    expect(hello.capabilities.confirmsLargeOrders).toBe(true);
    expect(hello.limits.confirmOrdersAboveUsd).toBe(25_000);
    expect(CONFIRM_ORDERS_ABOVE_USD).toBe(25_000);
  });

  it("signs orders up to $25,000 in all at once, with no prompt", async () => {
    await ready();
    expect((await h.ok("signAndSubmit", { requestId: "a", intent: limitOrder({ size: "12.5" }) })).status).toBe("ok"); // exactly $25,000
    expect((await h.ok("signAndSubmit", { requestId: "b", intent: btc("0.2", { side: "sell", reduceOnly: true }) })).status).toBe("ok");
    expect(h.promptEvents()).toHaveLength(0);
    expect(h.hl.exchangeCalls).toHaveLength(2);
  });

  it("asks before signing a larger one, saying what will be sent, and sends exactly that after the hold", async () => {
    await ready();
    const pending = h.ok("signAndSubmit", { requestId: "big", intent: btc("0.3") });
    await shown();
    expect(orderPrompts()).toHaveLength(1);
    // Side, size, market and total in the title and on the button, which always show whole.
    expect(h.root?.querySelector(".ks-title")?.textContent).toBe("Confirm: Buy 0.3 BTC, $30,000");
    expect(h.root?.querySelector(".ks-primary")?.textContent).toBe("Buy 0.3 BTC");
    const text = h.promptText();
    expect(text).toContain("The Kokoah app asks to send this order to Hyperliquid. Confirm only if you placed it.");
    expect(text).toContain("Buy 0.3 BTC at $100,000 (limit) · about $30,000");
    expect(h.root?.querySelector(".ks-prompt")?.classList.contains("ks-prompt--fixed")).toBe(true);
    expect(h.root?.querySelector(".ks-primary")?.classList.contains("ks-hold")).toBe(true);
    expect(h.hl.exchangeCalls).toHaveLength(0);
    await h.clickPrompt();
    expect((await pending).status).toBe("ok");
    const sent = h.hl.exchangeCalls.map((c) => c.body.action);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "order", orders: [{ a: 0, b: true, p: "100000", s: "0.3", r: false, t: { limit: { tif: "Gtc" } } }] });
  });

  it("adds up every order of the action, reduce-only ones included", async () => {
    await ready();
    // $10,000 in, with a take-profit and a stop-loss: $10,000 + $11,000 + $10,000 (counted at the mark) in all.
    const bracket = btc("0.1", { takeProfit: { triggerPrice: "110000" }, stopLoss: { triggerPrice: "95000" } });
    const pending = h.ok("signAndSubmit", { requestId: "br", intent: bracket });
    await shown();
    expect(h.root?.querySelector(".ks-title")?.textContent).toBe("Confirm: Buy 0.1 BTC + 2 more, $31,000");
    expect(h.root?.querySelector(".ks-primary")?.textContent).toBe("Buy 0.1 BTC + 2");
    const text = h.promptText();
    expect(text).toContain("Buy 0.1 BTC at $100,000 (limit) · about $10,000");
    expect(text).toContain("Sell 0.1 BTC take-profit at $110,000, then at market (down to $99,000) · reduce-only · about $11,000");
    // The stop is within the 5% band of the mark: its market limit stays within 5% of its trigger (the take-profit, 10%
    // away, keeps Hyperliquid's 10%).
    expect(text).toContain("Sell 0.1 BTC stop-loss at $95,000, then at market (down to $90,250) · reduce-only · about $10,000");
    await h.clickPrompt();
    expect((await pending).status).toBe("ok");

    // A market close of $30,000 asks too.
    const close = h.ok("signAndSubmit", { requestId: "cl", intent: { kind: "order", coin: "BTC", side: "sell", orderType: "market", size: "0.3", reduceOnly: true, slippageBps: 100, origin: "manual", cloid: cloid() } });
    await shown();
    expect(h.promptText()).toContain("Sell 0.3 BTC at market, down to $99,010 · reduce-only · about $30,000");
    await h.clickPrompt();
    expect((await close).status).toBe("ok");
  });

  it("sends nothing when the user cancels or doesn't answer, and the app can tell why", async () => {
    await ready({ promptTimeoutMs: 300 });
    const cancelled = h.fail("signAndSubmit", { requestId: "c1", intent: btc("0.3") });
    await shown();
    await h.clickPrompt("cancel");
    expect(await cancelled).toMatchObject({ code: "USER_CANCELLED", retryable: true, details: { prompt: "order" } });
    const timedOut = await h.fail("signAndSubmit", { requestId: "c2", intent: btc("0.3") });
    expect(timedOut).toMatchObject({ code: "USER_TIMEOUT", details: { prompt: "order" } });
    expect(h.hl.exchangeCalls).toHaveLength(0);
    // Nothing was sent: the requestId may be used again.
    const again = h.ok("signAndSubmit", { requestId: "c1", intent: btc("0.3") });
    await h.clickPrompt();
    expect((await again).status).toBe("ok");
  });

  it("never asks about an order the rules refuse", async () => {
    await ready();
    await h.ok("setLimits", { maxOrderNotionalUsd: 28_000 });
    expect(codes(await h.fail("signAndSubmit", { requestId: "x", intent: btc("0.3") }))).toEqual(["ORDER_NOTIONAL_EXCEEDED"]);
    expect(codes(await h.fail("signAndSubmit", { requestId: "y", intent: btc("0.27", { price: "106000" }) }))).toContain("PRICE_OUTSIDE_BAND");
    expect(h.promptEvents()).toHaveLength(0);
  });

  it("reads the market again after the prompt: a move past the band while it waited refuses the order", async () => {
    await ready();
    const pending = h.fail("signAndSubmit", { requestId: "m", intent: btc("0.3") });
    await shown();
    h.hl.mark.BTC = "90000";
    h.hl.mid.BTC = "90010";
    h.clock.advance(10_000);
    await h.clickPrompt();
    expect(codes(await pending)).toContain("PRICE_OUTSIDE_BAND");
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("doesn't hold up other signing while it waits, and asks about one large order at a time", async () => {
    await ready();
    const pending = h.ok("signAndSubmit", { requestId: "w", intent: btc("0.3") });
    await shown();
    expect((await h.ok("signAndSubmit", { requestId: "small", intent: limitOrder() })).status).toBe("ok");
    expect((await h.ok("signAndSubmit", { requestId: "cx", intent: { kind: "cancel", cancels: [{ coin: "ETH", oid: 1 }], origin: "manual" } })).status).toBe("ok");
    expect((await h.fail("signAndSubmit", { requestId: "w2", intent: btc("0.4") })).code).toBe("PROMPT_BUSY");
    await h.clickPrompt();
    expect((await pending).status).toBe("ok");
    expect(h.hl.exchangeCalls.map((c) => c.body.action.type)).toEqual(["order", "cancel", "order"]);
  });

  it("names the sub-account it trades for", async () => {
    const sub = "0x5ab0000000000000000000000000000000000001";
    await ready();
    h.hl.subAccounts[USER.toLowerCase()] = [subAccountEntry(sub)];
    const pending = h.ok("signAndSubmit", { requestId: "s", intent: btc("0.3", { vaultAddress: sub }) });
    await shown();
    expect(h.promptText()).toContain("send this order for sub-account 0x5ab0…0001 to Hyperliquid");
    await h.clickPrompt();
    expect((await pending).status).toBe("ok");
  });

  it("refuses them in a frame without a user interface", async () => {
    await ready({ withUi: false });
    const e = await h.fail("signAndSubmit", { requestId: "n", intent: btc("0.3") });
    expect(codes(e)).toEqual(["ORDER_NOTIONAL_EXCEEDED"]);
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });
});

describe("many orders without a prompt", () => {
  /** $24,000 each: under the per-action threshold, four of them stay under $100,000. */
  const just = (id: string) => h.ok("signAndSubmit", { requestId: id, intent: btc("0.24") });

  it("are announced in the handshake", async () => {
    h = await FrameHarness.create();
    const hello = await h.ok("hello", { protocolVersion: 1 });
    expect(hello.capabilities.confirmsRecentOrders).toBe(true);
    expect(hello.limits).toMatchObject({ confirmRecentOrdersAboveUsd: 100_000, recentOrdersWindowMs: 600_000, confirmDailyOrdersAboveUsd: 250_000 });
    expect(CONFIRM_UNPROMPTED_ABOVE_USD).toBe(100_000);
    expect(CONFIRM_UNPROMPTED_DAY_ABOVE_USD).toBe(250_000);
  });

  it("need the user's confirmation once they would pass $100,000 in 10 minutes; then the total starts again", async () => {
    await ready();
    for (const id of ["a", "b", "c", "d"]) expect((await just(id)).status).toBe("ok");
    expect(h.promptEvents()).toHaveLength(0);
    const fifth = just("e");
    await shown();
    expect(orderPrompts()).toHaveLength(1);
    const text = h.promptText();
    expect(h.root?.querySelector(".ks-title")?.textContent).toBe("Confirm: Buy 0.24 BTC, $24,000");
    expect(text).toContain("to Hyperliquid. Orders of about $96,000 went out without a confirmation in the last 10 minutes, so this one needs yours.");
    expect(h.hl.exchangeCalls).toHaveLength(4);
    await h.clickPrompt();
    expect((await fifth).status).toBe("ok");
    // Confirmed: the user is there, so the next ones go out again without a prompt, up to the total.
    for (const id of ["f", "g", "h", "i"]) expect((await just(id)).status).toBe("ok");
    expect(orderPrompts()).toHaveLength(1);
    expect(h.hl.exchangeCalls).toHaveLength(9);
  });

  it("count reduce-only orders and every account, and forget orders older than 10 minutes", async () => {
    const sub = "0x5ab0000000000000000000000000000000000001";
    await ready();
    h.hl.subAccounts[USER.toLowerCase()] = [subAccountEntry(sub)];
    await just("a");
    expect((await h.ok("signAndSubmit", { requestId: "b", intent: btc("0.24", { vaultAddress: sub }) })).status).toBe("ok");
    expect((await h.ok("signAndSubmit", { requestId: "c", intent: btc("0.24", { side: "sell", reduceOnly: true }) })).status).toBe("ok");
    h.clock.advance(5 * 60_000);
    await just("d");
    // $96,000 so far: the next one asks...
    const asks = h.fail("signAndSubmit", { requestId: "e", intent: btc("0.05") });
    await shown();
    await h.clickPrompt("cancel");
    expect((await asks).code).toBe("USER_CANCELLED");
    expect(h.hl.exchangeCalls).toHaveLength(4);
    // ...until the first three are more than 10 minutes old.
    h.clock.advance(5 * 60_000 + 1);
    expect((await h.ok("signAndSubmit", { requestId: "f", intent: btc("0.24") })).status).toBe("ok");
    expect(orderPrompts()).toHaveLength(1);
  });

  it("are counted across tabs and reloads of the frame", async () => {
    const locks = new FakeLocks();
    await ready({ locks });
    for (const id of ["a", "b", "c"]) await just(id);
    const other = await FrameHarness.create({ idb: h.idb, locks, clock: h.clock, hl: h.hl });
    try {
      await other.ok("hello", { protocolVersion: 1 });
      expect((await other.ok("signAndSubmit", { requestId: "d", intent: btc("0.24") })).status).toBe("ok");
      const asks = other.fail("signAndSubmit", { requestId: "e", intent: btc("0.24") });
      await waitFor(() => other.promptText().includes("$96,000"));
      await other.clickPrompt("cancel");
      expect((await asks).code).toBe("USER_CANCELLED");
    } finally {
      other.destroy();
    }
  });

  it("need the user's confirmation once they would pass $250,000 in 24 hours, however they are spread out", async () => {
    await ready();
    // Ten orders of $24,000, 11 minutes apart: never $100,000 in 10 minutes, but $240,000 in the day.
    for (let i = 0; i < 10; i++) {
      expect((await just(`a${i}`)).status).toBe("ok");
      h.clock.advance(11 * 60_000);
    }
    expect(h.promptEvents()).toHaveLength(0);
    const eleventh = just("b");
    await shown();
    expect(h.promptText()).toContain("Orders of about $240,000 went out without a confirmation in the last 24 hours, so this one needs yours.");
    await h.clickPrompt();
    expect((await eleventh).status).toBe("ok");
    // Confirmed with the total shown: it starts again.
    for (const id of ["c", "d", "e"]) expect((await just(id)).status).toBe("ok");
    expect(orderPrompts()).toHaveLength(1);
    expect(h.hl.exchangeCalls).toHaveLength(14);
  });

  it("keep counting past the confirmation of a large order whose prompt didn't show them", async () => {
    await ready();
    for (const id of ["a", "b"]) await just(id);
    // $48,000 so far; a $30,000 order asks on its own, without the total (it stays under $100,000)...
    const big = h.ok("signAndSubmit", { requestId: "big", intent: btc("0.3") });
    await shown();
    expect(h.promptText()).not.toContain("without a confirmation");
    await h.clickPrompt();
    expect((await big).status).toBe("ok");
    await waitFor(() => h.promptText() === "");
    // ...and confirming it neither counts it nor forgets the $48,000: the third small order after it asks.
    for (const id of ["c", "d"]) expect((await just(id)).status).toBe("ok");
    const asks = h.fail("signAndSubmit", { requestId: "e", intent: btc("0.24") });
    await shown();
    expect(h.promptText()).toContain("Orders of about $96,000 went out without a confirmation in the last 10 minutes");
    await h.clickPrompt("cancel");
    expect((await asks).code).toBe("USER_CANCELLED");
  });

  it("keep at most a minute's sum per entry, so a day of orders stays small", () => {
    let record: UsageRecord | undefined;
    const t0 = 1_800_000_000_000;
    // An order every 10 s for 25 hours, $10 each.
    for (let t = t0; t < t0 + 25 * 3_600_000; t += 10_000) {
      record = nextUsage("account/testnet/0xabc", record, t, 1, 10, undefined, undefined, { usd: 10, confirmed: false, clears: false });
    }
    const now = t0 + 25 * 3_600_000 - 10_000;
    expect(record!.unprompted!.length).toBeLessThanOrEqual(1_441);
    // The last 24 hours of them, give or take the minute they are summed in.
    const day = usageOf(record, now).unpromptedDayUsd;
    expect(day).toBeGreaterThanOrEqual((UNPROMPTED_DAY_MS / 10_000) * 10);
    expect(day).toBeLessThanOrEqual((UNPROMPTED_DAY_MS / 10_000 + 6) * 10);
    expect(usageOf(record, now).unpromptedUsd).toBeGreaterThanOrEqual(600);
    expect(usageOf(record, now).unpromptedUsd).toBeLessThanOrEqual(660);
  });

  it("clear only the window whose total the confirmed prompt showed", () => {
    const t0 = 1_800_000_000_000;
    const minute = 60_000;
    // $50,000 unconfirmed 20 minutes ago, $60,000 two minutes ago.
    let record = nextUsage("account/testnet/0xabc", undefined, t0 - 20 * minute, 1, 50_000, undefined, undefined, { usd: 50_000, confirmed: false, clears: false });
    record = nextUsage("account/testnet/0xabc", record, t0 - 2 * minute, 1, 60_000, undefined, undefined, { usd: 60_000, confirmed: false, clears: false });
    expect(usageOf(record, t0)).toMatchObject({ unpromptedUsd: 60_000, unpromptedDayUsd: 110_000 });
    // The prompt showed the 10 minutes' total: those orders leave the record, the older ones stay in the day's.
    const tenMinutes = nextUsage("account/testnet/0xabc", record, t0, 1, 30_000, undefined, undefined, { usd: 30_000, confirmed: true, clears: { windowMs: UNPROMPTED_WINDOW_MS, at: t0 } });
    expect(usageOf(tenMinutes, t0)).toMatchObject({ unpromptedUsd: 0, unpromptedDayUsd: 50_000 });
    // The day's total shown: all of it starts again; a prompt that showed none clears nothing.
    expect(usageOf(nextUsage("account/testnet/0xabc", record, t0, 1, 30_000, undefined, undefined, { usd: 30_000, confirmed: true, clears: { windowMs: UNPROMPTED_DAY_MS, at: t0 } }), t0)).toMatchObject({ unpromptedUsd: 0, unpromptedDayUsd: 0 });
    expect(usageOf(nextUsage("account/testnet/0xabc", record, t0, 1, 30_000, undefined, undefined, { usd: 30_000, confirmed: true, clears: false }), t0)).toMatchObject({ unpromptedUsd: 60_000, unpromptedDayUsd: 110_000 });
    // Orders another tab signed while the prompt was open (after it counted the total) weren't shown: they stay.
    const meanwhile = nextUsage("account/testnet/0xabc", record, t0 + minute, 1, 20_000, undefined, undefined, { usd: 20_000, confirmed: false, clears: false });
    const confirmedLater = nextUsage("account/testnet/0xabc", meanwhile, t0 + 2 * minute, 1, 30_000, undefined, undefined, { usd: 30_000, confirmed: true, clears: { windowMs: UNPROMPTED_WINDOW_MS, at: t0 } });
    expect(usageOf(confirmedLater, t0 + 2 * minute)).toMatchObject({ unpromptedUsd: 20_000, unpromptedDayUsd: 70_000 });
  });

  it("are refused in a frame without a user interface once they would pass the total", async () => {
    await ready({ withUi: false });
    for (const id of ["a", "b", "c", "d"]) await just(id);
    const e = await h.fail("signAndSubmit", { requestId: "e", intent: btc("0.24") });
    expect(codes(e)).toEqual(["ORDER_NOTIONAL_EXCEEDED"]);
    expect(e.details?.violations?.[0]?.message).toContain("$96,000 so far");
    expect(h.hl.exchangeCalls).toHaveLength(4);
  });

  it("say so when another tab's orders signed in between need this one confirmed (SIGNER_BUSY ordersSigned)", async () => {
    const locks = new FakeLocks();
    let waiting = false;
    let open!: () => void;
    let gate: Promise<void> | null = null;
    // This tab's signing lock waits until the other tab has signed.
    const gated: LockManagerLike = {
      request: async (name, options, callback) => {
        if (gate !== null && name.includes("/sign/")) {
          waiting = true;
          await gate;
        }
        return await locks.request(name, options, callback);
      },
    };
    await ready({ locks: gated });
    for (const id of ["a", "b", "c"]) await just(id); // $72,000
    const other = await FrameHarness.create({ idb: h.idb, clock: h.clock, hl: h.hl, locks });
    try {
      await other.ok("hello", { protocolVersion: 1 });
      gate = new Promise((r) => (open = r));
      const pending = h.fail("signAndSubmit", { requestId: "d", intent: btc("0.24") });
      await waitFor(() => waiting);
      expect((await other.ok("signAndSubmit", { requestId: "e", intent: btc("0.24") })).status).toBe("ok"); // $96,000
      open();
      expect(await pending).toMatchObject({ code: "SIGNER_BUSY", retryable: true, details: { reason: "ordersSigned" } });
      expect(h.hl.exchangeCalls).toHaveLength(4);
    } finally {
      other.destroy();
    }
  });

  it("say so when the signing lock isn't free in time (SIGNER_BUSY lock)", async () => {
    const locks = new FakeLocks();
    const busy: LockManagerLike = {
      request: async (name, options, callback) => {
        // What AbortSignal.timeout makes Web Locks reject with.
        if (name.includes("/sign/")) throw Object.assign(new Error("The lock wasn't granted in time."), { name: "TimeoutError" });
        return await locks.request(name, options, callback);
      },
    };
    await ready({ locks: busy });
    expect(await h.fail("signAndSubmit", { requestId: "a", intent: btc("0.01") })).toMatchObject({ code: "SIGNER_BUSY", retryable: true, details: { reason: "lock" } });
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("are checked again when the nonce is reserved, so another tab's orders in between can't slip past it", async () => {
    const coordinator = new SigningCoordinator({ store: new MemorySignerStore(), locks: undefined, lockPrefix: "t" });
    const key = { key: "account/testnet/0xabc", legacy: "0xagent" };
    const order = (usd: number, confirmed = false, clears: false | { windowMs: number; at: number } = confirmed ? { windowMs: UNPROMPTED_WINDOW_MS, at: 1_000_000 } : false) =>
      coordinator.reserve(key, { now: 1_000_000, orders: 1, notionalUsd: usd, unprompted: { usd, confirmed, clears, maxUsd: 100_000, maxDayUsd: 250_000 } });
    await order(60_000);
    await expect(order(50_000)).rejects.toBeInstanceOf(ConfirmationNeededError);
    expect((await coordinator.usage(key, 1_000_000)).unpromptedUsd).toBe(60_000);
    await order(50_000, true, false);
    expect((await coordinator.usage(key, 1_000_000)).unpromptedUsd).toBe(60_000);
    await order(50_000, true);
    expect((await coordinator.usage(key, 1_000_000)).unpromptedUsd).toBe(0);
  });
});

describe("taking margin out of an isolated position", () => {
  const out = (amountUsd: string, o: Record<string, unknown> = {}) => ({ kind: "updateIsolatedMargin", coin: "BTC", amountUsd, origin: "manual", ...o });

  it("asks first, saying how much and that it moves the position toward liquidation", async () => {
    await ready();
    const pending = h.ok("signAndSubmit", { requestId: "m", intent: out("-250.5") });
    await shown();
    expect(h.promptEvents().at(-1)).toEqual({ visible: true, kind: "margin" });
    expect(h.root?.querySelector(".ks-title")?.textContent).toBe("Take margin out of this position?");
    expect(h.promptText()).toContain("take $250.5 of margin out of the isolated BTC position. This moves the position closer to liquidation.");
    expect(h.root?.querySelector(".ks-prompt")?.classList.contains("ks-prompt--fixed")).toBe(true);
    expect(h.root?.querySelector(".ks-primary")?.classList.contains("ks-hold")).toBe(true);
    expect(h.hl.exchangeCalls).toHaveLength(0);
    await h.clickPrompt();
    expect((await pending).status).toBe("ok");
    expect(h.hl.exchangeCalls[0]!.body.action).toMatchObject({ type: "updateIsolatedMargin", asset: 0, ntli: -250_500_000 });
  });

  it("signs nothing when cancelled, adds margin without asking, and refuses without a user interface", async () => {
    await ready();
    const pending = h.fail("signAndSubmit", { requestId: "m", intent: out("-5") });
    await shown();
    await h.clickPrompt("cancel");
    expect(await pending).toMatchObject({ code: "USER_CANCELLED", details: { prompt: "margin" } });
    expect((await h.ok("signAndSubmit", { requestId: "add", intent: out("5") })).status).toBe("ok");
    expect(h.promptEvents().filter((e) => e.visible)).toHaveLength(1);
    h.destroy();
    await ready({ withUi: false });
    expect(codes(await h.fail("signAndSubmit", { requestId: "n", intent: out("-5") }))).toEqual(["ACTION_TYPE_NOT_ALLOWED"]);
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });
});

describe("raising the leverage of an isolated position", () => {
  const lev = (leverage: number, o: Record<string, unknown> = {}) => ({ kind: "updateLeverage", coin: "BTC", leverage, marginMode: "isolated", origin: "manual", ...o });
  const isolatedAt = (value: number) => (h.hl.positions[USER.toLowerCase()] = [{ coin: "BTC", szi: "0.1", entryPx: "100000.0", leverage: { type: "isolated", value } }]);

  it("asks first, since it takes margin out of the position, reading the position itself", async () => {
    await ready();
    isolatedAt(5);
    const pending = h.ok("signAndSubmit", { requestId: "l", intent: lev(10) });
    await shown();
    expect(h.promptEvents().at(-1)).toEqual({ visible: true, kind: "margin" });
    expect(h.root?.querySelector(".ks-title")?.textContent).toBe("Raise the leverage of this position to 10x?");
    expect(h.promptText()).toContain("raise the leverage of the isolated BTC position from 5x to 10x. This takes margin out of the position and moves it closer to liquidation.");
    expect(h.root?.querySelector(".ks-primary")?.classList.contains("ks-hold")).toBe(true);
    expect(h.hl.exchangeCalls).toHaveLength(0);
    await h.clickPrompt();
    expect((await pending).status).toBe("ok");
    expect(h.hl.exchangeCalls[0]!.body.action).toEqual({ type: "updateLeverage", asset: 0, isCross: false, leverage: 10 });
    expect(h.hl.infoCalls.filter((c) => c.type === "clearinghouseState").length).toBeGreaterThanOrEqual(2);
  });

  it("lowers it, or sets leverage without an isolated position, with no prompt; refuses an AI ticket's raise", async () => {
    await ready();
    isolatedAt(5);
    expect((await h.ok("signAndSubmit", { requestId: "down", intent: lev(3) })).status).toBe("ok");
    expect((await h.ok("signAndSubmit", { requestId: "eth", intent: lev(10, { coin: "ETH" }) })).status).toBe("ok");
    expect(h.promptEvents().filter((e) => e.visible)).toHaveLength(0);
    expect(codes(await h.fail("signAndSubmit", { requestId: "ai", intent: lev(10, { origin: "ai_ticket" }) }))).toEqual(["ACTION_TYPE_NOT_ALLOWED"]);
  });

  it("reads a sub-account's own positions, and signs nothing when a position's leverage is unreadable", async () => {
    await ready();
    const sub = "0x5ab0000000000000000000000000000000000001";
    h.hl.subAccounts[USER.toLowerCase()] = [subAccountEntry(sub)];
    h.hl.positions[sub] = [{ coin: "BTC", szi: "-0.2", entryPx: "100000.0", leverage: { type: "isolated", value: 4 } }];
    const pending = h.ok("signAndSubmit", { requestId: "s", intent: lev(6, { vaultAddress: sub }) });
    await shown();
    expect(h.promptText()).toContain("of sub-account 0x5ab0…0001 from 4x to 6x");
    expect(h.hl.infoCalls.some((c) => c.type === "clearinghouseState" && c.user === sub)).toBe(true);
    await h.clickPrompt();
    expect((await pending).status).toBe("ok");
    isolatedAt(5);
    h.hl.positions[USER.toLowerCase()] = [{ coin: "BTC", szi: "0.1", entryPx: "100000.0", leverage: { type: "weird" as "cross", value: 5 } }];
    expect((await h.fail("signAndSubmit", { requestId: "u", intent: lev(3) })).code).toBe("MARKET_DATA_UNAVAILABLE");
  });

  it("signs nothing when cancelled, when the position changed meanwhile, or without a user interface", async () => {
    await ready();
    isolatedAt(5);
    const cancelled = h.fail("signAndSubmit", { requestId: "c", intent: lev(10) });
    await shown();
    await h.clickPrompt("cancel");
    expect(await cancelled).toMatchObject({ code: "USER_CANCELLED", details: { prompt: "margin" } });
    const moved = h.fail("signAndSubmit", { requestId: "m", intent: lev(10) });
    await shown();
    isolatedAt(8);
    await h.clickPrompt();
    expect(await moved).toMatchObject({ code: "SIGNER_BUSY", details: { reason: "leverageChanged" } });
    h.hl.infoFailure = (body) => body.type === "clearinghouseState";
    expect((await h.fail("signAndSubmit", { requestId: "down", intent: lev(10) })).code).toBe("MARKET_DATA_UNAVAILABLE");
    h.hl.infoFailure = null;
    expect(h.hl.exchangeCalls).toHaveLength(0);
    h.destroy();
    await ready({ withUi: false });
    isolatedAt(5);
    expect(codes(await h.fail("signAndSubmit", { requestId: "n", intent: lev(10) }))).toEqual(["ACTION_TYPE_NOT_ALLOWED"]);
  });
});

describe("market triggers near the mark", () => {
  it("are compiled within the account's price band, and keep Hyperliquid's 10% away from it", async () => {
    await ready();
    const stop = (triggerPrice: string) => ({ kind: "order", coin: "BTC", side: "sell", orderType: "stopMarket", size: "0.01", triggerPrice, reduceOnly: true, origin: "manual" });
    expect((await h.ok("signAndSubmit", { requestId: "near", intent: stop("98000") })).status).toBe("ok");
    expect((await h.ok("signAndSubmit", { requestId: "far", intent: stop("80000") })).status).toBe("ok");
    const prices = h.hl.exchangeCalls.map((c) => (c.body.action as unknown as { orders: Array<{ p: string }> }).orders[0]!.p);
    // The baseline band is 5%: 98,000 − 5% and 80,000 − 10%.
    expect(prices).toEqual(["93100", "72000"]);
  });

  const sent = () => h.hl.exchangeCalls.map((c) => c.body.action as unknown as { orders?: Array<{ p: string }>; order?: { p: string } });
  const trigger = (side: "buy" | "sell", triggerPrice: string, o: Record<string, unknown> = {}) => ({
    kind: "order",
    coin: "BTC",
    side,
    orderType: "stopMarket",
    size: "0.01",
    triggerPrice,
    reduceOnly: true,
    origin: "manual",
    ...o,
  });

  it("bands a short's buy stop and a stop that is already past the mark, and a modify near it", async () => {
    await ready();
    expect((await h.ok("signAndSubmit", { requestId: "buy", intent: trigger("buy", "101000") })).status).toBe("ok");
    // A sell stop above the mark fires at once: banded too.
    expect((await h.ok("signAndSubmit", { requestId: "crossed", intent: trigger("sell", "100500") })).status).toBe("ok");
    const modify = { kind: "modify", target: { oid: 77 }, order: { coin: "BTC", side: "sell", orderType: "stopMarket", size: "0.01", triggerPrice: "98000", reduceOnly: true }, origin: "manual" };
    expect((await h.ok("signAndSubmit", { requestId: "modify", intent: modify })).status).toBe("ok");
    const [buy, crossed, moved] = sent();
    expect(buy!.orders![0]!.p).toBe("106050");
    expect(crossed!.orders![0]!.p).toBe("95475");
    expect(moved!.order!.p).toBe("93100");
  });

  it("bands an entry's attached exits 2–3% away, and entry triggers wherever they are", async () => {
    await ready();
    const entry = limitOrder({ coin: "BTC", size: "0.01", price: "100000", stopLoss: { triggerPrice: "97500" }, takeProfit: { triggerPrice: "103000" } });
    expect((await h.ok("signAndSubmit", { requestId: "e", intent: entry })).status).toBe("ok");
    // Parent, take-profit, stop-loss: 103,000 − 5% and 97,500 − 5%.
    expect(sent()[0]!.orders!.map((o) => o.p)).toEqual(["100000", "97850", "92625"]);
    // A stop entry 20% above the mark: an entry gets the band, however far.
    expect((await h.ok("signAndSubmit", { requestId: "s", intent: trigger("buy", "120000", { reduceOnly: false }) })).status).toBe("ok");
    expect(sent()[1]!.orders![0]!.p).toBe("126000");
  });

  it("bands HIP-3 triggers by their own dex's mark", async () => {
    await ready();
    expect((await h.ok("signAndSubmit", { requestId: "x", intent: trigger("sell", "5900", { coin: "xyz:SP500", size: "1" }) })).status).toBe("ok");
    expect(sent()[0]!.orders![0]!.p).toBe("5605");
  });

  it("signs nothing when the mark moved close to a confirmed order's stop while the user held, and signs it again then", async () => {
    await ready();
    // $30,000: a prompt. Its market stop is 5.5% under the mark: compiled with Hyperliquid's 10%.
    const big = limitOrder({ coin: "BTC", size: "0.3", price: "100000", stopLoss: { triggerPrice: "94500" } });
    const first = h.fail("signAndSubmit", { requestId: "b1", intent: big });
    await shown();
    // The mark falls 0.6% while the user reads and holds (past the frame's 3 s price cache): the stop is now within the
    // 5% band.
    h.hl.mark.BTC = "99400";
    h.clock.advance(5_000);
    await h.clickPrompt();
    expect(await first).toMatchObject({ code: "SIGNER_BUSY", retryable: true, details: { reason: "marketMoved" } });
    expect(h.hl.exchangeCalls).toHaveLength(0);
    // Again: compiled at the new mark, within the band, and signed once confirmed.
    const again = h.ok("signAndSubmit", { requestId: "b2", intent: big });
    await waitFor(() => h.promptText() !== "");
    await h.clickPrompt();
    expect((await again).status).toBe("ok");
    expect(sent()[0]!.orders!.map((o) => o.p)).toEqual(["100000", "89775"]);
  });
});

describe("describeOrders", () => {
  const registry = MarketRegistry.fromInfo({ meta: META0 });
  const marks = { BTC: 100_000, ETH: 2_000 };

  it("describes modifies, post-only and IOC limits, and counts at the highest of limit, trigger and mark", () => {
    const modify = { type: "modify", oid: 7, order: { a: 1, b: false, p: "1900", s: "20", r: false, t: { limit: { tif: "Alo" } } } };
    expect(describeOrders(modify, registry, marks)).toEqual({ lines: ["Change an open order to: Sell 20 ETH at $1,900 (post-only limit) · about $40,000"], heads: ["Sell 20 ETH"], totalUsd: 40_000, changes: true });
    const ioc = { type: "order", orders: [{ a: 1, b: true, p: "2050", s: "1", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" };
    expect(describeOrders(ioc, registry, marks).lines).toEqual(["Buy 1 ETH at $2,050 (limit, fill now or cancel) · about $2,050"]);
    const stopLimit = { type: "order", orders: [{ a: 1, b: false, p: "1700", s: "1", r: true, t: { trigger: { isMarket: false, triggerPx: "1750", tpsl: "sl" } } }], grouping: "na" };
    expect(describeOrders(stopLimit, registry, marks)).toEqual({ lines: ["Sell 1 ETH stop-loss at $1,750, then limit $1,700 · reduce-only · about $2,000"], heads: ["Sell 1 ETH"], totalUsd: 2_000, changes: false });
    expect(describeOrders({ type: "cancel", cancels: [{ a: 1, o: 7 }] }, registry, marks)).toEqual({ lines: [], heads: [], totalUsd: 0, changes: true });
  });
});

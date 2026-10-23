/**
 * Large orders: an action whose orders come to more than $25,000 in all (reduce-only ones included) is signed only after
 * the user presses and holds the button of the frame's own prompt, which says what will be sent. Smaller orders are
 * signed as before, with no prompt.
 */
import { MarketRegistry } from "@kokoah/shared/markets";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmationNeededError, nextUsage, SigningCoordinator, UNPROMPTED_DAY_MS, usageOf } from "../src/frame/nonces.js";
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
const orderPrompts = () => h.events("promptChanged").filter((e) => e.visible && e.kind === "order");
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
    expect(h.events("promptChanged")).toHaveLength(0);
    expect(h.hl.exchangeCalls).toHaveLength(2);
  });

  it("asks before signing a larger one, saying what will be sent, and sends exactly that after the hold", async () => {
    await ready();
    const pending = h.ok("signAndSubmit", { requestId: "big", intent: btc("0.3") });
    await shown();
    expect(orderPrompts()).toHaveLength(1);
    expect(h.root?.querySelector(".ks-title")?.textContent).toBe("Confirm this order");
    const text = h.promptText();
    expect(text).toContain("to Hyperliquid, about $30,000 in all");
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
    expect(h.root?.querySelector(".ks-title")?.textContent).toBe("Confirm these 3 orders");
    const text = h.promptText();
    expect(text).toContain("about $31,000 in all");
    expect(text).toContain("Buy 0.1 BTC at $100,000 (limit) · about $10,000");
    expect(text).toContain("Sell 0.1 BTC take-profit at $110,000, then at market (down to $99,000) · reduce-only · about $11,000");
    expect(text).toContain("Sell 0.1 BTC stop-loss at $95,000, then at market (down to $85,500) · reduce-only · about $10,000");
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
    expect(h.events("promptChanged")).toHaveLength(0);
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
    expect(h.events("promptChanged")).toHaveLength(0);
    const fifth = just("e");
    await shown();
    expect(orderPrompts()).toHaveLength(1);
    const text = h.promptText();
    expect(text).toContain("about $24,000 in all. Orders of about $96,000 went out without a confirmation in the last 10 minutes, so this one needs yours.");
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
    expect(h.events("promptChanged")).toHaveLength(0);
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

  it("are refused in a frame without a user interface once they would pass the total", async () => {
    await ready({ withUi: false });
    for (const id of ["a", "b", "c", "d"]) await just(id);
    const e = await h.fail("signAndSubmit", { requestId: "e", intent: btc("0.24") });
    expect(codes(e)).toEqual(["ORDER_NOTIONAL_EXCEEDED"]);
    expect(e.details?.violations?.[0]?.message).toContain("$96,000 so far");
    expect(h.hl.exchangeCalls).toHaveLength(4);
  });

  it("are checked again when the nonce is reserved, so another tab's orders in between can't slip past it", async () => {
    const coordinator = new SigningCoordinator({ store: new MemorySignerStore(), locks: undefined, lockPrefix: "t" });
    const key = { key: "account/testnet/0xabc", legacy: "0xagent" };
    const order = (usd: number, confirmed = false, clears = confirmed) =>
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
    expect(h.events("promptChanged").at(-1)).toEqual({ visible: true, kind: "margin" });
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
    expect(h.events("promptChanged").filter((e) => e.visible)).toHaveLength(1);
    h.destroy();
    await ready({ withUi: false });
    expect(codes(await h.fail("signAndSubmit", { requestId: "n", intent: out("-5") }))).toEqual(["ACTION_TYPE_NOT_ALLOWED"]);
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });
});

describe("describeOrders", () => {
  const registry = MarketRegistry.fromInfo({ meta: META0 });
  const marks = { BTC: 100_000, ETH: 2_000 };

  it("describes modifies, post-only and IOC limits, and counts at the highest of limit, trigger and mark", () => {
    const modify = { type: "modify", oid: 7, order: { a: 1, b: false, p: "1900", s: "20", r: false, t: { limit: { tif: "Alo" } } } };
    expect(describeOrders(modify, registry, marks)).toEqual({ lines: ["Change an open order to: Sell 20 ETH at $1,900 (post-only limit) · about $40,000"], totalUsd: 40_000 });
    const ioc = { type: "order", orders: [{ a: 1, b: true, p: "2050", s: "1", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" };
    expect(describeOrders(ioc, registry, marks).lines).toEqual(["Buy 1 ETH at $2,050 (limit, fill now or cancel) · about $2,050"]);
    const stopLimit = { type: "order", orders: [{ a: 1, b: false, p: "1700", s: "1", r: true, t: { trigger: { isMarket: false, triggerPx: "1750", tpsl: "sl" } } }], grouping: "na" };
    expect(describeOrders(stopLimit, registry, marks)).toEqual({ lines: ["Sell 1 ETH stop-loss at $1,750, then limit $1,700 · reduce-only · about $2,000"], totalUsd: 2_000 });
    expect(describeOrders({ type: "cancel", cancels: [{ a: 1, o: 7 }] }, registry, marks)).toEqual({ lines: [], totalUsd: 0 });
  });
});

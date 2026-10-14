/**
 * Large orders: an action whose orders come to more than $25,000 in all (reduce-only ones included) is signed only after
 * the user presses and holds the button of the frame's own prompt, which says what will be sent. Smaller orders are
 * signed as before, with no prompt.
 */
import { MarketRegistry } from "@kokoah/shared/markets";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIRM_ORDERS_ABOVE_USD, describeOrders } from "../src/frame/policy.js";
import { cloid, FrameHarness, limitOrder, META0, subAccountEntry, USER, waitFor, type HarnessOptions } from "./helpers.js";

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

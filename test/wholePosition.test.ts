/**
 * Hyperliquid's TP/SL for the whole position (shared `wholePosition`: size 0 in a `positionTpsl` action): it closes
 * whatever is open when it fires. The frame reads the account's position itself for the prompt and the confirmation
 * totals (it counts at the position's size now), says "the whole position" instead of a size, and signs size 0 only in
 * a modify of a whole-position TP/SL it finds on the account.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MarketRegistry } from "@kokoah/shared/markets";
import { describeOrders, positionSizes, wholePositionCoins } from "../src/frame/policy.js";
import { FrameHarness, META0, openOrder, USER, waitFor } from "./helpers.js";

let h: FrameHarness;
afterEach(() => h?.destroy());

const ACCOUNT = USER.toLowerCase() as `0x${string}`;
const wholeStop = (over: Record<string, unknown> = {}) => ({
  kind: "order",
  coin: "BTC",
  side: "sell",
  orderType: "stopMarket",
  size: "0.1",
  triggerPrice: "95000",
  reduceOnly: true,
  positionTpsl: true,
  wholePosition: true,
  origin: "manual",
  ...over,
});
const moveWhole = (oid: number) => ({
  kind: "modify",
  target: { oid },
  order: { coin: "BTC", side: "sell", orderType: "stopMarket", size: "0.1", triggerPrice: "96000", reduceOnly: true, wholePosition: true },
  origin: "manual",
});
const positionReads = () => h.hl.infoCalls.filter((c) => c.type === "clearinghouseState");
const codes = (e: { details?: { violations?: Array<{ code: string }> } }) => e.details?.violations?.map((v) => v.code) ?? [];
const shown = () => waitFor(() => h.promptText() !== "");

/** Long `size` BTC from $100,000, with a whole-position stop at $95,000 (oid 80, listed with size 0). */
async function ready(size = "0.1", limits: Record<string, unknown> = {}): Promise<void> {
  h = await FrameHarness.create();
  await h.activeAgent("device");
  if (Object.keys(limits).length > 0) await h.ok("setLimits", limits);
  h.hl.positions[ACCOUNT] = [{ coin: "BTC", szi: size, entryPx: "100000.0" }];
  h.hl.openOrders[ACCOUNT] = [openOrder({ oid: 80, sz: "0.0", origSz: "0.0", isPositionTpsl: true }), openOrder({ oid: 77 })];
}

describe("describeOrders, whole position", () => {
  const registry = MarketRegistry.fromInfo({ meta: META0 });
  const marks = { BTC: 100_000 };
  const action = { type: "order", orders: [{ a: 0, b: false, p: "85500", s: "0", r: true, t: { trigger: { isMarket: true, triggerPx: "95000", tpsl: "sl" } } }], grouping: "positionTpsl" };

  it("says the whole position and counts it at the position's size now", () => {
    expect(wholePositionCoins(action, registry)).toEqual(["BTC"]);
    expect(describeOrders(action, registry, marks, false, { BTC: 0.4 })).toEqual({
      lines: ["Sell the whole BTC position (0.4 BTC now, whatever it is when it triggers) stop-loss at $95,000, then at market (down to $85,500) · reduce-only · about $40,000"],
      heads: ["Sell the whole BTC position"],
      totalUsd: 40_000,
      changes: false,
    });
  });
  it("refuses to describe one without the position read", () => {
    expect(() => describeOrders(action, registry, marks)).toThrow(/not read/);
    expect(() => describeOrders(action, registry, marks, false, { ETH: 1 })).toThrow(/not read/);
  });
  it("leaves other orders as they were", () => {
    const fixed = { ...action, orders: [{ ...action.orders[0], s: "0.4" }] };
    expect(wholePositionCoins(fixed, registry)).toEqual([]);
    expect(describeOrders(fixed, registry, marks).heads).toEqual(["Sell 0.4 BTC"]);
  });
  it("reads no position as 0", () => {
    expect(positionSizes({ positions: [{ coin: "BTC", size: -0.3, entryPrice: 1 }], orders: [] }, ["BTC", "ETH"])).toEqual({ BTC: 0.3, ETH: 0 });
  });
});

describe("signing a whole-position TP/SL", () => {
  it("reads the position itself, signs size 0, and asks nothing for a small one", async () => {
    await ready("0.1");
    expect((await h.ok("signAndSubmit", { requestId: "a", intent: wholeStop() })).status).toBe("ok");
    expect(h.promptEvents()).toHaveLength(0);
    expect(positionReads().length).toBeGreaterThan(0);
    expect(h.hl.exchangeCalls[0]?.body.action).toMatchObject({ type: "order", grouping: "positionTpsl", orders: [{ a: 0, b: false, s: "0", r: true, t: { trigger: { tpsl: "sl", triggerPx: "95000" } } }] });
  });

  it("asks for a large position, whatever size the page claims", async () => {
    await ready("1");
    const pending = h.ok("signAndSubmit", { requestId: "big", intent: wholeStop({ size: "0.01" }) });
    await shown();
    expect(h.root?.querySelector(".ks-title")?.textContent).toBe("Confirm: Sell the whole BTC position, $100,000");
    expect(h.promptText()).toContain("Sell the whole BTC position (1 BTC now, whatever it is when it triggers) stop-loss at $95,000");
    expect(h.hl.exchangeCalls).toHaveLength(0);
    await h.clickPrompt();
    expect((await pending).status).toBe("ok");
    expect(h.hl.exchangeCalls[0]?.body.action).toMatchObject({ orders: [{ s: "0" }] });
  });

  it("signs nothing unasked when the position grew past the confirmation limit before signing", async () => {
    await ready("0.1");
    let reads = 0;
    h.hl.infoFailure = (body) => {
      // The second read is the one under the lock (the first counted the order for the prompt).
      if (body.type === "clearinghouseState" && ++reads === 2) h.hl.positions[ACCOUNT] = [{ coin: "BTC", szi: "1", entryPx: "100000.0" }];
      return false;
    };
    const e = await h.fail("signAndSubmit", { requestId: "grew", intent: wholeStop() });
    expect(e).toMatchObject({ code: "SIGNER_BUSY", retryable: true, details: { reason: "limitsChanged" } });
    expect(e.message).toMatch(/position grew/);
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("signs nothing when the position can't be read", async () => {
    await ready("0.1");
    h.hl.infoFailure = (body) => body.type === "clearinghouseState";
    expect((await h.fail("signAndSubmit", { requestId: "x", intent: wholeStop() })).code).toBe("MARKET_DATA_UNAVAILABLE");
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("moves a whole-position stop with size 0, and refuses size 0 for any other order", async () => {
    await ready("0.1");
    expect((await h.ok("signAndSubmit", { requestId: "mv", intent: moveWhole(80) })).status).toBe("ok");
    expect(h.hl.exchangeCalls[0]?.body.action).toMatchObject({ type: "modify", oid: 80, order: { s: "0", t: { trigger: { triggerPx: "96000" } } } });
    const e = await h.fail("signAndSubmit", { requestId: "fixed", intent: moveWhole(77) });
    expect(e.code).toBe("POLICY_DENIED");
    expect(codes(e)).toContain("INVALID_SUBJECT");
    expect(h.hl.exchangeCalls).toHaveLength(1);
  });

  it("keeps a position covered where the limits require stops: a whole-position stop covers what is added", async () => {
    // Long 0.2 BTC. Adding 0.05 with its own stop: a whole-position stop covers the 0.25 after it.
    await ready("0.2", { requireStopLossForNewEntries: true });
    h.hl.openOrders[ACCOUNT] = [openOrder({ oid: 80, sz: "0.0", origSz: "0.0", isPositionTpsl: true })];
    const add = (requestId: string) => ({
      requestId,
      intent: { kind: "order", coin: "BTC", side: "buy", orderType: "limit", size: "0.05", price: "100000", stopLoss: { triggerPrice: "95000" }, origin: "manual" },
    });
    expect((await h.ok("signAndSubmit", add("whole"))).status).toBe("ok");
    // A position stop with a size of its own (0.1) is fixed: with the new stop it covers 0.15 of the 0.25.
    h.hl.openOrders[ACCOUNT] = [openOrder({ oid: 81, sz: "0.1", origSz: "0.1", isPositionTpsl: true })];
    expect(codes(await h.fail("signAndSubmit", add("fixed")))).toContain("STOP_LOSS_REQUIRED");
  });
});

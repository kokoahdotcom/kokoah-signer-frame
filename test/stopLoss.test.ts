/**
 * Stop-losses the user's limits require (`requireStopLossForNewEntries`) stay in place: the frame reads the account's
 * positions and resting orders from Hyperliquid itself (`clearinghouseState`, `frontendOpenOrders`, and
 * `orderStatus` for an order it names that isn't among them) and refuses a cancel or modify that would take a
 * position's stop-loss away, and a dead man's switch; an entry's stop must be within 25% of it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MAX_ORDER_LOOKUPS, readAccountBook } from "../src/frame/accountBook.js";
import { BASELINE_LIMITS, createBaselinePolicy } from "../src/frame/policy.js";
import { BUILDER, FrameHarness, limitOrder, openOrder, T0, USER } from "./helpers.js";

let h: FrameHarness;
afterEach(() => h?.destroy());

const ACCOUNT = USER.toLowerCase() as `0x${string}`;
const cancel = (oid: number, coin = "BTC") => ({ kind: "cancel", cancels: [{ coin, oid }], origin: "manual" });
const moveStop = (triggerPrice: string) => ({
  kind: "modify",
  target: { oid: 77 },
  order: { coin: "BTC", side: "sell", orderType: "stopMarket", size: "0.1", triggerPrice, reduceOnly: true },
  origin: "manual",
});
const bookReads = () => h.hl.infoCalls.filter((c) => c.type === "clearinghouseState" || c.type === "frontendOpenOrders");
const codes = (e: { details?: { violations?: Array<{ code: string }> } }) => e.details?.violations?.map((v) => v.code) ?? [];

/** A user whose limits require stops, long 0.1 BTC from $100,000 with a stop at $95,000 (oid 77) and a take-profit (78). */
async function ready(limits: Record<string, unknown> = { requireStopLossForNewEntries: true }): Promise<void> {
  h = await FrameHarness.create();
  await h.activeAgent("device");
  await h.ok("setLimits", limits);
  h.hl.positions[ACCOUNT] = [{ coin: "BTC", szi: "0.1", entryPx: "100000.0" }];
  h.hl.openOrders[ACCOUNT] = [openOrder(), openOrder({ oid: 78, orderType: "Take Profit Market", triggerPx: "110000.0", limitPx: "99000.0" })];
}

describe("stop-losses the user's limits require", () => {
  it("refuses cancelling a position's only stop-loss, reading the account from Hyperliquid itself", async () => {
    await ready();
    const e = await h.fail("signAndSubmit", { requestId: "a", intent: cancel(77) });
    expect(e.code).toBe("POLICY_DENIED");
    expect(codes(e)).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(h.hl.exchangeCalls).toHaveLength(0);
    expect(bookReads().map((c) => [c.type, c.user, c.dex])).toEqual([
      ["clearinghouseState", ACCOUNT, undefined],
      ["frontendOpenOrders", ACCOUNT, undefined],
    ]);
  });

  it("signs cancels of other orders, a stop moved within range, and a cancel of an order that is gone", async () => {
    await ready();
    expect((await h.ok("signAndSubmit", { requestId: "tp", intent: cancel(78) })).status).toBe("ok");
    expect((await h.ok("signAndSubmit", { requestId: "mv", intent: moveStop("97000") })).status).toBe("ok");
    expect(codes(await h.fail("signAndSubmit", { requestId: "far", intent: moveStop("70000") }))).toEqual(["STOP_LOSS_REQUIRED"]);
    // Filled meanwhile: looked up on its own, it takes nothing away.
    expect((await h.ok("signAndSubmit", { requestId: "gone", intent: cancel(999) })).status).toBe("ok");
    expect(h.hl.infoCalls.filter((c) => c.type === "orderStatus").map((c) => [c.user, c.oid])).toEqual([[ACCOUNT, 999]]);
  });

  it("refuses setting a dead man's switch, which would cancel every stop-loss, and lets one be cleared", async () => {
    await ready();
    expect(codes(await h.fail("signAndSubmit", { requestId: "s", intent: { kind: "scheduleCancel", time: T0 + 60_000, origin: "manual" } }))).toEqual(["STOP_LOSS_REQUIRED"]);
    expect((await h.ok("signAndSubmit", { requestId: "c", intent: { kind: "scheduleCancel", origin: "manual" } })).status).toBe("ok");
  });

  it("needs an entry's stop within 25% of it, and reads the account for entries too", async () => {
    expect(BASELINE_LIMITS.maxStopLossDistancePct).toBe(25);
    expect(createBaselinePolicy({ address: BUILDER, feeTenthsBps: 25 }).maxStopLossDistancePct).toBe(25);
    await ready();
    expect(codes(await h.fail("signAndSubmit", { requestId: "far", intent: limitOrder({ stopLoss: { triggerPrice: "1400" } }) }))).toEqual(["STOP_LOSS_REQUIRED"]);
    const reads = bookReads().length;
    expect((await h.ok("signAndSubmit", { requestId: "near", intent: limitOrder({ stopLoss: { triggerPrice: "1900" } }) })).status).toBe("ok");
    expect(bookReads().length).toBeGreaterThan(reads);
  });

  it("reads nothing where the limits don't require stops, or for closing orders", async () => {
    await ready({});
    expect((await h.ok("signAndSubmit", { requestId: "a", intent: cancel(77) })).status).toBe("ok");
    expect(bookReads()).toHaveLength(0);
    h.destroy();
    await ready();
    const close = { kind: "order", coin: "BTC", side: "sell", orderType: "limit", size: "0.1", price: "99500", tif: "Ioc", reduceOnly: true, origin: "manual" };
    expect((await h.ok("signAndSubmit", { requestId: "close", intent: close })).status).toBe("ok");
    expect(bookReads()).toHaveLength(0);
  });

  it("signs nothing when Hyperliquid can't tell the positions and orders", async () => {
    await ready();
    h.hl.infoFailure = (b) => b.type === "frontendOpenOrders";
    const e = await h.fail("signAndSubmit", { requestId: "a", intent: cancel(78) });
    expect(e.code).toBe("MARKET_DATA_UNAVAILABLE");
    expect(e.retryable).toBe(true);
    h.hl.infoFailure = null;
    h.hl.openOrders[ACCOUNT] = [openOrder({ orderType: "Trailing Stop" })];
    expect((await h.fail("signAndSubmit", { requestId: "b", intent: cancel(78) })).code).toBe("MARKET_DATA_UNAVAILABLE");
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });
});

describe("readAccountBook", () => {
  const answering = (answers: Record<string, unknown>) => async (body: Record<string, unknown>) => {
    const a = answers[String(body.type)];
    return typeof a === "function" ? (a as (b: Record<string, unknown>) => unknown)(body) : a;
  };
  const state = { assetPositions: [{ type: "oneWay", position: { coin: "BTC", szi: "-0.5", entryPx: "100000.0" } }] };
  const intent = { kind: "cancel", cancels: [{ coin: "BTC", oid: 77 }], origin: "manual" } as const;

  it("reads positions, orders with their limit prices, and the orders the action names outside them", async () => {
    const book = await readAccountBook(
      answering({
        clearinghouseState: state,
        frontendOpenOrders: [openOrder({ side: "B", cloid: "0x6B6F0101000000000000000000000001", isPositionTpsl: true, sz: "0.0" }), openOrder({ oid: 5, orderType: "Stop Limit", limitPx: "94000.0" })],
        orderStatus: { status: "unknownOid" },
      }),
      ACCOUNT,
      { kind: "cancel", cancels: [{ coin: "BTC", oid: 77 }, { coin: "BTC", oid: 6 }], origin: "manual" },
    );
    expect(book.positions).toEqual([{ coin: "BTC", size: -0.5, entryPrice: 100_000 }]);
    expect(book.orders).toEqual([
      { coin: "BTC", oid: 77, cloid: "0x6b6f0101000000000000000000000001", isBuy: true, size: 0, isTrigger: true, triggerPrice: 95_000, tpsl: "sl", isMarket: true, limitPrice: 85_500, reduceOnly: true, positionTpsl: true },
      { coin: "BTC", oid: 5, isBuy: false, size: 0.1, isTrigger: true, triggerPrice: 95_000, tpsl: "sl", isMarket: false, limitPrice: 94_000, reduceOnly: true, positionTpsl: false },
    ]);
    expect(book.notStops).toEqual([6]);
  });

  it("keeps an open stop on another market out of notStops, and looks up at most 10 orders", async () => {
    const elsewhere = { status: "order", order: { order: openOrder({ coin: "xyz:SP500", oid: 6 }), status: "open", statusTimestamp: 0 } };
    expect((await readAccountBook(answering({ clearinghouseState: state, frontendOpenOrders: [], orderStatus: elsewhere }), ACCOUNT, { ...intent, cancels: [{ coin: "BTC", oid: 6 }] })).notStops).toBeUndefined();
    const sent: unknown[] = [];
    const many = { ...intent, cancels: Array.from({ length: 12 }, (_, i) => ({ coin: "BTC", oid: 100 + i })) };
    const book = await readAccountBook(answering({ clearinghouseState: state, frontendOpenOrders: [], orderStatus: (b: Record<string, unknown>) => (sent.push(b.oid), { status: "unknownOid" }) }), ACCOUNT, many);
    expect(sent).toHaveLength(MAX_ORDER_LOOKUPS);
    expect(book.notStops).toHaveLength(MAX_ORDER_LOOKUPS);
  });

  it("fails closed on anything it can't read or trust", async () => {
    for (const answers of [
      { clearinghouseState: state, frontendOpenOrders: [openOrder({ orderType: "Trailing Stop" })] },
      { clearinghouseState: state, frontendOpenOrders: [openOrder({ sz: "lots" })] },
      { clearinghouseState: state, frontendOpenOrders: [openOrder({ limitPx: undefined })] },
      { clearinghouseState: { assetPositions: [{ position: { coin: "BTC" } }] }, frontendOpenOrders: [] },
      { clearinghouseState: state, frontendOpenOrders: null },
      { clearinghouseState: state, frontendOpenOrders: [], orderStatus: { status: "order", order: { order: openOrder({ oid: 8 }), status: "filled" } } },
      { clearinghouseState: state, frontendOpenOrders: [], orderStatus: null },
    ]) {
      await expect(readAccountBook(answering(answers), ACCOUNT, { ...intent, cancels: [{ coin: "BTC", oid: 7 }] }), JSON.stringify(answers)).rejects.toThrow();
    }
  });
});

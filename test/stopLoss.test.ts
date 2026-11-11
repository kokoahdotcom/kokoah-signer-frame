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

describe("partly filled entries with an attached stop-loss", () => {
  it("refuses cancelling one while no stop on the book covers the position, which would cancel its stop too", async () => {
    await ready();
    // Long 0.07 BTC: a buy of 0.1 (oid 5) filled 0.07; its stop-loss (oid 92) waits for the rest.
    h.hl.positions[ACCOUNT] = [{ coin: "BTC", szi: "0.07", entryPx: "100000.0" }];
    const entry = openOrder({ oid: 5, side: "B", isTrigger: false, orderType: "Limit", triggerPx: "0.0", reduceOnly: false, limitPx: "100000.0", sz: "0.03", origSz: "0.1", children: [openOrder({ oid: 92 })] });
    h.hl.openOrders[ACCOUNT] = [entry];
    const e = await h.fail("signAndSubmit", { requestId: "c", intent: cancel(5) });
    expect(codes(e)).toEqual(["STOP_LOSS_REQUIRED"]);
    expect(h.hl.exchangeCalls).toHaveLength(0);
    h.hl.openOrders[ACCOUNT] = [entry, openOrder({ oid: 77, sz: "0.07", origSz: "0.07" })];
    expect((await h.ok("signAndSubmit", { requestId: "c2", intent: cancel(5) })).status).toBe("ok");
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
      { coin: "BTC", oid: 77, cloid: "0x6b6f0101000000000000000000000001", isBuy: true, size: 0, isTrigger: true, triggerPrice: 95_000, tpsl: "sl", isMarket: true, limitPrice: 85_500, reduceOnly: true, positionTpsl: true, filledSize: 0, attachedStops: [] },
      { coin: "BTC", oid: 5, isBuy: false, size: 0.1, isTrigger: true, triggerPrice: 95_000, tpsl: "sl", isMarket: false, limitPrice: 94_000, reduceOnly: true, positionTpsl: false, filledSize: 0, attachedStops: [] },
    ]);
    expect(book.notStops).toEqual([6]);
  });

  it("reads how much of an entry filled and the stop-losses attached to it, and looks those up too", async () => {
    const children = [openOrder({ oid: 91, orderType: "Take Profit Market" }), openOrder({ oid: 92 }), { oid: "odd" }];
    const entry = openOrder({ oid: 5, side: "B", isTrigger: false, orderType: "Limit", triggerPx: "0.0", reduceOnly: false, sz: "0.03", origSz: "0.1", children });
    const book = await readAccountBook(answering({ clearinghouseState: state, frontendOpenOrders: [entry] }), ACCOUNT, { kind: "cancel", cancels: [{ coin: "BTC", oid: 5 }], origin: "manual" });
    expect(book.orders[0]).toMatchObject({ oid: 5, size: 0.03, attachedStops: [92, -1] });
    expect(book.orders[0]!.filledSize).toBeCloseTo(0.07, 12);
    // Not on the markets read: looked up on its own, it isn't harmless.
    const status = { status: "order", order: { order: entry, status: "open", statusTimestamp: 0 } };
    expect((await readAccountBook(answering({ clearinghouseState: state, frontendOpenOrders: [], orderStatus: status }), ACCOUNT, { kind: "cancel", cancels: [{ coin: "BTC", oid: 5 }], origin: "manual" })).notStops).toBeUndefined();
    const unfilled = { status: "order", order: { order: { ...entry, sz: "0.1" }, status: "open", statusTimestamp: 0 } };
    expect((await readAccountBook(answering({ clearinghouseState: state, frontendOpenOrders: [], orderStatus: unfilled }), ACCOUNT, { kind: "cancel", cancels: [{ coin: "BTC", oid: 5 }], origin: "manual" })).notStops).toEqual([5]);
    const named = { kind: "cancel" as const, cancels: [{ coin: "BTC", oid: 5 }], origin: "manual" as const };
    await expect(readAccountBook(answering({ clearinghouseState: state, frontendOpenOrders: [{ ...entry, origSz: "x" }] }), ACCOUNT, named)).rejects.toThrow();
    await expect(readAccountBook(answering({ clearinghouseState: state, frontendOpenOrders: [{ ...entry, children: "x" }] }), ACCOUNT, named)).rejects.toThrow();
    // An entry that doesn't say how much filled, or what is attached to it, is unreadable; a stop may leave them out.
    const { origSz: _o, ...noOrigSz } = entry;
    const { children: _c, ...noChildren } = entry;
    await expect(readAccountBook(answering({ clearinghouseState: state, frontendOpenOrders: [noOrigSz] }), ACCOUNT, named)).rejects.toThrow();
    await expect(readAccountBook(answering({ clearinghouseState: state, frontendOpenOrders: [noChildren] }), ACCOUNT, named)).rejects.toThrow();
    const { origSz: _s, children: _k, ...bareStop } = openOrder();
    expect((await readAccountBook(answering({ clearinghouseState: state, frontendOpenOrders: [bareStop] }), ACCOUNT, { kind: "cancel" as const, cancels: [{ coin: "BTC", oid: 77 }], origin: "manual" as const })).orders[0]).toMatchObject({ filledSize: 0, attachedStops: [] });
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

  it("takes only a final status for closed: an unknown one is open", async () => {
    const said = (status: string) => ({ status: "order", order: { order: openOrder({ oid: 6 }), status, statusTimestamp: 0 } });
    const one = { ...intent, cancels: [{ coin: "BTC", oid: 6 }] };
    for (const [status, closed] of [["marginCanceled", true], ["tickRejected", true], ["filled", true], ["triggered", false], ["somethingNew", false]] as const) {
      const book = await readAccountBook(answering({ clearinghouseState: state, frontendOpenOrders: [], orderStatus: said(status) }), ACCOUNT, one);
      expect(book.notStops, status).toEqual(closed ? [6] : undefined);
    }
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

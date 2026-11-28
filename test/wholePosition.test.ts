/**
 * Hyperliquid's TP/SL for the whole position (shared `wholePosition`: size 0 in a `positionTpsl` action): it closes
 * whatever is open when it fires, whatever size that is by then. The frame counts it at the position's size like any
 * order (a prompt only above the confirmation limit or past the unprompted totals), signs it only while its own read of
 * the account shows the position it closes (open, on the other side), says "Close the whole BTC long" instead of a size, counts it at the position's size now, and signs size 0
 * in a modify only of a whole-position TP/SL it finds on the account.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MarketRegistry } from "@kokoah/shared/markets";
import { describeOrders, positionSizes, wholePositionCoins, wholePositionProblems } from "../src/frame/policy.js";
import { FrameHarness, limitOrder, META0, openOrder, USER, waitFor } from "./helpers.js";

let h: FrameHarness;
afterEach(() => h?.destroy());

const ACCOUNT = USER.toLowerCase() as `0x${string}`;
const CLOID = "0x6b6f0100000000000000000000000abc";
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
const moveWhole = (target: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  kind: "modify",
  target,
  order: { coin: "BTC", side: "sell", orderType: "stopMarket", size: "0.1", triggerPrice: "96000", reduceOnly: true, wholePosition: true, ...over },
  origin: "manual",
});
const positionReads = () => h.hl.infoCalls.filter((c) => c.type === "clearinghouseState");
const codes = (e: { details?: { violations?: Array<{ code: string }> } }) => e.details?.violations?.map((v) => v.code) ?? [];
const messages = (e: { details?: { violations?: Array<{ message: string }> } }) => (e.details?.violations ?? []).map((v) => v.message).join(" ");
const shown = () => waitFor(() => h.promptText() !== "");
const title = () => h.root?.querySelector(".ks-title")?.textContent;

/** Holding `size` BTC from $100,000 (negative: short), with a whole-position stop (oid 80, size 0) and a fixed one. */
async function ready(size = "0.1", options: { withUi?: boolean; limits?: Record<string, unknown> } = {}): Promise<void> {
  h = await FrameHarness.create(options.withUi === false ? { withUi: false } : {});
  await h.activeAgent("device");
  if (options.limits) await h.ok("setLimits", options.limits);
  h.hl.positions[ACCOUNT] = Number(size) === 0 ? [] : [{ coin: "BTC", szi: size, entryPx: "100000.0" }];
  h.hl.openOrders[ACCOUNT] = [
    openOrder({ oid: 80, cloid: CLOID, sz: "0.0", origSz: "0.0", isPositionTpsl: true, ...(Number(size) < 0 ? { side: "B", triggerPx: "105000.0", limitPx: "115500.0" } : {}) }),
    openOrder({ oid: 81, sz: "0.1", origSz: "0.1", isPositionTpsl: true }),
    openOrder({ oid: 77 }),
  ];
}

/** Signs `intent`, confirming the prompt it must show; returns the prompt's title and text. */
async function confirmed(requestId: string, intent: Record<string, unknown>) {
  const pending = h.ok("signAndSubmit", { requestId, intent });
  await shown();
  const seen = { title: title(), text: h.promptText() };
  await h.clickPrompt();
  expect((await pending).status).toBe("ok");
  return seen;
}

describe("whole-position TP/SL in plain words", () => {
  const registry = MarketRegistry.fromInfo({ meta: META0 });
  const marks = { BTC: 100_000 };
  const order = (isBuy: boolean, triggerPx: string, p: string) => ({
    type: "order",
    orders: [{ a: 0, b: isBuy, p, s: "0", r: true, t: { trigger: { isMarket: true, triggerPx, tpsl: "sl" } } }],
    grouping: "positionTpsl",
  });
  const long = order(false, "95000", "85500");
  const short = order(true, "105000", "115500");

  it("closes the whole long or short, at its size now, never reading as more of it", () => {
    expect(wholePositionCoins(long, registry)).toEqual(["BTC"]);
    expect(describeOrders(long, registry, marks, false, { BTC: 0.4 })).toEqual({
      lines: ["Close the whole BTC long (0.4 BTC now, whatever it is when it triggers): sell stop-loss at $95,000, then at market (down to $85,500) · reduce-only · about $40,000"],
      heads: ["Close the whole BTC long"],
      totalUsd: 40_000,
      changes: false,
    });
    expect(describeOrders(short, registry, marks, false, { BTC: -0.4 }).lines).toEqual([
      "Close the whole BTC short (0.4 BTC now, whatever it is when it triggers): buy stop-loss at $105,000, then at market (up to $115,500) · reduce-only · about $46,200",
    ]);
  });
  it("can't describe one without the position read", () => {
    expect(() => describeOrders(long, registry, marks)).toThrow(/not read/);
    expect(() => describeOrders(long, registry, marks, false, { ETH: 1 })).toThrow(/not read/);
  });
  it("is refused without an open position, or on the side that can't close it", () => {
    expect(wholePositionProblems(long, registry, { BTC: 0.4 })).toEqual([]);
    expect(wholePositionProblems(short, registry, { BTC: -0.4 })).toEqual([]);
    expect(wholePositionProblems(long, registry, { BTC: 0 })[0]).toMatch(/no open BTC position/);
    expect(wholePositionProblems(long, registry, { BTC: -0.4 })[0]).toMatch(/whole BTC short must buy: this one sells/);
    expect(wholePositionProblems(short, registry, { BTC: 0.4 })[0]).toMatch(/whole BTC long must sell: this one buys/);
    expect(wholePositionProblems(long, registry, {})[0]).toMatch(/couldn't be read/);
  });
  it("leaves other orders as they were", () => {
    const fixed = { ...long, orders: [{ ...long.orders[0], s: "0.4" }] };
    expect(wholePositionCoins(fixed, registry)).toEqual([]);
    expect(wholePositionProblems(fixed, registry, {})).toEqual([]);
    expect(describeOrders(fixed, registry, marks).heads).toEqual(["Sell 0.4 BTC"]);
    expect(positionSizes({ positions: [{ coin: "BTC", size: -0.3, entryPrice: 1 }], orders: [] }, ["BTC", "ETH"])).toEqual({ BTC: -0.3, ETH: 0 });
  });
});

describe("signing a whole-position TP/SL", () => {
  it("signs a small one at once, without a prompt, and sends size 0", async () => {
    await ready("0.01");
    expect((await h.ok("signAndSubmit", { requestId: "a", intent: wholeStop() })).status).toBe("ok");
    expect(h.promptEvents()).toHaveLength(0);
    expect(positionReads().length).toBeGreaterThan(0);
    expect(h.hl.exchangeCalls[0]?.body.action).toMatchObject({ type: "order", grouping: "positionTpsl", orders: [{ a: 0, b: false, s: "0", r: true, t: { trigger: { tpsl: "sl", triggerPx: "95000" } } }] });
  });

  it("asks for a short's buy stop, and counts the position's size, not the page's", async () => {
    await ready("-1");
    const seen = await confirmed("s", wholeStop({ side: "buy", triggerPrice: "105000", size: "0.01" }));
    // Counted at its limit (5% above the trigger, inside the band), the worst price it can fill at.
    expect(seen.title).toBe("Confirm: Close the whole BTC short, $110,250");
    expect(seen.text).toContain("Close the whole BTC short (1 BTC now, whatever it is when it triggers): buy stop-loss at $105,000");
  });

  it("shows the unconfirmed total too when it is due, so confirming it never resets an allowance unseen", async () => {
    // 0.05 BTC: $96,000 unconfirmed plus this $5,000 passes the $100,000 of 10 minutes.
    await ready("0.05");
    const buy = (id: string) => h.ok("signAndSubmit", { requestId: id, intent: limitOrder({ coin: "BTC", size: "0.24", price: "100000" }) });
    for (const id of ["a", "b", "c", "d"]) expect((await buy(id)).status).toBe("ok");
    // $96,000 went out unconfirmed: the stop's prompt says so as well as why a whole-position stop always asks.
    const seen = await confirmed("w", wholeStop());
    expect(seen.text).toContain("Orders of about $96,000 went out without a confirmation in the last 10 minutes, so this one needs yours.");
    expect(seen.text).toContain("A TP/SL for the whole position closes whatever is open when it triggers.");
  });

  it("counts toward the unconfirmed total like any order", async () => {
    await ready("0.01");
    const buy = (id: string) => h.ok("signAndSubmit", { requestId: id, intent: limitOrder({ coin: "BTC", size: "0.24", price: "100000" }) });
    expect((await buy("a")).status).toBe("ok");
    // $1,000 at the position's size now: no prompt, and counted.
    expect((await h.ok("signAndSubmit", { requestId: "w", intent: wholeStop() })).status).toBe("ok");
    for (const id of ["b", "c", "d"]) expect((await buy(id)).status).toBe("ok");
    expect(h.promptEvents()).toHaveLength(0);
    const asks = h.fail("signAndSubmit", { requestId: "e", intent: limitOrder({ coin: "BTC", size: "0.24", price: "100000" }) });
    await shown();
    expect(h.promptText()).toContain("Orders of about $97,000 went out without a confirmation in the last 10 minutes");
    await h.clickPrompt("cancel");
    expect((await asks).code).toBe("USER_CANCELLED");
  });

  it("signs a small one in a frame with no user interface, and refuses one over the confirmation limit there", async () => {
    await ready("0.01", { withUi: false });
    expect((await h.ok("signAndSubmit", { requestId: "small", intent: wholeStop() })).status).toBe("ok");
    h.hl.positions[ACCOUNT] = [{ coin: "BTC", szi: "0.3", entryPx: "100000.0" }];
    const e = await h.fail("signAndSubmit", { requestId: "large", intent: wholeStop() });
    expect(e.code).toBe("POLICY_DENIED");
    expect(messages(e)).toMatch(/Orders of more than \$25,000 \(\$30,000 here\) need your confirmation in the signer frame, which has no user interface/);
    expect(h.hl.exchangeCalls).toHaveLength(1);
  });

  it("is refused, without a prompt, with no open position or on the side that can't close it", async () => {
    await ready("0");
    const none = await h.fail("signAndSubmit", { requestId: "none", intent: wholeStop() });
    expect(none.code).toBe("POLICY_DENIED");
    expect(codes(none)).toEqual(["INVALID_SUBJECT"]);
    expect(messages(none)).toMatch(/no open BTC position/);
    // $30,000: a prompt would be due, so none showing proves the refusal comes first.
    h.hl.positions[ACCOUNT] = [{ coin: "BTC", szi: "-0.3", entryPx: "100000.0" }];
    expect(messages(await h.fail("signAndSubmit", { requestId: "side", intent: wholeStop() }))).toMatch(/whole BTC short must buy/);
    expect(h.promptEvents()).toHaveLength(0);
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("refuses one signed without a prompt whose position grew past the limit by the lock; the resend asks", async () => {
    await ready("0.01");
    let reads = 0;
    // The second read of the position (under the lock) finds it grown to $30,000.
    h.hl.infoFailure = (body) => {
      if (body.type === "clearinghouseState" && ++reads === 2) h.hl.positions[ACCOUNT] = [{ coin: "BTC", szi: "0.3", entryPx: "100000.0" }];
      return false;
    };
    const e = await h.fail("signAndSubmit", { requestId: "g", intent: wholeStop() });
    expect(e.code).toBe("SIGNER_BUSY");
    expect(e.retryable).toBe(true);
    expect(e.details).toMatchObject({ reason: "marketMoved" });
    expect(h.promptEvents()).toHaveLength(0);
    expect(h.hl.exchangeCalls).toHaveLength(0);
    h.hl.infoFailure = null;
    const seen = await confirmed("g", wholeStop());
    expect(seen.text).toContain("0.3 BTC now");
    expect(h.hl.exchangeCalls).toHaveLength(1);
  });

  it("moves a small whole-position stop without a prompt", async () => {
    await ready("0.01");
    expect((await h.ok("signAndSubmit", { requestId: "m", intent: moveWhole({ oid: 80 }) })).status).toBe("ok");
    expect(h.promptEvents()).toHaveLength(0);
    expect(h.hl.exchangeCalls[0]?.body.action).toMatchObject({ type: "modify", oid: 80, order: { s: "0" } });
  });

  it("is refused when the position closed while the prompt was open", async () => {
    // $30,000: above the $25,000 confirmation limit, so it asks.
    await ready("0.3");
    const pending = h.fail("signAndSubmit", { requestId: "c", intent: wholeStop() });
    await shown();
    h.hl.positions[ACCOUNT] = [];
    await h.clickPrompt();
    expect(messages(await pending)).toMatch(/no open BTC position/);
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("signs nothing when the position can't be read", async () => {
    await ready("0.1");
    h.hl.infoFailure = (body) => body.type === "clearinghouseState";
    const e = await h.fail("signAndSubmit", { requestId: "x", intent: wholeStop() });
    expect(e.code).toBe("MARKET_DATA_UNAVAILABLE");
    expect(e.message).toMatch(/check the position this TP\/SL closes/);
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("moves a whole-position stop with size 0, by oid or cloid, asking above the confirmation limit", async () => {
    await ready("0.3");
    const byOid = await confirmed("oid", moveWhole({ oid: 80 }));
    expect(byOid.title).toBe("Confirm change: Close the whole BTC long, $30,000");
    expect(byOid.text).toContain("Change an open order to: Close the whole BTC long (0.3 BTC now, whatever it is when it triggers): sell stop-loss at $96,000");
    await confirmed("cloid", moveWhole({ cloid: CLOID }));
    const sent = h.hl.exchangeCalls.map((c) => c.body.action);
    expect(sent[0]).toMatchObject({ type: "modify", oid: 80, order: { s: "0", t: { trigger: { triggerPx: "96000" } } } });
    expect(sent[1]).toMatchObject({ type: "modify", oid: CLOID, order: { s: "0" } });
  });

  it("refuses size 0 for a fixed position stop or a plain stop", async () => {
    await ready("0.3");
    for (const oid of [81, 77]) {
      const e = await h.fail("signAndSubmit", { requestId: `fixed${oid}`, intent: moveWhole({ oid }) });
      expect(e.code).toBe("POLICY_DENIED");
      expect(codes(e)).toContain("INVALID_SUBJECT");
    }
    // The policy refuses it before any prompt.
    expect(h.promptEvents()).toHaveLength(0);
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("keeps a position covered where the limits require stops: a whole-position stop covers what is added", async () => {
    // Long 0.2 BTC. Adding 0.05 with its own stop: a whole-position stop covers the 0.25 after it.
    await ready("0.2", { limits: { requireStopLossForNewEntries: true } });
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

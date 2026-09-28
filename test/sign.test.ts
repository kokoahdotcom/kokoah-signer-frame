import { compileAction } from "@kokoah/shared/actions";
import { MarketRegistry } from "@kokoah/shared/markets";
import { VERIFIED_PERP_DEXS } from "@kokoah/shared/policy";
import { buildExchangeRequest, recoverL1Signer } from "@kokoah/shared/signing";
import { afterEach, describe, expect, it } from "vitest";
import { testConfig, BUILDER, FrameHarness, limitOrder, META0, META_XYZ, PERP_DEXS, cloid, T0, USER, MockHl, Clock } from "./helpers.js";

let h: FrameHarness;
afterEach(() => h?.destroy());

const NETWORK = testConfig().network;

describe("signAndSubmit happy path", () => {
  it("signs with the agent key, submits the body buildExchangeRequest would build, with the builder", async () => {
    h = await FrameHarness.create();
    const { address } = await h.activeAgent("device");
    const intent = limitOrder({ price: "1990", size: "0.25" });
    const r = await h.ok("signAndSubmit", { requestId: "req-1", intent });

    expect(r.status).toBe("ok");
    expect(r.replayed).toBe(false);
    expect(r.actionType).toBe("order");
    expect(r.cloids).toEqual([intent.cloid]);
    expect(r.expiresAfter).toBe(T0 + 15_000);
    expect(r.outcome).toEqual({ ok: true, type: "order", statuses: [{ kind: "resting", oid: 1000, cloid: intent.cloid }] });

    expect(h.hl.exchangeCalls).toHaveLength(1);
    const sent = h.hl.exchangeCalls[0]!.body;
    // The signer is the agent.
    const signer = await recoverL1Signer({ action: sent.action, nonce: sent.nonce, network: NETWORK, expiresAfter: sent.expiresAfter, signature: sent.signature as never });
    expect(signer.toLowerCase()).toBe(address);
    // Exactly the body the shared library builds, for exactly the action the shared compiler produces.
    const registry = MarketRegistry.fromInfo({ meta: META0 });
    const expectedAction = compileAction(intent as never, { registry, builder: { address: BUILDER, feeTenthsBps: 25 } }).action;
    expect(sent.action).toEqual(expectedAction);
    expect(sent).toEqual(buildExchangeRequest({ network: NETWORK, action: expectedAction as never, nonce: sent.nonce, signature: sent.signature as never, expiresAfter: T0 + 15_000 }));
    expect(sent.action.builder).toEqual({ b: BUILDER, f: 25 });
    expect(sent.vaultAddress).toBeUndefined();
    expect(sent.nonce).toBe(r.nonce);
    expect(h.hl.exchangeCalls[0]!.url).toBe("https://api.hyperliquid-testnet.xyz/exchange");
  });

  it("market orders use the frame's own mid price and report the IOC price it signed", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    h.hl.mid.ETH = "2500";
    h.hl.mark.ETH = "2500";
    const r = await h.ok("signAndSubmit", { requestId: "m1", intent: { kind: "order", coin: "ETH", side: "buy", orderType: "market", size: "0.1", slippageBps: 50, origin: "manual" } });
    expect(r.marketOrder).toEqual({ midPrice: "2500", limitPrice: "2512.5", slippageBps: 50 });
    const order = (h.hl.exchangeCalls[0]!.body.action.orders as Array<{ p: string; t: unknown }>)[0]!;
    expect(order.p).toBe("2512.5");
    expect(order.t).toEqual({ limit: { tif: "Ioc" } });
    expect(r.cloids).toHaveLength(1);
  });

  it("signs HIP-3 orders using per-dex metadata and prices", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    const r = await h.ok("signAndSubmit", { requestId: "x1", intent: limitOrder({ coin: "xyz:GOLD", price: "3000", size: "0.01" }) });
    expect(r.status).toBe("ok");
    const order = (h.hl.exchangeCalls[0]!.body.action.orders as Array<{ a: number }>)[0]!;
    expect(order.a).toBe(110001);
    expect(h.hl.infoCalls).toContainEqual({ type: "metaAndAssetCtxs", dex: "xyz" });
    expect(h.hl.infoCalls).toContainEqual({ type: "perpDexs" });
    const registry = MarketRegistry.fromInfo({ dexMetas: { xyz: META_XYZ }, perpDexs: PERP_DEXS });
    expect(registry.require("xyz:GOLD").assetId).toBe(110001);
  });

  it("on mainnet signs HIP-3 orders only on a pinned dex whose deployer is unchanged", async () => {
    h = await FrameHarness.create({ config: testConfig({ VITE_HL_NETWORK: "mainnet", VITE_ALLOW_MAINNET_WRITES: "true" }) });
    await h.activeAgent("device");
    const gold = () => limitOrder({ coin: "xyz:GOLD", price: "3000", size: "0.01" });
    // The mock's "xyz" names another deployer than the pinned one: whoever sets the mark now is unknown.
    expect(await h.fail("signAndSubmit", { requestId: "x0", intent: gold() })).toMatchObject({ code: "UNSUPPORTED_MARKET", message: expect.stringContaining("new deployer") });
    const baseInfo = h.hl.info.bind(h.hl);
    const pinned = VERIFIED_PERP_DEXS.mainnet.find((d) => d.name === "xyz")!.deployer;
    h.hl.info = (body) => (body.type === "perpDexs" ? [null, { ...PERP_DEXS[1], deployer: pinned }] : baseInfo(body));
    await h.clock.advance(61_000); // past the dex list cache
    expect((await h.ok("signAndSubmit", { requestId: "x1", intent: gold() })).status).toBe("ok");
    // A dex Kokoah never verified is refused even when HL lists it.
    h.hl.info = (body) =>
      body.type === "perpDexs" ? [null, { ...PERP_DEXS[1], name: "evil", deployer: pinned }] : body.type === "metaAndAssetCtxs" && body.dex === "evil" ? baseInfo({ ...body, dex: "xyz" }) : baseInfo(body);
    await h.clock.advance(61_000);
    expect(await h.fail("signAndSubmit", { requestId: "x2", intent: limitOrder({ coin: "evil:GOLD", price: "3000", size: "0.01" }) })).toMatchObject({ code: "UNSUPPORTED_MARKET", message: expect.stringContaining("not verified") });
    expect(h.hl.exchangeCalls).toHaveLength(1);
  });

  it("attaches TP/SL legs and returns every cloid", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    const r = await h.ok("signAndSubmit", {
      requestId: "tpsl",
      intent: limitOrder({ price: "2000", takeProfit: { triggerPrice: "2200" }, stopLoss: { triggerPrice: "1900" } }),
    });
    expect(r.cloids).toHaveLength(3);
    expect(h.hl.exchangeCalls[0]!.body.action.grouping).toBe("normalTpsl");
  });

  it("cancels and leverage changes are signed too", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    const c = await h.ok("signAndSubmit", { requestId: "c1", intent: { kind: "cancel", cancels: [{ coin: "ETH", oid: 123 }], origin: "manual" } });
    expect(c.status).toBe("ok");
    expect(c.actionType).toBe("cancel");
    const l = await h.ok("signAndSubmit", { requestId: "l1", intent: { kind: "updateLeverage", coin: "ETH", leverage: 10, marginMode: "cross", origin: "manual" } });
    expect(l.actionType).toBe("updateLeverage");
    expect(h.hl.exchangeCalls[1]!.body.action).toEqual({ type: "updateLeverage", asset: 1, isCross: true, leverage: 10 });
  });

  it("applies the HL server clock offset to nonce and expiresAfter", async () => {
    const clock = new Clock();
    const hl = new MockHl(clock);
    hl.serverOffsetMs = 5_000;
    h = await FrameHarness.create({ clock, hl });
    await h.activeAgent("device");
    const r = await h.ok("signAndSubmit", { requestId: "clk", intent: limitOrder() });
    expect(r.nonce).toBe(T0 + 5_000);
    expect(r.expiresAfter).toBe(T0 + 5_000 + 15_000);
    expect((await h.ok("getStatus")).clockOffsetMs).toBe(5_000);
  });
});

describe("signAndSubmit results", () => {
  it("maps an HL error through the shared errors module (rejected)", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    h.hl.responder = () => new Response(JSON.stringify({ status: "err", response: "User or API Wallet 0x1234567890123456789012345678901234567890 does not exist." }), { status: 200 });
    const r = await h.ok("signAndSubmit", { requestId: "rej", intent: limitOrder() });
    expect(r.status).toBe("rejected");
    expect(r.error?.code).toBe("UNKNOWN_SIGNER");
    expect(r.outcome?.ok).toBe(false);
  });

  it("reports per-order errors inside an ok result", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    h.hl.responder = () => new Response(JSON.stringify({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Order must have minimum value of $10." }] } } }));
    const r = await h.ok("signAndSubmit", { requestId: "min", intent: limitOrder({ size: "0.001" }) });
    expect(r.status).toBe("ok");
    expect(r.outcome).toMatchObject({ ok: true, statuses: [{ kind: "error", error: { code: "MIN_TRADE_NOTIONAL" } }] });
  });

  it("returns unknown (with cloids) when the request may or may not have reached HL", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    h.hl.responder = () => "network-error";
    const intent = limitOrder();
    const r = await h.ok("signAndSubmit", { requestId: "unk", intent });
    expect(r.status).toBe("unknown");
    expect(r.error?.code).toBe("OUTCOME_UNKNOWN");
    expect(r.exchangeResponse).toBeNull();
    expect(r.cloids).toEqual([intent.cloid]);

    h.hl.responder = () => new Response("bad gateway", { status: 502 });
    const r2 = await h.ok("signAndSubmit", { requestId: "unk2", intent: limitOrder() });
    expect(r2.status).toBe("unknown");
  });

  it("a 429 from HL is a rejection mapped to RATE_LIMITED", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    h.hl.responder = () => new Response("Too many requests", { status: 429 });
    const r = await h.ok("signAndSubmit", { requestId: "429", intent: limitOrder() });
    expect(r.status).toBe("rejected");
    expect(r.error?.code).toBe("RATE_LIMITED");
  });

  it("redacts 64-hex values relayed from HL", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    const hash = `0x${"ab".repeat(32)}`;
    h.hl.responder = () => new Response(JSON.stringify({ status: "ok", response: { type: "default", data: { hash } } }));
    const r = await h.ok("signAndSubmit", { requestId: "hash", intent: { kind: "noop", origin: "manual" } });
    expect(JSON.stringify(r)).not.toContain("ab".repeat(32));
  });
});

describe("requestId idempotency", () => {
  it("replays the first result and never signs twice for one requestId", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    const intent = limitOrder();
    const [a, b] = await Promise.all([h.ok("signAndSubmit", { requestId: "same", intent }), h.ok("signAndSubmit", { requestId: "same", intent })]);
    const c = await h.ok("signAndSubmit", { requestId: "same", intent });
    expect(h.hl.exchangeCalls).toHaveLength(1);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(c.replayed).toBe(true);
    expect(c.nonce).toBe(a.nonce);
  });

  it("replays unknown outcomes too (no blind resubmission)", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    h.hl.responder = () => "network-error";
    const intent = limitOrder();
    await h.ok("signAndSubmit", { requestId: "u", intent });
    h.hl.responder = null;
    const again = await h.ok("signAndSubmit", { requestId: "u", intent });
    expect(again.status).toBe("unknown");
    expect(again.replayed).toBe(true);
    expect(h.hl.exchangeCalls).toHaveLength(1);
  });

  it("rejects a reused requestId with a different intent", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    await h.ok("signAndSubmit", { requestId: "dup", intent: limitOrder() });
    const e = await h.fail("signAndSubmit", { requestId: "dup", intent: limitOrder() });
    expect(e.code).toBe("REQUEST_ID_REUSED");
  });

  it("rejects request ids with a run of 64 hex digits before signing (the outgoing guard would block the result)", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    const hex64 = "ab".repeat(32);
    for (const requestId of [hex64, `0x${hex64}`, `order-${hex64}`, `${hex64.toUpperCase()}:1`, `${"f".repeat(64)}${"0".repeat(64)}`]) {
      const e = await h.fail("signAndSubmit", { requestId, intent: limitOrder() });
      expect(e.code, requestId).toBe("INVALID_REQUEST");
      expect(e.details?.issues?.[0]?.path).toBe("requestId");
    }
    // Same for the envelope id, which every response echoes: such a request is dropped, never signed.
    const before = h.parent.posted.length;
    await h.post({ protocol: "kokoah-signer", version: 1, kind: "request", id: hex64, method: "signAndSubmit", params: { requestId: "env-hex", intent: limitOrder() } });
    expect(h.parent.posted.length).toBe(before);
    expect(h.hl.exchangeCalls).toHaveLength(0);
    // Up to 63 hex digits in a row are fine, and so are UUIDs; the results pass the outgoing guard.
    for (const requestId of ["a".repeat(63), `${"a".repeat(63)}-${"b".repeat(63)}`, crypto.randomUUID()]) {
      const r = await h.request("signAndSubmit", { requestId, intent: limitOrder() });
      expect(r.ok ? r.result.status : r.error.code, requestId).toBe("ok");
    }
    const id63 = "c".repeat(63);
    await h.post({ protocol: "kokoah-signer", version: 1, kind: "request", id: id63, method: "signAndSubmit", params: { requestId: "env-63", intent: limitOrder() } });
    expect(h.parent.posted.find((p) => p.message.kind === "response" && p.message.id === id63)?.message).toMatchObject({ ok: true, result: { status: "ok" } });
    expect(h.hl.exchangeCalls).toHaveLength(4);
  });

  it("a request denied before signing does not consume its requestId", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    h.hl.mark.ETH = "1000";
    const intent = limitOrder({ price: "2000" });
    expect((await h.fail("signAndSubmit", { requestId: "retry", intent })).code).toBe("POLICY_DENIED");
    h.hl.mark.ETH = "2000";
    h.clock.advance(10_000); // past the market-data cache
    const r = await h.ok("signAndSubmit", { requestId: "retry", intent });
    expect(r.status).toBe("ok");
    expect(r.replayed).toBe(false);
  });
});

describe("the frame never trusts prices from the parent", () => {
  it("has no field for prices: extra fields are rejected", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    const e1 = await h.fail("signAndSubmit", { requestId: "p1", intent: limitOrder(), markPrices: { ETH: 2000 } });
    expect(e1.code).toBe("INVALID_REQUEST");
    const e2 = await h.fail("signAndSubmit", { requestId: "p2", intent: { ...limitOrder(), markPrice: "2000" } });
    expect(e2.code).toBe("INVALID_INTENT");
    const e3 = await h.fail("signAndSubmit", { requestId: "p3", intent: { ...limitOrder(), builder: { b: USER, f: 0 } } });
    expect(e3.code).toBe("INVALID_INTENT");
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("uses Hyperliquid's mark, not what the parent's ticket assumed", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    // The parent's ticket shows ETH at 2150; HL (mocked /info) says the mark is 1500: 43% away, outside the band.
    h.hl.mark.ETH = "1500";
    h.hl.mid.ETH = "1500";
    const e = await h.fail("signAndSubmit", { requestId: "band", intent: limitOrder({ price: "2150" }) });
    expect(e.code).toBe("POLICY_DENIED");
    expect(e.details?.violations?.map((v) => v.code)).toContain("PRICE_OUTSIDE_BAND");
    // A market order is priced from HL's mid, whatever the parent believes.
    const m = await h.ok("signAndSubmit", { requestId: "mkt", intent: { kind: "order", coin: "ETH", side: "sell", orderType: "market", size: "0.1", origin: "manual" } });
    expect(m.marketOrder?.midPrice).toBe("1500");
    expect(h.hl.infoCalls.some((c) => c.type === "metaAndAssetCtxs")).toBe(true);
  });
});

describe("signAndSubmit preconditions", () => {
  it("rejects unsupported markets and invalid intents", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    expect((await h.fail("signAndSubmit", { requestId: "s", intent: limitOrder({ coin: "@107", price: "40" }) })).code).toBe("UNSUPPORTED_MARKET");
    expect((await h.fail("signAndSubmit", { requestId: "u", intent: limitOrder({ coin: "NOPE" }) })).code).toBe("COMPILE_FAILED");
    expect((await h.fail("signAndSubmit", { requestId: "d", intent: limitOrder({ coin: "OLD", price: "1" }) })).code).toBe("COMPILE_FAILED");
    const p = await h.fail("signAndSubmit", { requestId: "prec", intent: limitOrder({ price: "2000.123" }) });
    expect(p.code).toBe("COMPILE_FAILED");
    expect(p.details?.compileCode).toBe("PRICE_PRECISION");
    const i = await h.fail("signAndSubmit", { requestId: "k", intent: { kind: "vaultTransfer", origin: "manual" } });
    expect(i.code).toBe("INVALID_INTENT");
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("fails retryably when Hyperliquid market data is unavailable", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    h.hl.infoFailure = (b) => b.type === "metaAndAssetCtxs";
    h.clock.advance(10_000);
    const e = await h.fail("signAndSubmit", { requestId: "md", intent: limitOrder() });
    expect(e.code).toBe("MARKET_DATA_UNAVAILABLE");
    expect(e.retryable).toBe(true);
  });

  it("refuses without a confirmed, unlocked key", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    expect((await h.fail("signAndSubmit", { requestId: "a", intent: limitOrder() })).code).toBe("NO_KEY");
    await h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    expect((await h.fail("signAndSubmit", { requestId: "b", intent: limitOrder() })).code).toBe("KEY_PENDING");
    const created = h.generatedKeys.length;
    expect(created).toBe(1);
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("uses origin rules from the baseline policy (guardian, bot and telegram intents are refused)", async () => {
    h = await FrameHarness.create();
    await h.activeAgent("device");
    for (const origin of ["guardian", "bot", "telegram"]) {
      const e = await h.fail("signAndSubmit", { requestId: `o-${origin}`, intent: limitOrder({ origin, cloid: cloid() }) });
      expect(e.code).toBe("POLICY_DENIED");
      expect(e.details?.violations?.map((v) => v.code)).toContain("ORIGIN_NOT_ALLOWED");
    }
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });
});

describe("live testnet metadata quirks (@kokoah/shared 0.1.1)", () => {
  it("trades a HIP-3 market on a dex that also lists unparseable names, with the correct positional asset id", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fx = JSON.parse(readFileSync(join(process.cwd(), "test/fixtures/testnet-tndex.json"), "utf8")) as {
      perpDexs: unknown[];
      tndexMeta: { universe: Array<{ name: string; szDecimals: number }> };
    };
    expect(fx.tndexMeta.universe.map((u) => u.name).slice(0, 3)).toEqual(["tndex:A B:C", "tndex:A B:C/../../../../../../../中", "tndex:ADLT"]);
    h = await FrameHarness.create();
    await h.activeAgent("device");
    const baseInfo = h.hl.info.bind(h.hl);
    h.hl.mark["tndex:ADLT"] = "10";
    h.hl.mid["tndex:ADLT"] = "10";
    h.hl.info = (body) => {
      if (body.type === "perpDexs") return fx.perpDexs;
      if (body.type === "metaAndAssetCtxs" && body.dex === "tndex") return [fx.tndexMeta, h.hl.ctxs(fx.tndexMeta)];
      return baseInfo(body);
    };
    const sz = fx.tndexMeta.universe[2]!.szDecimals;
    const r = await h.ok("signAndSubmit", { requestId: "tndex", intent: limitOrder({ coin: "tndex:ADLT", price: "10", size: sz >= 1 ? "1.5" : "2" }) });
    expect(r.status).toBe("ok");
    expect((h.hl.exchangeCalls[0]!.body.action.orders as Array<{ a: number }>)[0]!.a).toBe(100_000 + 43 * 10_000 + 2);
    // The unparseable names themselves can't be traded.
    expect((await h.fail("signAndSubmit", { requestId: "bad", intent: limitOrder({ coin: "tndex:A B:C", price: "10", size: "1" }) })).code).toBe("INVALID_INTENT");
  });
});

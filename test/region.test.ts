// The frame's own region check (src/frame/eligibility.ts): before signing anything that adds risk, it asks Kokoah's
// API itself and refuses with REGION_BLOCKED when the visitor's region is blocked; closing and cancelling never ask.
import { afterEach, describe, expect, it } from "vitest";
import { buildMetaCsp, connectOrigins } from "../src/frame/config.js";
import { ELIGIBILITY_TTL_MS } from "../src/frame/eligibility.js";
import { FrameHarness, limitOrder, testConfig } from "./helpers.js";

const URL_ = "https://api.kokoah.example/v1/eligibility";
let h: FrameHarness;
afterEach(() => h?.destroy());

async function ready() {
  h = await FrameHarness.create({ config: testConfig({ VITE_ELIGIBILITY_URL: URL_ }) });
  await h.activeAgent("device");
  return h;
}
let n = 0;
const sign = (intent: Record<string, unknown>) => ({ requestId: `r${++n}`, intent });

describe("the frame's region check", () => {
  it("is off without VITE_ELIGIBILITY_URL, and its origin joins connect-src when set", async () => {
    expect(testConfig().eligibilityUrl).toBeNull();
    const config = testConfig({ VITE_ELIGIBILITY_URL: URL_ });
    expect(config.eligibilityUrl).toBe(URL_);
    expect(connectOrigins(config)).toEqual(["https://api.hyperliquid-testnet.xyz", "https://api.kokoah.example"]);
    expect(buildMetaCsp(config)).toContain("connect-src https://api.hyperliquid-testnet.xyz https://api.kokoah.example;");
    expect(() => testConfig({ VITE_ELIGIBILITY_URL: "http://api.kokoah.example/v1/eligibility" })).toThrow(/VITE_ELIGIBILITY_URL must use https/);
    expect(() => testConfig({ VITE_ELIGIBILITY_URL: "http://localhost:8080/v1/eligibility" })).toThrow(/https/);
    expect(testConfig({ VITE_ELIGIBILITY_URL: "http://localhost:8080/v1/eligibility" }, false).eligibilityUrl).toBe("http://localhost:8080/v1/eligibility");
    expect(() => testConfig({ VITE_ELIGIBILITY_URL: `${URL_}?x=1` })).toThrow(/query/);
  });

  it("signs an order where the region is allowed, asking once while the answer is fresh", async () => {
    await ready();
    expect((await h.ok("signAndSubmit", sign(limitOrder()))).status).toBe("ok");
    expect((await h.ok("signAndSubmit", sign(limitOrder()))).status).toBe("ok");
    expect(h.hl.eligibilityCalls).toBe(1);
    h.clock.advance(ELIGIBILITY_TTL_MS + 1);
    await h.ok("signAndSubmit", sign(limitOrder()));
    expect(h.hl.eligibilityCalls).toBe(2);
  });

  it("refuses what adds risk in a blocked region and still signs closes and cancels", async () => {
    await ready();
    h.hl.eligibility = { allowed: false, blockedReason: "region" };
    const sent = h.hl.exchangeCalls.length;
    expect(await h.fail("signAndSubmit", sign(limitOrder()))).toMatchObject({ code: "REGION_BLOCKED", message: expect.stringMatching(/region/) });
    expect((await h.fail("signAndSubmit", sign({ kind: "updateLeverage", coin: "ETH", leverage: 2, marginMode: "cross", origin: "manual" }))).code).toBe("REGION_BLOCKED");
    expect(h.hl.exchangeCalls).toHaveLength(sent);
    expect((await h.ok("signAndSubmit", sign(limitOrder({ side: "sell", reduceOnly: true })))).status).toBe("ok");
    expect((await h.ok("signAndSubmit", sign({ kind: "cancel", cancels: [{ coin: "ETH", oid: 1 }], origin: "manual" }))).status).toBe("ok");
  });

  it("keeps a block when the check can't be reached, until an answer allows again", async () => {
    await ready();
    h.hl.eligibility = { allowed: false, blockedReason: "region" };
    expect((await h.fail("signAndSubmit", sign(limitOrder()))).code).toBe("REGION_BLOCKED");
    // The check's request is blocked or the API is down: the last answer on record still holds.
    h.hl.eligibility = "down";
    h.clock.advance(ELIGIBILITY_TTL_MS + 1);
    expect((await h.fail("signAndSubmit", sign(limitOrder()))).code).toBe("REGION_BLOCKED");
    h.hl.eligibility = { allowed: true, blockedReason: null };
    h.clock.advance(ELIGIBILITY_TTL_MS + 1);
    expect((await h.ok("signAndSubmit", sign(limitOrder()))).status).toBe("ok");
  });

  it("lets trading go on through an API outage when no block is on record", async () => {
    await ready();
    h.hl.eligibility = "down";
    expect((await h.ok("signAndSubmit", sign(limitOrder()))).status).toBe("ok");
  });
});

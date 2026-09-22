import { buildRevokeAgent } from "@kokoah/shared/signing";
import { afterEach, describe, expect, it } from "vitest";
import { IdbSignerStore } from "../src/frame/storage.js";
import { Clock, DAY, FakeBus, FrameHarness, limitOrder, MockHl, T0, testConfig, USER, waitFor } from "./helpers.js";
import { IDBFactory } from "fake-indexeddb";

const harnesses: FrameHarness[] = [];
async function frame(o: Parameters<typeof FrameHarness.create>[0] = {}): Promise<FrameHarness> {
  const h = await FrameHarness.create(o);
  harnesses.push(h);
  return h;
}
afterEach(() => {
  for (const h of harnesses.splice(0)) h.destroy();
});

describe("revoke", () => {
  it("wipes the local key immediately and returns buildRevokeAgent typed data for the main wallet", async () => {
    const h = await frame();
    const { address } = await h.activeAgent("device");
    const r = await h.ok("revoke", {});
    expect(r.wiped).toBe(true);
    expect(r.agentAddress).toBe(address);
    expect(r.agentName).toBe("kokoah-web");
    expect(r.revokeAgent).toEqual(buildRevokeAgent({ agentName: "kokoah-web", nonce: T0, network: testConfig().network }));
    expect(r.revokeAgent.action.agentAddress).toBe("0x0000000000000000000000000000000000000000");
    expect(r.status).toMatchObject({ hasKey: false, keyState: "none", agentAddress: null });
    expect(await (await IdbSignerStore.open(h.idb)).getKeyRecord()).toBeUndefined();
    expect((await h.fail("signAndSubmit", { requestId: "after", intent: limitOrder() })).code).toBe("NO_KEY");
    expect(h.events("statusChanged").at(-1)).toMatchObject({ hasKey: false });
    // Reload: still gone.
    const again = await frame({ idb: h.idb, clock: h.clock, hl: h.hl });
    await again.ok("hello", { protocolVersion: 1 });
    expect((await again.ok("getStatus")).hasKey).toBe(false);
  });

  it("revoking another name returns its typed data without touching this device's key", async () => {
    const h = await frame();
    const { address } = await h.activeAgent("device");
    const r = await h.ok("revoke", { agentName: "kokoah-pwa", signatureChainId: "0x66eee" });
    expect(r.wiped).toBe(false);
    expect(r.revokeAgent).toEqual(buildRevokeAgent({ agentName: "kokoah-pwa", nonce: T0, network: testConfig().network, signatureChainId: "0x66eee" }));
    expect((await h.ok("getStatus")).agentAddress).toBe(address);
  });

  it("works without a key (revoke from the security center)", async () => {
    const h = await frame();
    await h.ok("hello", { protocolVersion: 1 });
    const r = await h.ok("revoke", {});
    expect(r).toMatchObject({ wiped: false, agentAddress: null, agentName: "kokoah-web" });
  });

  it("a revoke in one tab wipes the key in the other tabs (BroadcastChannel notice, no key material)", async () => {
    const clock = new Clock();
    const hl = new MockHl(clock);
    const idb = new IDBFactory();
    const bus = new FakeBus();
    const a = await frame({ clock, hl, idb, bus });
    await a.activeAgent("device");
    const b = await frame({ clock, hl, idb, bus });
    await b.ok("hello", { protocolVersion: 1 });
    expect((await b.ok("getStatus")).hasKey).toBe(true);
    await a.ok("revoke", {});
    await waitFor(() => b.events("statusChanged").some((s) => !s.hasKey));
    expect((await b.fail("signAndSubmit", { requestId: "x", intent: limitOrder() })).code).toBe("NO_KEY");
  });

  it("a key created or confirmed in one tab appears in the other tabs", async () => {
    const clock = new Clock();
    const hl = new MockHl(clock);
    const idb = new IDBFactory();
    const bus = new FakeBus();
    const a = await frame({ clock, hl, idb, bus });
    const b = await frame({ clock, hl, idb, bus });
    await b.ok("hello", { protocolVersion: 1 });
    await a.ok("hello", { protocolVersion: 1 });
    const created = await a.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    await waitFor(() => b.events("statusChanged").some((s) => s.agentAddress === created.agentAddress && s.keyState === "pending"));
    hl.approve(USER, created.agentAddress, "kokoah-web", created.validUntil);
    await a.ok("confirmAgent", {});
    await waitFor(() => b.events("statusChanged").some((s) => s.keyState === "active"));
    expect((await b.ok("signAndSubmit", { requestId: "b1", intent: limitOrder() })).status).toBe("ok");
  });
});

describe("expiry", () => {
  it("refuses to sign with an expired key and emits keyExpired", async () => {
    const h = await frame();
    const { address, validUntil } = await h.activeAgent("device", 1);
    expect(validUntil).toBe(T0 + DAY);
    h.clock.advance(DAY);
    const e = await h.fail("signAndSubmit", { requestId: "late", intent: limitOrder() });
    expect(e.code).toBe("KEY_EXPIRED");
    expect(h.events("keyExpired")).toEqual([{ agentAddress: address, validUntil }]);
    expect((await h.ok("getStatus")).keyState).toBe("expired");
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("stops signing when the key would expire before the action's expiresAfter", async () => {
    const h = await frame();
    await h.activeAgent("device", 1);
    h.clock.advance(DAY - 10_000);
    expect((await h.fail("signAndSubmit", { requestId: "edge", intent: limitOrder() })).code).toBe("KEY_EXPIRED");
  });

  it("emits keyExpiringSoon (7 days) after hello and on the timer", async () => {
    const h = await frame();
    const { address, validUntil } = await h.activeAgent("device", 5);
    const soon = h.events("keyExpiringSoon");
    expect(soon).toHaveLength(1);
    expect(soon[0]).toEqual({ agentAddress: address, validUntil, msRemaining: 5 * DAY });
    // Only once per key.
    await h.ok("hello", { protocolVersion: 1 });
    expect(h.events("keyExpiringSoon")).toHaveLength(1);

    const later = await frame();
    await later.activeAgent("device", 30);
    expect(later.events("keyExpiringSoon")).toHaveLength(0);
    later.clock.advance(23 * DAY + 1);
    later.core.checkExpiry();
    expect(later.events("keyExpiringSoon")).toHaveLength(1);
  });

  it("an expired key can be replaced without replaceExisting", async () => {
    const h = await frame();
    await h.activeAgent("device", 1);
    h.clock.advance(2 * DAY);
    const r = await h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    expect(r.keyState).toBe("pending");
  });

  it("confirmAgent refuses an expired key", async () => {
    const h = await frame();
    await h.ok("hello", { protocolVersion: 1 });
    await h.createAgent({ userAddress: USER, validForDays: 1, storageMode: "device" });
    h.clock.advance(DAY);
    expect((await h.fail("confirmAgent", {})).code).toBe("KEY_EXPIRED");
  });
});

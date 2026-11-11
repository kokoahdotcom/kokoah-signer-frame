import { buildRevokeAgent } from "@kokoah/shared/signing";
import { afterEach, describe, expect, it } from "vitest";
import { IdbSignerStore } from "../src/frame/storage.js";
import { Clock, DAY, FakeBus, FrameHarness, limitOrder, MockHl, MockPasskeys, T0, testConfig, USER, waitFor } from "./helpers.js";
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

describe("removing a passkey-protected key", () => {
  const removePrompts = (h: FrameHarness) => h.promptEvents().filter((e) => e.visible && e.kind === "key-remove");

  it("asks in the frame before revoke deletes it, and keeps it when the user cancels", async () => {
    const h = await frame();
    const { address } = await h.activeAgent("passkey");
    const cancelled = h.fail("revoke", {});
    await waitFor(() => h.promptText() !== "");
    expect(removePrompts(h)).toHaveLength(1);
    expect(h.root?.querySelector(".ks-title")?.textContent).toBe("Remove the trading key from this device?");
    expect(h.promptText()).toContain("protected with your passkey");
    expect(h.root?.querySelector(".ks-prompt")?.classList.contains("ks-prompt--fixed")).toBe(true);
    expect(h.root?.querySelector(".ks-primary")?.classList.contains("ks-hold")).toBe(true);
    await h.clickPrompt("cancel");
    expect(await cancelled).toMatchObject({ code: "USER_CANCELLED", details: { prompt: "key-remove" } });
    expect(await h.ok("getStatus")).toMatchObject({ hasKey: true, agentAddress: address });
    expect(await (await IdbSignerStore.open(h.idb)).getKeyRecord()).toMatchObject({ agentAddress: address, storageMode: "passkey" });
    const removed = h.ok("revoke", {});
    await h.clickPrompt();
    expect(await removed).toMatchObject({ wiped: true, agentAddress: address, status: { hasKey: false } });
    expect(await (await IdbSignerStore.open(h.idb)).getKeyRecord()).toBeUndefined();
  });

  it("asks before a key without the passkey replaces it, but not for a renewal with the passkey", async () => {
    const h = await frame();
    const { address } = await h.activeAgent("passkey");
    const replace = (storageMode: "device" | "session" | "passkey") => h.request("createAgent", { userAddress: USER, validForDays: 30, storageMode, replaceExisting: true });
    const device = replace("device");
    await waitFor(() => h.promptText() !== "");
    expect(removePrompts(h)).toHaveLength(1);
    expect(h.promptText()).toContain("unlocks without your passkey");
    await h.clickPrompt("cancel");
    expect((await device).ok).toBe(false);
    expect(await h.ok("getStatus")).toMatchObject({ agentAddress: address, storageMode: "passkey" });
    for (const mode of ["session", "device"] as const) {
      const r = replace(mode);
      await waitFor(() => removePrompts(h).length > (mode === "session" ? 1 : 2));
      await h.clickPrompt(mode === "session" ? "cancel" : "primary");
      const out = await r;
      expect(out.ok).toBe(mode === "device");
    }
    expect(await h.ok("getStatus")).toMatchObject({ storageMode: "device", keyState: "pending" });
    // A device key is replaced (or revoked) without asking.
    expect((await h.ok("createAgent", { userAddress: USER, validForDays: 30, storageMode: "device", replaceExisting: true })).storageMode).toBe("device");
    expect((await h.ok("revoke", {})).wiped).toBe(true);
    expect(removePrompts(h)).toHaveLength(3);
  });

  it("asks before a renewal whose passkey step can't protect the key falls back to a key without it", async () => {
    const passkeys = new MockPasskeys();
    const h = await frame({ passkeys });
    const { address } = await h.activeAgent("passkey");
    // The passkey step says the passkey can't give the PRF secret any more (or the page blocked WebAuthn).
    passkeys.failNextGet = "unsupported";
    const renewal = h.request("createAgent", { userAddress: USER, validForDays: 30, storageMode: "passkey", replaceExisting: true });
    await h.clickPrompt();
    await waitFor(() => removePrompts(h).length === 1);
    expect(h.promptText()).toContain("unlocks without your passkey");
    await h.clickPrompt("cancel");
    expect((await renewal).ok).toBe(false);
    expect(await h.ok("getStatus")).toMatchObject({ agentAddress: address, storageMode: "passkey" });
    expect(await (await IdbSignerStore.open(h.idb)).getKeyRecord()).toMatchObject({ agentAddress: address, storageMode: "passkey" });
    // Confirmed: the device key takes its place, saying why.
    passkeys.failNextGet = "unsupported";
    const confirmed = h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "passkey", replaceExisting: true });
    await h.clickPrompt();
    await waitFor(() => removePrompts(h).length === 2);
    await h.clickPrompt();
    expect(await confirmed).toMatchObject({ storageMode: "device", requestedStorageMode: "passkey" });
  });

  it("renews a passkey key with the passkey without asking to remove it", async () => {
    const h = await frame();
    await h.activeAgent("passkey");
    const renewal = h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "passkey", replaceExisting: true });
    await h.clickPrompt();
    expect((await renewal).storageMode).toBe("passkey");
    expect(removePrompts(h)).toHaveLength(0);
  });
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

  it("reports wiped: false with wipeError when the stored copy can't be deleted, and a second revoke deletes it", async () => {
    const idb = new IDBFactory();
    const store = await IdbSignerStore.open(idb);
    let failDelete = false;
    const realDelete = store.deleteKeyRecord.bind(store);
    store.deleteKeyRecord = async () => {
      if (failDelete) throw new DOMException("quota", "QuotaExceededError");
      await realDelete();
    };
    const h = await frame({ idb, store });
    const { address } = await h.activeAgent("device");
    failDelete = true;
    const r = await h.ok("revoke", {});
    expect(r).toMatchObject({ wiped: false, agentAddress: address, agentName: "kokoah-web", status: { hasKey: false } });
    expect(r.wipeError).toMatch(/could not be deleted/);
    // The typed data is still returned: deregistering on HL makes the stored copy useless.
    expect(r.revokeAgent).toEqual(buildRevokeAgent({ agentName: "kokoah-web", nonce: T0, network: testConfig().network }));
    // Out of memory in this tab.
    expect((await h.fail("signAndSubmit", { requestId: "after", intent: limitOrder() })).code).toBe("NO_KEY");
    // Honest about what a reload would do: the stored copy is still there.
    const reloaded = await frame({ idb, clock: h.clock, hl: h.hl });
    await reloaded.ok("hello", { protocolVersion: 1 });
    expect(await reloaded.ok("getStatus")).toMatchObject({ hasKey: true, agentAddress: address });
    reloaded.destroy();

    // Revoking again (storage works now) deletes the stored copy although the key is no longer in memory.
    failDelete = false;
    const again = await h.ok("revoke", {});
    expect(again).toMatchObject({ wiped: true, agentAddress: address, agentName: "kokoah-web" });
    expect(again.wipeError).toBeUndefined();
    expect(await (await IdbSignerStore.open(idb)).getKeyRecord()).toBeUndefined();
    const later = await frame({ idb, clock: h.clock, hl: h.hl });
    await later.ok("hello", { protocolVersion: 1 });
    expect((await later.ok("getStatus")).hasKey).toBe(false);
  });

  it("revoking a session key needs no storage", async () => {
    const idb = new IDBFactory();
    const store = await IdbSignerStore.open(idb);
    store.deleteKeyRecord = async () => {
      throw new Error("must not be called");
    };
    const h = await frame({ idb, store });
    const { address } = await h.activeAgent("session");
    expect(await h.ok("revoke", {})).toMatchObject({ wiped: true, agentAddress: address, status: { hasKey: false } });
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

  it("a lock in one tab locks the same key in the other tabs; a passkey key there then needs the passkey again", async () => {
    const clock = new Clock();
    const hl = new MockHl(clock);
    const idb = new IDBFactory();
    const bus = new FakeBus();
    const passkeys = new MockPasskeys();
    const a = await frame({ clock, hl, idb, bus, passkeys });
    await a.activeAgent("passkey");
    const b = await frame({ clock, hl, idb, bus, passkeys });
    await b.ok("hello", { protocolVersion: 1 });
    const unlocking = b.ok("unlock");
    await b.clickPrompt();
    expect((await unlocking).locked).toBe(false);
    expect((await b.ok("signAndSubmit", { requestId: "before", intent: limitOrder() })).status).toBe("ok");
    expect((await a.ok("lock")).locked).toBe(true);
    await waitFor(() => b.events("statusChanged").some((s) => s.locked));
    expect((await b.fail("signAndSubmit", { requestId: "after", intent: limitOrder() })).code).toBe("LOCKED");
    const again = b.ok("unlock");
    await b.clickPrompt();
    expect((await again).locked).toBe(false);
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

  it("getStatus and hello expose the expiry state, so an app that missed the events still knows", async () => {
    const h = await frame();
    await h.ok("hello", { protocolVersion: 1 });
    expect(await h.ok("getStatus")).toMatchObject({ hasKey: false, expiresAt: null, expiringSoon: false, expired: false });

    const { validUntil } = await h.activeAgent("device", 5);
    expect(await h.ok("getStatus")).toMatchObject({ keyState: "active", validUntil, expiresAt: validUntil - 15_000, expiringSoon: true, expired: false });

    // A reload: the new frame emits keyExpiringSoon right after hello, before a late parent listens. The hello result
    // and every later status still say so.
    const again = await frame({ idb: h.idb, clock: h.clock, hl: h.hl });
    const hello = await again.ok("hello", { protocolVersion: 1 });
    expect(hello.status).toMatchObject({ hasKey: true, keyState: "active", expiresAt: validUntil - 15_000, expiringSoon: true, expired: false });
    expect(again.events("keyExpiringSoon")).toHaveLength(1);
    expect((await again.ok("getStatus")).expiringSoon).toBe(true);
    expect((await again.ok("hello", { protocolVersion: 1 })).status.expiringSoon).toBe(true);

    again.clock.advance(5 * DAY - 15_000);
    const expired = await again.ok("getStatus");
    expect(expired).toMatchObject({ keyState: "expired", expiringSoon: false, expired: true });
    const helloExpired = await (await frame({ idb: h.idb, clock: h.clock, hl: h.hl })).ok("hello", { protocolVersion: 1 });
    expect(helloExpired.status).toMatchObject({ keyState: "expired", expired: true, expiringSoon: false });

    const fresh = await frame();
    await fresh.activeAgent("device", 30);
    expect(await fresh.ok("getStatus")).toMatchObject({ expiringSoon: false, expired: false });
    fresh.clock.advance(23 * DAY + 1);
    expect((await fresh.ok("getStatus")).expiringSoon).toBe(true);
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

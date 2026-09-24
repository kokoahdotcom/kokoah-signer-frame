import { deviceLinkCode } from "@kokoah/shared/link";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { DAY, FrameHarness, T0, USER } from "./helpers.js";

let h: FrameHarness;
afterEach(() => h?.destroy());

const PAIRING = "0b7f1a52-3c3d-4c1e-9d0e-6a1b2c3d4e5f";
const SECRET = "AAECAwQFBgcICQoLDA0ODw";
const link = { pairingId: PAIRING, secret: SECRET };
const params = { userAddress: USER, agentName: "kokoah-ph12", validForDays: 30, storageMode: "device" as const, link };

describe("createLinkedAgent (Link phone)", () => {
  it("creates a fresh pending key and returns the matching code for exactly that key", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const r = await h.ok("createLinkedAgent", params);
    expect(r.agentAddress).toBe(privateKeyToAccount(h.generatedKeys[0]!).address.toLowerCase());
    expect(r).toMatchObject({ agentName: "kokoah-ph12", validUntil: T0 + 30 * DAY, keyState: "pending", storageMode: "device", requestedStorageMode: "device", pairingId: PAIRING });
    expect(r.matchCode).toMatch(/^\d{6}$/);
    expect(r.matchCode).toBe(deviceLinkCode({ secret: SECRET, pairingId: PAIRING, userAddress: USER, agentAddress: r.agentAddress, agentName: "kokoah-ph12", validUntil: r.validUntil }));
    // No typed data for a wallet on this device: the computer builds and signs its own approveAgent.
    expect(r).not.toHaveProperty("approveAgent");
    expect(await h.ok("getStatus")).toMatchObject({ hasKey: true, keyState: "pending", agentAddress: r.agentAddress, agentName: "kokoah-ph12", userAddress: USER, storageMode: "device" });
  });

  it("never echoes the link secret, and refuses to sign until the computer's approval is on Hyperliquid", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const r = await h.ok("createLinkedAgent", params);
    expect(JSON.stringify(h.parent.posted)).not.toContain(SECRET);
    const pending = await h.fail("signAndSubmit", { requestId: "r1", intent: { kind: "cancel", cancels: [{ coin: "BTC", oid: 1 }] } });
    expect(pending.code).toBe("KEY_PENDING");
    expect((await h.fail("confirmAgent", {})).code).toBe("AGENT_NOT_FOUND");
    h.hl.approve(USER, r.agentAddress, "kokoah-ph12", r.validUntil);
    expect((await h.ok("confirmAgent", {})).keyState).toBe("active");
  });

  it("gives a different code for a different secret, pairing or key", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const a = await h.ok("createLinkedAgent", params);
    const b = await h.ok("createLinkedAgent", { ...params, replaceExisting: true });
    expect(b.agentAddress).not.toBe(a.agentAddress);
    const sameKeyOtherSecret = deviceLinkCode({ secret: "AAECAwQFBgcICQoLDA0OEA", pairingId: PAIRING, userAddress: USER, agentAddress: b.agentAddress, agentName: "kokoah-ph12", validUntil: b.validUntil });
    expect(sameKeyOtherSecret).not.toBe(b.matchCode);
    // A relay that swaps in the first key's address shows a code the phone does not show.
    expect(deviceLinkCode({ secret: SECRET, pairingId: PAIRING, userAddress: USER, agentAddress: a.agentAddress, agentName: "kokoah-ph12", validUntil: b.validUntil })).not.toBe(b.matchCode);
  });

  it("follows createAgent's rules: replaceExisting, storage fallback, reload", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    await h.ok("createLinkedAgent", params);
    expect((await h.fail("createLinkedAgent", params)).code).toBe("KEY_EXISTS");
    const r = await h.ok("createLinkedAgent", { ...params, replaceExisting: true });
    const again = await FrameHarness.create({ idb: h.idb, clock: h.clock });
    try {
      await again.ok("hello", { protocolVersion: 1 });
      expect(await again.ok("getStatus")).toMatchObject({ agentAddress: r.agentAddress, keyState: "pending", locked: false });
    } finally {
      again.destroy();
    }
  });

  it("validates every param strictly", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const bad: Array<Record<string, unknown>> = [
      { ...params, agentName: undefined },
      { ...params, agentName: "kokoah valid_until 5" },
      { ...params, link: { pairingId: "not-a-uuid", secret: SECRET } },
      { ...params, link: { pairingId: PAIRING.toUpperCase(), secret: SECRET } },
      { ...params, link: { pairingId: PAIRING, secret: "too-short" } },
      { ...params, link: { pairingId: PAIRING, secret: SECRET, extra: 1 } },
      { ...params, link: undefined },
      { ...params, validForDays: 31 },
      { ...params, signatureChainId: "0x66eee" },
      { ...params, userAddress: "0x1234" },
    ];
    for (const p of bad) expect((await h.fail("createLinkedAgent", p)).code).toBe("INVALID_REQUEST");
    expect(h.generatedKeys).toHaveLength(0);
  });

  it("needs hello first", async () => {
    h = await FrameHarness.create();
    expect((await h.fail("createLinkedAgent", params)).code).toBe("NOT_CONNECTED");
  });
});

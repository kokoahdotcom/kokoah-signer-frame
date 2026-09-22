import { buildApproveAgent, recoverUserSignedSigner, signatureFromHex } from "@kokoah/shared/signing";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { DAY, FrameHarness, T0, testConfig, USER } from "./helpers.js";

let h: FrameHarness;
afterEach(() => h?.destroy());

const NETWORK = testConfig().network;

describe("createAgent", () => {
  it("creates a named agent with valid_until and returns exactly buildApproveAgent's typed data", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const r = await h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    expect(r.agentName).toBe("kokoah-web");
    expect(r.validUntil).toBe(T0 + 30 * DAY);
    expect(r.keyState).toBe("pending");
    expect(r.storageMode).toBe("device");
    expect(r.agentAddress).toBe(privateKeyToAccount(h.generatedKeys[0]!).address.toLowerCase());
    const expected = buildApproveAgent({ agentAddress: r.agentAddress, agentName: "kokoah-web", validUntil: T0 + 30 * DAY, nonce: T0, now: T0, network: NETWORK });
    expect(r.approveAgent).toEqual(expected);
    // Named (never the unnamed slot) with the expiry suffix.
    expect(r.approveAgent.action.agentName).toBe(`kokoah-web valid_until ${T0 + 30 * DAY}`);
    expect(r.approveAgent.action.hyperliquidChain).toBe("Testnet");
    expect(r.approveAgent.typedData.primaryType).toBe("HyperliquidTransaction:ApproveAgent");
    expect(r.approveAgent.typedData.message.agentAddress).toBe(r.agentAddress);
    // A main wallet signs the typed data as-is (viem/wagmi signTypedData) and the signature recovers to that wallet.
    const main = privateKeyToAccount(generatePrivateKey());
    const sig = signatureFromHex(await main.signTypedData(r.approveAgent.typedData as never));
    expect((await recoverUserSignedSigner({ typedData: r.approveAgent.typedData, signature: sig })).toLowerCase()).toBe(main.address.toLowerCase());
  });

  it("honours agentName and signatureChainId", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const r = await h.createAgent({ userAddress: USER, validForDays: 7, storageMode: "session", agentName: "kokoah-pwa", signatureChainId: "0xA4B1" });
    expect(r.approveAgent).toEqual(buildApproveAgent({ agentAddress: r.agentAddress, agentName: "kokoah-pwa", validUntil: T0 + 7 * DAY, nonce: T0, now: T0, network: NETWORK, signatureChainId: "0xa4b1" }));
    expect(r.approveAgent.typedData.domain.chainId).toBe(0xa4b1);
  });

  it("generates a fresh address every time and never reuses one", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const a = await h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    const b = await h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device", replaceExisting: true });
    const c = await h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "session", replaceExisting: true });
    expect(new Set([a.agentAddress, b.agentAddress, c.agentAddress]).size).toBe(3);
  });

  it("retries when the generator repeats an address this origin already used", async () => {
    const fixed = generatePrivateKey();
    const fresh = generatePrivateKey();
    const seq = [fixed, fixed, fresh];
    h = await FrameHarness.create({ generatePrivateKey: () => seq.shift() ?? generatePrivateKey() });
    await h.ok("hello", { protocolVersion: 1 });
    const a = await h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    const b = await h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device", replaceExisting: true });
    expect(a.agentAddress).toBe(privateKeyToAccount(fixed).address.toLowerCase());
    expect(b.agentAddress).toBe(privateKeyToAccount(fresh).address.toLowerCase());
  });

  it("fails rather than reuse an address when the generator is broken", async () => {
    const fixed = generatePrivateKey();
    h = await FrameHarness.create({ generatePrivateKey: () => fixed });
    await h.ok("hello", { protocolVersion: 1 });
    await h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    const e = await h.fail("createAgent", { userAddress: USER, validForDays: 30, storageMode: "device", replaceExisting: true });
    expect(e.code).toBe("INTERNAL_ERROR");
  });

  it("refuses to replace an existing key without replaceExisting", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    await h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    const e = await h.fail("createAgent", { userAddress: USER, validForDays: 30, storageMode: "device" });
    expect(e.code).toBe("KEY_EXISTS");
  });

  it("emits statusChanged with the pending key", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const r = await h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    const last = h.events("statusChanged").at(-1);
    expect(last).toMatchObject({ hasKey: true, keyState: "pending", agentAddress: r.agentAddress, agentName: "kokoah-web", userAddress: USER, storageMode: "device", locked: false });
  });
});

describe("confirmAgent", () => {
  it("queries extraAgents itself and marks the key active once found", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const r = await h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    const missing = await h.fail("confirmAgent", {});
    expect(missing.code).toBe("AGENT_NOT_FOUND");
    expect(missing.retryable).toBe(true);
    h.hl.approve(USER, r.agentAddress, "kokoah-web", r.validUntil);
    const s = await h.ok("confirmAgent", {});
    expect(s.keyState).toBe("active");
    expect(h.hl.infoCalls.filter((c) => c.type === "extraAgents")).toEqual([
      { type: "extraAgents", user: USER },
      { type: "extraAgents", user: USER },
    ]);
    // Idempotent.
    expect((await h.ok("confirmAgent", {})).keyState).toBe("active");
  });

  it("polls until the approval appears (timeoutMs)", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const r = await h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    setTimeout(() => h.hl.approve(USER, r.agentAddress, "kokoah-web", r.validUntil), 100);
    const s = await h.ok("confirmAgent", { timeoutMs: 5_000 });
    expect(s.keyState).toBe("active");
  });

  it("never extends the expiry beyond what the frame requested", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const r = await h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    h.hl.approve(USER, r.agentAddress, "kokoah-web", r.validUntil + 150 * DAY);
    expect((await h.ok("confirmAgent", {})).validUntil).toBe(r.validUntil);
  });

  it("uses an earlier HL expiry when HL reports one", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const r = await h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    h.hl.approve(USER, r.agentAddress, "kokoah-web", T0 + 10 * DAY);
    expect((await h.ok("confirmAgent", {})).validUntil).toBe(T0 + 10 * DAY);
  });

  it("reports a name mismatch and HL outages", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const r = await h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    h.hl.infoFailure = (b) => b.type === "extraAgents";
    expect((await h.fail("confirmAgent", {})).code).toBe("HL_UNAVAILABLE");
    h.hl.infoFailure = null;
    h.hl.approve(USER, r.agentAddress, "someone-else", r.validUntil);
    expect((await h.fail("confirmAgent", {})).code).toBe("AGENT_MISMATCH");
  });

  it("the confirmed state survives a reload (device mode)", async () => {
    h = await FrameHarness.create();
    const { address } = await h.activeAgent("device");
    const again = await FrameHarness.create({ idb: h.idb, clock: h.clock });
    try {
      await again.ok("hello", { protocolVersion: 1 });
      expect(await again.ok("getStatus")).toMatchObject({ agentAddress: address, keyState: "active", locked: false });
    } finally {
      again.destroy();
    }
  });
});

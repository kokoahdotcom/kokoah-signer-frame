import { afterEach, describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, PROTOCOL_NAME, PROTOCOL_VERSION } from "../src/protocol/index.js";
import { classifyMessage } from "../src/frame/messages.js";
import { APP_ORIGIN, FrameHarness, STAGING_ORIGIN, testConfig } from "./helpers.js";

let h: FrameHarness;
afterEach(() => h?.destroy());

const req = (method: string, params: unknown, id = "m1") => ({ protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, kind: "request", id, method, params });

describe("origin allowlist", () => {
  it("ignores messages from origins outside the allowlist, silently, and counts them", async () => {
    h = await FrameHarness.create();
    await h.post(req("hello", { protocolVersion: 1 }), { origin: "https://evil.example" });
    await h.post(req("hello", { protocolVersion: 1 }), { origin: "https://app.kokoah.example.evil.example" });
    await h.post(req("hello", { protocolVersion: 1 }), { origin: "null" });
    await h.post(req("hello", { protocolVersion: 1 }), { origin: "http://app.kokoah.example" });
    expect(h.parent.postMessage).not.toHaveBeenCalled();
    await h.ok("hello", { protocolVersion: 1 });
    expect((await h.ok("getStatus")).metrics.ignoredMessages).toBe(4);
  });

  it("ignores messages whose source is not the parent window", async () => {
    h = await FrameHarness.create();
    await h.post(req("hello", { protocolVersion: 1 }), { source: { postMessage() {} } });
    await h.post(req("hello", { protocolVersion: 1 }), { source: null });
    expect(h.parent.postMessage).not.toHaveBeenCalled();
  });

  it("replies only to the exact sender origin, never '*'", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    await h.request("getStatus", {}, { origin: STAGING_ORIGIN });
    await h.fail("createAgent", { bogus: true });
    const targets = h.parent.posted.map((p) => p.targetOrigin);
    expect(targets).toEqual([APP_ORIGIN, STAGING_ORIGIN, APP_ORIGIN]);
    expect(targets).not.toContain("*");
    for (const call of h.parent.postMessage.mock.calls) expect(call[1]).not.toBe("*");
  });

  it("announces ready to each allowed origin (the browser delivers it only to the real parent)", async () => {
    h = await FrameHarness.create();
    h.core.announceReady();
    expect(h.parent.posted.map((p) => [p.targetOrigin, p.message.kind === "event" && p.message.event])).toEqual([
      [APP_ORIGIN, "ready"],
      [STAGING_ORIGIN, "ready"],
    ]);
  });

  it("drops events until hello bound an origin", async () => {
    h = await FrameHarness.create();
    await h.request("setLimits", { maxOrdersPerMinute: 10 }); // NOT_CONNECTED: no statusChanged either
    expect(h.events("statusChanged")).toHaveLength(0);
  });
});

describe("message validation", () => {
  it("ignores messages that are not Kokoah protocol messages", async () => {
    h = await FrameHarness.create();
    for (const data of [null, "hello", 42, [], { type: "wallet-extension" }, { protocol: "other" }, { protocol: PROTOCOL_NAME, version: 1, kind: "request" }]) {
      await h.post(data);
    }
    expect(h.parent.postMessage).not.toHaveBeenCalled();
  });

  it("requires hello first", async () => {
    h = await FrameHarness.create();
    expect((await h.fail("getStatus")).code).toBe("NOT_CONNECTED");
  });

  it("rejects malformed requests with a clear code", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    expect((await h.fail("nope" as never)).code).toBe("UNKNOWN_METHOD");
    expect((await h.fail("getStatus", { extra: 1 })).code).toBe("INVALID_REQUEST");
    expect((await h.fail("createAgent", { userAddress: "0x12", validForDays: 30, storageMode: "device" })).code).toBe("INVALID_REQUEST");
    expect((await h.fail("createAgent", { userAddress: "0x1111111111111111111111111111111111111111", validForDays: 31, storageMode: "device" })).code).toBe("INVALID_REQUEST");
    expect((await h.fail("createAgent", { userAddress: "0x1111111111111111111111111111111111111111", validForDays: 0, storageMode: "device" })).code).toBe("INVALID_REQUEST");
    expect((await h.fail("createAgent", { userAddress: "0x1111111111111111111111111111111111111111", validForDays: 1.5, storageMode: "device" })).code).toBe("INVALID_REQUEST");
    expect((await h.fail("createAgent", { userAddress: "0x1111111111111111111111111111111111111111", validForDays: 3, storageMode: "cloud" })).code).toBe("INVALID_REQUEST");
    expect((await h.fail("createAgent", { userAddress: "0x1111111111111111111111111111111111111111", validForDays: 3, storageMode: "device", agentName: "x".repeat(17) })).code).toBe("INVALID_REQUEST");
    expect((await h.fail("createAgent", { userAddress: "0x1111111111111111111111111111111111111111", validForDays: 3, storageMode: "device", agentName: "a valid_until 1" })).code).toBe("INVALID_REQUEST");
    expect((await h.fail("signAndSubmit", { requestId: "has spaces", intent: {} })).code).toBe("INVALID_REQUEST");
    expect((await h.fail("signAndSubmit", { requestId: "x".repeat(129), intent: {} })).code).toBe("INVALID_REQUEST");
    // Echoed in every status afterwards: a 64-hex coin would make every status fail the outgoing guard.
    expect((await h.fail("setLimits", { allowedCoins: ["ETH", `xyz:${"0".repeat(64)}`] })).code).toBe("INVALID_REQUEST");
    expect((await h.fail("confirmAgent", { timeoutMs: 60_001 })).code).toBe("INVALID_REQUEST");
    expect((await h.fail("setTheme", { variables: { "--evil": "red" } })).code).toBe("INVALID_REQUEST");
    const theme = await h.fail("setTheme", { variables: { "--ks-bg": "url(https://evil.example/x)" } });
    expect(theme.code).toBe("INVALID_REQUEST");
    const issues = (await h.fail("createAgent", { userAddress: "0x12", validForDays: 30, storageMode: "device" })).details?.issues;
    expect(issues?.[0]?.path).toBe("userAddress");
  });

  it("rejects an unsupported protocol version", async () => {
    h = await FrameHarness.create();
    await h.post({ protocol: PROTOCOL_NAME, version: 2, kind: "request", id: "v2", method: "hello", params: { protocolVersion: 2 } });
    const r = h.parent.posted[0]?.message;
    expect(r).toMatchObject({ kind: "response", id: "v2", ok: false, error: { code: "UNSUPPORTED_VERSION" } });
    expect((await h.fail("hello", { protocolVersion: 2 })).code).toBe("UNSUPPORTED_VERSION");
  });

  it("rejects oversized messages before parsing them", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const big = { requestId: "big", intent: { kind: "noop", origin: "manual", pad: "x".repeat(MAX_MESSAGE_BYTES) } };
    const e = await h.fail("signAndSubmit", big);
    expect(e.code).toBe("PAYLOAD_TOO_LARGE");
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("rejects values that can't be serialized", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect((await h.fail("signAndSubmit", { requestId: "c", intent: cyclic })).code).toBe("INVALID_REQUEST");
    expect((await h.fail("signAndSubmit", { requestId: "b", intent: { n: 1n } })).code).toBe("INVALID_REQUEST");
  });

  it("classifyMessage caps size and validates params", () => {
    expect(classifyMessage({ protocol: PROTOCOL_NAME, version: 1, kind: "request", id: "a", method: "getStatus", params: {} })).toMatchObject({ kind: "request", method: "getStatus" });
    expect(classifyMessage({ protocol: PROTOCOL_NAME, version: 1, kind: "request", id: "a", method: "getStatus", params: { pad: "x".repeat(100) } }, 50)).toMatchObject({ kind: "invalid", code: "PAYLOAD_TOO_LARGE" });
    expect(classifyMessage({ protocol: PROTOCOL_NAME, version: 1, kind: "request", id: "bad id!", method: "getStatus" })).toMatchObject({ kind: "ignore" });
    expect(classifyMessage({ protocol: PROTOCOL_NAME, version: 1, kind: "request", id: "9".repeat(64), method: "getStatus" })).toMatchObject({ kind: "ignore" });
    expect(classifyMessage({ protocol: PROTOCOL_NAME, version: 1, kind: "request", id: "9".repeat(63), method: "getStatus" })).toMatchObject({ kind: "request" });
    expect(classifyMessage({ protocol: PROTOCOL_NAME, version: 1, kind: "response", id: "a", method: "getStatus" })).toMatchObject({ kind: "ignore" });
  });
});

describe("hello and status", () => {
  it("reports version, network, builder and capabilities", async () => {
    h = await FrameHarness.create();
    const r = await h.ok("hello", { protocolVersion: 1, client: { name: "kokoah-frontend", version: "1.0.0" } });
    expect(r).toMatchObject({
      protocolVersion: 1,
      frameOrigin: "https://signer.kokoah.example",
      network: "testnet",
      mainnetWritesEnabled: false,
      builder: { address: "0x00000000000000000000000000000000000b0b1d", feeTenthsBps: 25 },
      capabilities: { storageModes: ["passkey", "device", "session"], webLocks: true, indexedDB: true, passkey: { available: true, prf: "supported" } },
      limits: { maxMessageBytes: MAX_MESSAGE_BYTES, minValidForDays: 1, maxValidForDays: 30, expiresAfterMs: 15_000, maxAgentNameLength: 16 },
    });
  });

  it("shows the network in status, including an explicit mainnet build", async () => {
    h = await FrameHarness.create({ config: testConfig({ VITE_HL_NETWORK: "mainnet", VITE_ALLOW_MAINNET_WRITES: "true" }) });
    await h.ok("hello", { protocolVersion: 1 });
    const s = await h.ok("getStatus");
    expect(s.network).toBe("mainnet");
    expect(s.mainnetWritesEnabled).toBe(true);
    expect(s).toMatchObject({ hasKey: false, keyState: "none", agentAddress: null, locked: false, storageMode: null });
  });

  it("status carries the effective policy summary", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const s = await h.ok("getStatus");
    expect(s.policy).toEqual({
      allowedActionTypes: ["order", "cancel", "cancelByCloid", "modify", "batchModify", "updateLeverage", "updateIsolatedMargin", "scheduleCancel", "noop"],
      allowedCoins: "*",
      maxOrderNotionalUsd: 1_000_000,
      maxDailyNotionalUsd: 25_000_000,
      maxLeverage: "market",
      maxOrdersPerMinute: 60,
      priceBandPct: 10,
      requireStopLossForNewEntries: false,
      builder: { address: "0x00000000000000000000000000000000000b0b1d", feeTenthsBps: 25 },
      vaultAddressAllowed: false,
      expiresAfterMs: 15_000,
      allowedOrigins: ["manual", "ai_ticket"],
      userLimits: null,
    });
  });

  it("applies validated theme variables through the CSSOM", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const r = await h.ok("setTheme", { variables: { "--ks-accent": "#ff8800", "--ks-radius": "4px", "--ks-font": "Inter, system-ui, sans-serif" }, colorScheme: "light" });
    expect(r.applied).toEqual(["--ks-accent", "--ks-radius", "--ks-font"]);
    expect(document.documentElement.style.getPropertyValue("--ks-accent")).toBe("#ff8800");
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("light");
  });
});

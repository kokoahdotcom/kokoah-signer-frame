import { afterEach, describe, expect, it, vi } from "vitest";
import { KokoahSignerClient, SignerRequestError } from "../src/client/index.js";
import { PROTOCOL_NAME, PROTOCOL_VERSION } from "../src/protocol/index.js";
import { DAY, FRAME_ORIGIN, FrameHarness, limitOrder, MockPasskeys, testConfig, USER, waitFor, type HarnessOptions } from "./helpers.js";

const FRAME_URL = `${FRAME_ORIGIN}/`;
const appConfig = () => testConfig({ VITE_ALLOWED_PARENT_ORIGINS: window.location.origin }, false);
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** Connects a real client (parent side) to a real FrameCore (frame side) through jsdom message events. */
async function connected(options: { passkeys?: MockPasskeys; harness?: HarnessOptions; clientOptions?: Partial<ConstructorParameters<typeof KokoahSignerClient>[0]> } = {}) {
  const appOrigin = window.location.origin;
  const harnessOptions: HarnessOptions = { config: appConfig(), ...options.harness, ...(options.passkeys ? { passkeys: options.passkeys } : {}) };
  const client = new KokoahSignerClient({ frameUrl: FRAME_URL, helloTimeoutMs: 3_000, ...options.clientOptions });
  const frameWindow = client.iframe.contentWindow as Window;
  const sentByClient: Array<{ message: unknown; targetOrigin: string }> = [];
  /** The frame document currently loaded in the iframe. */
  const frame = { h: await FrameHarness.create(harnessOptions) };
  const attach = (h: FrameHarness) => {
    h.parent.postMessage.mockImplementation((message: unknown, targetOrigin: string) => {
      h.parent.posted.push({ message: structuredClone(message) as never, targetOrigin });
      if (targetOrigin === appOrigin && frame.h === h) window.dispatchEvent(new MessageEvent("message", { data: structuredClone(message), origin: FRAME_ORIGIN, source: frameWindow }));
    });
  };
  attach(frame.h);
  Object.defineProperty(frameWindow, "postMessage", {
    configurable: true,
    value: (message: unknown, targetOrigin: string) => {
      sentByClient.push({ message, targetOrigin });
      if (targetOrigin === FRAME_ORIGIN) void frame.h.core.handleMessage({ data: structuredClone(message), origin: appOrigin, source: frame.h.parent });
    },
  });
  /** Simulates a reload of the iframe: a new frame document on the same storage, which announces ready (unless told not to). */
  const reload = async (o: { announce?: boolean } = {}): Promise<FrameHarness> => {
    const old = frame.h;
    const next = await FrameHarness.create({ ...harnessOptions, idb: old.idb, clock: old.clock, hl: old.hl });
    old.destroy();
    frame.h = next;
    attach(next);
    if (o.announce !== false) next.core.announceReady();
    return next;
  };
  cleanups.push(() => {
    client.destroy();
    frame.h.destroy();
  });
  frame.h.core.announceReady();
  return { h: frame.h, frame, reload, client, sentByClient, frameWindow };
}

describe("KokoahSignerClient", () => {
  it("creates a hidden iframe for the frame URL with passkey permissions delegated", () => {
    const client = new KokoahSignerClient({ frameUrl: FRAME_URL });
    cleanups.push(() => client.destroy());
    const f = client.iframe;
    expect(f.isConnected).toBe(true);
    expect(f.hidden).toBe(true);
    expect(f.src).toBe(FRAME_URL);
    expect(f.getAttribute("allow")).toBe("publickey-credentials-get; publickey-credentials-create");
    expect(f.hasAttribute("data-kokoah-signer")).toBe(true);
    expect(f.title).toBe("Kokoah signer");
    expect(client.frameOrigin).toBe(FRAME_ORIGIN);
    expect(() => new KokoahSignerClient({ frameUrl: "http://signer.kokoah.example/" })).toThrow(TypeError);
  });

  it("handshakes and returns network and builder for the app to compare with public-config", async () => {
    const { client, sentByClient } = await connected();
    const hello = await client.hello();
    expect(hello.network).toBe("testnet");
    expect(hello.builder).toEqual({ address: "0x00000000000000000000000000000000000b0b1d", feeTenthsBps: 25 });
    expect(hello.frameOrigin).toBe(FRAME_ORIGIN);
    expect(client.connection).toEqual(hello);
    expect(await client.hello()).toBe(hello); // cached
    expect(sentByClient.every((s) => s.targetOrigin === FRAME_ORIGIN)).toBe(true);
  });

  it("runs the enable-trading and trading flow with typed methods and events", async () => {
    const { h, client } = await connected();
    const statuses: unknown[] = [];
    const off = client.on("statusChanged", (s) => statuses.push(s));
    // No explicit hello: the client sends it first.
    const created = await client.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    expect(created.approveAgent.typedData.primaryType).toBe("HyperliquidTransaction:ApproveAgent");
    h.hl.approve(USER, created.agentAddress, created.agentName, created.validUntil);
    const confirmed = await client.confirmAgent({ timeoutMs: 1_000 });
    expect(confirmed.keyState).toBe("active");
    const r = await client.signAndSubmit({ requestId: "c-1", intent: limitOrder() as never });
    expect(r).toMatchObject({ status: "ok", actionType: "order", replayed: false });
    expect(r.cloids).toHaveLength(1);
    expect((await client.getStatus()).agentAddress).toBe(created.agentAddress);
    expect((await client.setLimits({ maxOrdersPerMinute: 5 })).policy.maxOrdersPerMinute).toBe(5);
    expect((await client.setTheme({ variables: { "--ks-accent": "#00ff00" } })).applied).toEqual(["--ks-accent"]);
    expect((await client.lock()).locked).toBe(true);
    expect((await client.unlock()).locked).toBe(false);
    expect((await client.setStorageMode({ to: "device" })).storageMode).toBe("device");
    const revoked = await client.revoke();
    expect(revoked.wiped).toBe(true);
    expect(revoked.revokeAgent.typedData.primaryType).toBe("HyperliquidTransaction:ApproveAgent");
    await waitFor(() => statuses.length >= 5);
    off();
    const n = statuses.length;
    await client.setLimits({});
    expect(statuses.length).toBe(n);
  });

  it("links a phone: createLinkedAgent returns the matching code, confirmAgent activates the key", async () => {
    const { h, client } = await connected();
    const created = await client.createLinkedAgent({
      userAddress: USER,
      agentName: "kokoah-ph12",
      validForDays: 30,
      storageMode: "device",
      link: { pairingId: "0b7f1a52-3c3d-4c1e-9d0e-6a1b2c3d4e5f", secret: "AAECAwQFBgcICQoLDA0ODw" },
    });
    expect(created.matchCode).toMatch(/^\d{6}$/);
    expect(created.keyState).toBe("pending");
    h.hl.approve(USER, created.agentAddress, created.agentName, created.validUntil);
    expect((await client.confirmAgent({ timeoutMs: 1_000 })).keyState).toBe("active");
  });

  it("surfaces frame errors as SignerRequestError with the protocol code", async () => {
    const { client } = await connected();
    await client.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    const e = await client.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SignerRequestError);
    expect(e).toMatchObject({ code: "KEY_EXISTS", method: "createAgent", retryable: false });
    const d = await client.setLimits({ priceBandPct: 50 }).catch((x: unknown) => x);
    expect(d).toMatchObject({ code: "LIMIT_LOOSENING_REJECTED", details: { fields: ["priceBandPct"] } });
  });

  it("shows the iframe while the frame shows a passkey prompt, then hides it", async () => {
    const { h, client } = await connected({ passkeys: new MockPasskeys() });
    const prompts: unknown[] = [];
    client.on("promptChanged", (p) => prompts.push(p));
    const creating = client.createAgent({ userAddress: USER, validForDays: 30, storageMode: "passkey" });
    await waitFor(() => !client.iframe.hidden);
    expect(client.iframe.getAttribute("data-kokoah-signer-prompt")).toBe("passkey-create");
    await h.clickPrompt();
    expect((await creating).storageMode).toBe("passkey");
    expect(client.iframe.hidden).toBe(true);
    expect(client.iframe.hasAttribute("data-kokoah-signer-prompt")).toBe(false);
    expect(prompts).toEqual([
      { visible: true, kind: "passkey-create" },
      { visible: false, kind: null },
    ]);
  });

  it("listeners registered before hello() receive the events the frame emits right after hello", async () => {
    // A device key that expires in 5 days, stored by an earlier frame load.
    const first = await FrameHarness.create();
    const { address, validUntil } = await first.activeAgent("device", 5);
    first.destroy();
    const { client } = await connected({ harness: { idb: first.idb, clock: first.clock, hl: first.hl } });
    const expiring: unknown[] = [];
    client.on("keyExpiringSoon", (e) => expiring.push(e));
    const hello = await client.hello();
    expect(expiring).toEqual([{ agentAddress: address, validUntil, msRemaining: 5 * DAY }]);
    // And the hello result carries the same state for an app that subscribes later.
    expect(hello.status).toMatchObject({ agentAddress: address, keyState: "active", expiringSoon: true, expired: false, expiresAt: validUntil - 15_000 });
    expect((await client.getStatus()).expiringSoon).toBe(true);
  });

  it("re-handshakes with the same params when the frame reloads and emits reconnected with the new hello result", async () => {
    const { client, reload, sentByClient } = await connected({ clientOptions: { clientInfo: { name: "kokoah-frontend", version: "1.2.3" } } });
    const created = await client.createAgent({ userAddress: USER, validForDays: 5, storageMode: "device" });
    const first = client.connection;
    expect(first).not.toBeNull();
    const reconnected: Array<{ status: { agentAddress: string | null } }> = [];
    const expiring: unknown[] = [];
    client.on("reconnected", (hello) => reconnected.push(hello));
    client.on("keyExpiringSoon", (e) => expiring.push(e));
    await client.setLimits({ maxOrdersPerMinute: 5 });

    const next = await reload();
    await waitFor(() => reconnected.length === 1);
    expect(reconnected[0]).toMatchObject({ frameOrigin: FRAME_ORIGIN, network: "testnet", status: { agentAddress: created.agentAddress, keyState: "pending" } });
    expect(client.connection).toEqual(reconnected[0]);
    expect(client.connection).not.toBe(first);
    const hellos = sentByClient.map((s) => s.message as { method: string; params: unknown }).filter((m) => m.method === "hello");
    expect(hellos).toHaveLength(2);
    expect(hellos[1]?.params).toEqual(hellos[0]?.params);
    expect(hellos[1]?.params).toEqual({ protocolVersion: 1, client: { name: "kokoah-frontend", version: "1.2.3" } });
    // The new frame forgot the user limits (the app re-applies them on reconnected), but it answers again.
    const status = await client.getStatus();
    expect(status.agentAddress).toBe(created.agentAddress);
    expect(status.policy.userLimits).toBeNull();
    expect(next.parent.posted.some((p) => p.message.kind === "response" && !p.message.ok)).toBe(false);
    // Listeners registered long before still get the events the new frame emits right after the new hello.
    expect(expiring).toHaveLength(1);
    // A second reload works too.
    await reload();
    await waitFor(() => reconnected.length === 2);
    expect((await client.getStatus()).agentAddress).toBe(created.agentAddress);
  });

  it("requests made while reconnecting wait, and go out after what reconnected listeners send", async () => {
    const { client, reload, sentByClient } = await connected();
    await client.hello();
    client.on("reconnected", () => {
      void client.setLimits({ maxOrdersPerMinute: 3 });
    });
    await reload();
    // The ready is handled; the new handshake is in flight.
    expect(client.connection).toBeNull();
    const status = client.getStatus();
    expect((await status).policy.maxOrdersPerMinute).toBe(3);
    const methods = sentByClient.map((s) => (s.message as { method: string }).method);
    expect(methods.slice(-3)).toEqual(["hello", "setLimits", "getStatus"]);
  });

  it("recovers when the reloaded frame answers NOT_CONNECTED before its ready arrives", async () => {
    const { client, reload } = await connected();
    await client.hello();
    const reconnected = vi.fn();
    client.on("reconnected", reconnected);
    await reload({ announce: false });
    const status = await client.getStatus();
    expect(status.hasKey).toBe(false);
    expect(reconnected).toHaveBeenCalledTimes(1);
  });

  it("fails what the old frame never answered as soon as it reloads, and sends reads again to the new frame", async () => {
    const { client, reload, frameWindow } = await connected({ clientOptions: { requestTimeoutMs: 20_000 } });
    await client.hello();
    const deliver = (frameWindow as unknown as { postMessage: (m: unknown, o: string) => void }).postMessage;
    // The old frame document receives these requests but is replaced before it answers.
    Object.defineProperty(frameWindow, "postMessage", { configurable: true, value: () => {} });
    const started = Date.now();
    const sign = client.signAndSubmit({ requestId: "in-flight", intent: limitOrder() as never }).catch((e: unknown) => e);
    const status = client.getStatus();
    await new Promise((r) => setTimeout(r, 10));
    Object.defineProperty(frameWindow, "postMessage", { configurable: true, value: deliver });
    await reload();
    // At once, not after the 20 s timeout: the action may have gone out, so it is not sent again.
    expect(await sign).toMatchObject({ code: "FRAME_RELOADED", method: "signAndSubmit", retryable: false });
    expect(await status).toMatchObject({ hasKey: false });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("the frame can't fire the client's reconnected event", async () => {
    const { client, frameWindow } = await connected();
    await client.hello();
    const listener = vi.fn();
    client.on("reconnected", listener);
    window.dispatchEvent(new MessageEvent("message", { origin: FRAME_ORIGIN, source: frameWindow, data: { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, kind: "event", event: "reconnected", data: {} } }));
    expect(listener).not.toHaveBeenCalled();
    // The initial ready (before or during the first handshake) is not a reconnect either.
    expect(client.connection).not.toBeNull();
  });

  it("ignores messages from other origins or windows", async () => {
    const { client, frameWindow } = await connected();
    await client.hello();
    const listener = vi.fn();
    client.on("keyExpired", listener);
    const fake = { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, kind: "event", event: "keyExpired", data: { agentAddress: USER, validUntil: 1 } };
    window.dispatchEvent(new MessageEvent("message", { data: fake, origin: "https://evil.example", source: frameWindow }));
    window.dispatchEvent(new MessageEvent("message", { data: fake, origin: FRAME_ORIGIN, source: window }));
    expect(listener).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent("message", { data: fake, origin: FRAME_ORIGIN, source: frameWindow }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("times out requests the frame never answers", async () => {
    const client = new KokoahSignerClient({ frameUrl: FRAME_URL, helloTimeoutMs: 120, requestTimeoutMs: 50 });
    cleanups.push(() => client.destroy());
    Object.defineProperty(client.iframe.contentWindow as Window, "postMessage", { configurable: true, value: () => {} });
    const e = await client.getStatus().catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "TIMEOUT", method: "hello" });
  });

  it("rejects a frame that reports another origin", async () => {
    const client = new KokoahSignerClient({ frameUrl: FRAME_URL, helloTimeoutMs: 1_000 });
    cleanups.push(() => client.destroy());
    const frameWindow = client.iframe.contentWindow as Window;
    Object.defineProperty(frameWindow, "postMessage", {
      configurable: true,
      value: (m: { id: string; method: string }) =>
        queueMicrotask(() =>
          window.dispatchEvent(
            new MessageEvent("message", {
              origin: FRAME_ORIGIN,
              source: frameWindow,
              data: { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, kind: "response", id: m.id, method: m.method, ok: true, result: { protocolVersion: 1, frameOrigin: "https://evil.example" } },
            }),
          ),
        ),
    });
    window.dispatchEvent(new MessageEvent("message", { origin: FRAME_ORIGIN, source: frameWindow, data: { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, kind: "event", event: "ready", data: { protocolVersion: 1 } } }));
    await expect(client.hello()).rejects.toMatchObject({ code: "HANDSHAKE_FAILED" });
  });

  it("destroy rejects pending requests and removes the iframe", async () => {
    const client = new KokoahSignerClient({ frameUrl: FRAME_URL, helloTimeoutMs: 5_000 });
    Object.defineProperty(client.iframe.contentWindow as Window, "postMessage", { configurable: true, value: () => {} });
    const pending = client.getStatus().catch((x: unknown) => x);
    await new Promise((r) => setTimeout(r, 10));
    client.destroy();
    expect(await pending).toMatchObject({ code: "DESTROYED" });
    expect(client.iframe.isConnected).toBe(false);
    await expect(client.lock()).rejects.toMatchObject({ code: "DESTROYED" });
  });

  it("replays signAndSubmit by requestId after a client-side timeout", async () => {
    const { h, client } = await connected();
    const created = await client.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    h.hl.approve(USER, created.agentAddress, created.agentName, created.validUntil);
    await client.confirmAgent();
    const intent = limitOrder() as never;
    const first = await client.signAndSubmit({ requestId: "same-id", intent });
    const again = await client.signAndSubmit({ requestId: "same-id", intent });
    expect(again.replayed).toBe(true);
    expect(again.nonce).toBe(first.nonce);
    expect(h.hl.exchangeCalls).toHaveLength(1);
  });
});

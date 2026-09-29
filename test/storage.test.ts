import { webcrypto } from "node:crypto";
import { recoverL1Signer } from "@kokoah/shared/signing";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebAuthnPasskeyProvider } from "../src/frame/passkey.js";
import { IdbSignerStore, MemorySignerStore } from "../src/frame/storage.js";
import { FrameHarness, limitOrder, MockPasskeys, testConfig, USER, waitFor } from "./helpers.js";

const harnesses: FrameHarness[] = [];
async function frame(o: Parameters<typeof FrameHarness.create>[0] = {}): Promise<FrameHarness> {
  const h = await FrameHarness.create(o);
  harnesses.push(h);
  return h;
}
afterEach(() => {
  for (const h of harnesses.splice(0)) h.destroy();
});

function containsBytes(haystack: unknown, needle: Uint8Array): boolean {
  const seen = new Set<unknown>();
  const hex = Buffer.from(needle).toString("hex");
  const walk = (x: unknown): boolean => {
    if (x === null || x === undefined || seen.has(x)) return false;
    if (typeof x === "string") return x.toLowerCase().includes(hex);
    if (x instanceof Uint8Array || x instanceof ArrayBuffer) return Buffer.from(x instanceof ArrayBuffer ? new Uint8Array(x) : x).toString("hex").includes(hex);
    if (typeof x === "object") {
      seen.add(x);
      return Object.values(x as Record<string, unknown>).some(walk);
    }
    return false;
  };
  return walk(haystack);
}

describe("device storage", () => {
  it("round-trips through IndexedDB (fake-indexeddb) and signs after a reload", async () => {
    const a = await frame();
    const { address, privateKey } = await a.activeAgent("device");
    a.destroy();

    const b = await frame({ idb: a.idb, clock: a.clock, hl: a.hl });
    await b.ok("hello", { protocolVersion: 1 });
    expect(await b.ok("getStatus")).toMatchObject({ hasKey: true, keyState: "active", agentAddress: address, storageMode: "device", locked: false });
    const r = await b.ok("signAndSubmit", { requestId: "after-reload", intent: limitOrder() });
    expect(r.status).toBe("ok");
    const sent = b.hl.exchangeCalls.at(-1)!.body;
    const signer = await recoverL1Signer({ action: sent.action, nonce: sent.nonce, network: testConfig().network, expiresAfter: sent.expiresAfter, signature: sent.signature as never });
    expect(signer.toLowerCase()).toBe(address);

    // At rest: ciphertext only, wrapped by a non-extractable AES-GCM key.
    const store = await IdbSignerStore.open(a.idb);
    const rec = await store.getKeyRecord();
    expect(rec?.storageMode).toBe("device");
    expect(containsBytes(rec, Buffer.from(privateKey.slice(2), "hex"))).toBe(false);
    expect(rec?.deviceKey?.extractable).toBe(false);
    expect(rec?.deviceKey?.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    await expect(webcrypto.subtle.exportKey("raw", rec!.deviceKey as never)).rejects.toThrow();
    expect(rec?.wrapped.iv.byteLength).toBe(12);
  });

  it("a tampered record can't be unwrapped (AES-GCM authentication and address binding)", async () => {
    const a = await frame();
    await a.activeAgent("device");
    const store = await IdbSignerStore.open(a.idb);
    const rec = (await store.getKeyRecord())!;
    rec.wrapped.data[0] = (rec.wrapped.data[0]! + 1) % 256;
    await store.putKeyRecord(rec);
    const b = await frame({ idb: a.idb, clock: a.clock, hl: a.hl });
    await b.ok("hello", { protocolVersion: 1 });
    expect((await b.ok("getStatus")).locked).toBe(true);
    expect((await b.fail("unlock")).code).toBe("UNLOCK_FAILED");
    expect((await b.fail("signAndSubmit", { requestId: "x", intent: limitOrder() })).code).toBe("LOCKED");
  });

  it("lock drops the key from memory; unlock restores it without a prompt", async () => {
    const a = await frame();
    await a.activeAgent("device");
    expect((await a.ok("lock")).locked).toBe(true);
    expect((await a.fail("signAndSubmit", { requestId: "l", intent: limitOrder() })).code).toBe("LOCKED");
    expect((await a.ok("unlock")).locked).toBe(false);
    expect((await a.ok("signAndSubmit", { requestId: "u", intent: limitOrder() })).status).toBe("ok");
  });
});

describe("session storage", () => {
  it("keeps the key in memory only: gone after a reload", async () => {
    const a = await frame();
    await a.activeAgent("session");
    expect((await a.ok("getStatus")).storageMode).toBe("session");
    expect(await (await IdbSignerStore.open(a.idb)).getKeyRecord()).toBeUndefined();
    a.destroy();
    const b = await frame({ idb: a.idb, clock: a.clock, hl: a.hl });
    await b.ok("hello", { protocolVersion: 1 });
    expect(await b.ok("getStatus")).toMatchObject({ hasKey: false, keyState: "none", agentAddress: null });
  });

  it("lock discards a session key", async () => {
    const a = await frame();
    await a.activeAgent("session");
    expect(await a.ok("lock")).toMatchObject({ hasKey: false, locked: false });
  });

  it("replacing a stored key with a session key removes the stored one", async () => {
    const a = await frame();
    await a.activeAgent("device");
    await a.createAgent({ userAddress: USER, validForDays: 30, storageMode: "session", replaceExisting: true });
    expect(await (await IdbSignerStore.open(a.idb)).getKeyRecord()).toBeUndefined();
  });

  it("falls back to session when IndexedDB is unavailable", async () => {
    const a = await frame({ store: new MemorySignerStore() });
    const hello = await a.ok("hello", { protocolVersion: 1 });
    expect(hello.capabilities.storageModes).toEqual(["session"]);
    expect(hello.capabilities.indexedDB).toBe(false);
    const r = await a.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    expect(r.storageMode).toBe("session");
    expect(r.requestedStorageMode).toBe("device");
    expect(r.storageFallbackReason).toMatch(/IndexedDB/);
  });
});

describe("passkey storage (mocked WebAuthn PRF)", () => {
  it("creates a passkey-wrapped key via the in-frame prompt, stays locked after reload, unlocks with the passkey", async () => {
    const passkeys = new MockPasskeys();
    const a = await frame({ passkeys });
    await a.ok("hello", { protocolVersion: 1 });
    const pending = a.createAgent({ userAddress: USER, validForDays: 30, storageMode: "passkey" });
    await waitFor(() => a.events("promptChanged").some((e) => e.visible));
    expect(a.events("promptChanged")[0]).toEqual({ visible: true, kind: "passkey-create" });
    expect(a.root?.querySelector(".ks-title")?.textContent).toBe("Protect your trading key");
    await a.clickPrompt();
    const created = await pending;
    expect(created.storageMode).toBe("passkey");
    expect(a.events("promptChanged").at(-1)).toEqual({ visible: false, kind: null });
    expect(passkeys.createCalls).toHaveLength(1);
    expect(passkeys.createCalls[0]?.rpId).toBe("signer.kokoah.example");
    const privateKey = a.generatedKeys.at(-1)!;

    const store = await IdbSignerStore.open(a.idb);
    const rec = await store.getKeyRecord();
    expect(rec?.storageMode).toBe("passkey");
    expect(rec?.deviceKey).toBeUndefined();
    expect(containsBytes(rec, Buffer.from(privateKey.slice(2), "hex"))).toBe(false);

    // Key usable in this session right away (after confirmation).
    a.hl.approve(USER, created.agentAddress, "kokoah-web", created.validUntil);
    await a.ok("confirmAgent", {});
    expect((await a.ok("signAndSubmit", { requestId: "p0", intent: limitOrder() })).status).toBe("ok");
    a.destroy();

    // Reload: locked until the user unlocks with the passkey (user verification).
    const b = await frame({ idb: a.idb, clock: a.clock, hl: a.hl, passkeys });
    await b.ok("hello", { protocolVersion: 1 });
    expect(await b.ok("getStatus")).toMatchObject({ hasKey: true, locked: true, storageMode: "passkey", keyState: "active" });
    expect((await b.fail("signAndSubmit", { requestId: "p1", intent: limitOrder() })).code).toBe("LOCKED");
    const unlocking = b.ok("unlock");
    await waitFor(() => b.events("promptChanged").some((e) => e.visible && e.kind === "passkey-unlock"));
    await b.clickPrompt();
    expect((await unlocking).locked).toBe(false);
    expect(passkeys.getCalls).toHaveLength(1);
    expect(Array.from(passkeys.getCalls[0]?.credentialId ?? [])).toEqual(Array.from(passkeys.credentialId));
    const r = await b.ok("signAndSubmit", { requestId: "p2", intent: limitOrder() });
    expect(r.status).toBe("ok");
    const sent = b.hl.exchangeCalls.at(-1)!.body;
    expect((await recoverL1Signer({ action: sent.action, nonce: sent.nonce, network: testConfig().network, expiresAfter: sent.expiresAfter, signature: sent.signature as never })).toLowerCase()).toBe(
      privateKeyToAccount(privateKey).address.toLowerCase(),
    );
  });

  it("a different PRF secret can't unlock the key", async () => {
    const passkeys = new MockPasskeys();
    const a = await frame({ passkeys });
    await a.activeAgent("passkey");
    await a.ok("lock");
    passkeys.secret = new Uint8Array(32).fill(8);
    const unlocking = a.request("unlock", {});
    await a.clickPrompt();
    const r = await unlocking;
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe("UNLOCK_FAILED");
    expect((await a.ok("getStatus")).locked).toBe(true);
  });

  it("recovers from a lost passkey: the key stays locked, is removed while locked, and a new key works", async () => {
    const passkeys = new MockPasskeys();
    const a = await frame({ passkeys });
    const lost = await a.activeAgent("passkey");
    a.destroy();
    // A new session, and the passkey is gone (a reset phone, a deleted credential): another secret answers.
    passkeys.secret = new Uint8Array(32).fill(9);
    const b = await frame({ idb: a.idb, clock: a.clock, hl: a.hl, passkeys });
    await b.ok("hello", { protocolVersion: 1 });
    const unlocking = b.request("unlock", {});
    await b.clickPrompt();
    const failed = await unlocking;
    expect(!failed.ok && failed.error.code).toBe("UNLOCK_FAILED");
    // Nothing is thrown away on a failed unlock.
    expect(await b.ok("getStatus")).toMatchObject({ hasKey: true, locked: true, agentAddress: lost.address });
    // The way out needs no passkey: remove this device's key (the app has the main wallet sign revokeAgent)…
    const revoked = await b.ok("revoke", {});
    expect(revoked).toMatchObject({ wiped: true, agentAddress: lost.address, agentName: "kokoah-web" });
    expect(revoked.revokeAgent.action.agentName).toBe("kokoah-web");
    expect(await b.ok("getStatus")).toMatchObject({ hasKey: false });
    // …then create a new key, protected on this device, that signs.
    const fresh = await b.activeAgent("device");
    expect(fresh.address).not.toBe(lost.address);
    expect((await b.ok("signAndSubmit", { requestId: "after-recovery", intent: limitOrder() })).status).toBe("ok");
  });

  it("lets the user retry after dismissing the passkey dialog, and cancel", async () => {
    const passkeys = new MockPasskeys();
    const a = await frame({ passkeys });
    await a.activeAgent("passkey");
    await a.ok("lock");
    passkeys.failNextGet = "cancelled";
    const unlocking = a.ok("unlock");
    await a.clickPrompt();
    await waitFor(() => /cancelled/.test(a.root?.querySelector(".ks-status")?.textContent ?? ""));
    await a.clickPrompt();
    expect((await unlocking).locked).toBe(false);

    await a.ok("lock");
    const cancelled = a.request("unlock", {});
    await a.clickPrompt("cancel");
    const r = await cancelled;
    expect(!r.ok && r.error.code).toBe("USER_CANCELLED");
    expect(a.events("promptChanged").at(-1)).toEqual({ visible: false, kind: null });
  });

  it("times out when the user never clicks", async () => {
    const a = await frame({ passkeys: new MockPasskeys(), promptTimeoutMs: 50 });
    await a.ok("hello", { protocolVersion: 1 });
    const e = await a.fail("createAgent", { userAddress: USER, validForDays: 30, storageMode: "passkey" });
    expect(e.code).toBe("USER_TIMEOUT");
    expect((await a.ok("getStatus")).hasKey).toBe(false);
  });

  it("asks for a second click when the authenticator returns PRF only on assertion", async () => {
    const passkeys = new MockPasskeys();
    passkeys.returnPrfOnCreate = false;
    const a = await frame({ passkeys });
    await a.ok("hello", { protocolVersion: 1 });
    const pending = a.createAgent({ userAddress: USER, validForDays: 30, storageMode: "passkey" });
    await a.clickPrompt();
    await waitFor(() => a.root?.querySelector(".ks-title")?.textContent === "Confirm your passkey");
    await a.clickPrompt();
    expect((await pending).storageMode).toBe("passkey");
    expect(passkeys.createCalls).toHaveLength(1);
    expect(passkeys.getCalls).toHaveLength(1);
  });

  it("falls back to device storage when passkeys or PRF are unsupported", async () => {
    const noWebAuthn = new MockPasskeys();
    noWebAuthn.supportResult = { available: false, prf: "unknown", reason: "WebAuthn is blocked by Permissions-Policy in the signer frame" };
    const a = await frame({ passkeys: noWebAuthn });
    const hello = await a.ok("hello", { protocolVersion: 1 });
    expect(hello.capabilities.storageModes).toEqual(["device", "session"]);
    const r = await a.createAgent({ userAddress: USER, validForDays: 30, storageMode: "passkey" });
    expect(r).toMatchObject({ storageMode: "device", requestedStorageMode: "passkey" });
    expect(r.storageFallbackReason).toMatch(/Permissions-Policy/);
    expect(a.events("promptChanged")).toHaveLength(0);

    const noPrf = new MockPasskeys();
    noPrf.prfEnabled = false;
    const b = await frame({ passkeys: noPrf });
    await b.ok("hello", { protocolVersion: 1 });
    const pending = b.createAgent({ userAddress: USER, validForDays: 30, storageMode: "passkey" });
    await b.clickPrompt();
    const r2 = await pending;
    expect(r2.storageMode).toBe("device");
    expect(r2.storageFallbackReason).toMatch(/PRF/);
  });

  it("renewal reuses the existing passkey credential (no new passkey)", async () => {
    const passkeys = new MockPasskeys();
    const a = await frame({ passkeys });
    await a.activeAgent("passkey");
    const renewing = a.createAgent({ userAddress: USER, validForDays: 30, storageMode: "passkey", replaceExisting: true });
    await a.clickPrompt();
    const r = await renewing;
    expect(r.storageMode).toBe("passkey");
    expect(passkeys.createCalls).toHaveLength(1);
    expect(passkeys.getCalls).toHaveLength(1);
  });

  it("only one prompt at a time", async () => {
    const a = await frame({ passkeys: new MockPasskeys() });
    await a.activeAgent("passkey");
    await a.ok("lock");
    const first = a.request("unlock", {});
    await waitFor(() => a.events("promptChanged").filter((e) => e.visible).length >= 2);
    // A second unlock waits for the first (key operations are serialized), so it doesn't open a second prompt.
    const second = a.request("unlock", {});
    await a.clickPrompt();
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(a.events("promptChanged").filter((e) => e.visible)).toHaveLength(2);
  });
});

describe("setStorageMode (passkey protection without a new approveAgent)", () => {
  it("device → passkey re-wraps the same key with one prompt; after a reload it is locked and unlocks with the passkey", async () => {
    const passkeys = new MockPasskeys();
    const a = await frame({ passkeys });
    const { address, privateKey } = await a.activeAgent("device");
    const approvals = a.hl.exchangeCalls.length;
    const changing = a.ok("setStorageMode", { to: "passkey" });
    await waitFor(() => a.events("promptChanged").some((e) => e.visible && e.kind === "passkey-create"));
    await a.clickPrompt();
    const status = await changing;
    expect(status).toMatchObject({ storageMode: "passkey", keyState: "active", locked: false, agentAddress: address });
    expect(passkeys.createCalls).toHaveLength(1);
    expect(a.hl.exchangeCalls).toHaveLength(approvals);
    const rec = await (await IdbSignerStore.open(a.idb)).getKeyRecord();
    expect(rec).toMatchObject({ storageMode: "passkey", agentAddress: address, keyState: "active" });
    expect(rec?.deviceKey).toBeUndefined();
    expect(containsBytes(rec, Buffer.from(privateKey.slice(2), "hex"))).toBe(false);
    // Still unlocked in this tab.
    expect((await a.ok("signAndSubmit", { requestId: "s0", intent: limitOrder() })).status).toBe("ok");
    a.destroy();

    const b = await frame({ idb: a.idb, clock: a.clock, hl: a.hl, passkeys });
    await b.ok("hello", { protocolVersion: 1 });
    expect(await b.ok("getStatus")).toMatchObject({ locked: true, storageMode: "passkey", agentAddress: address });
    const unlocking = b.ok("unlock");
    await b.clickPrompt();
    expect((await unlocking).locked).toBe(false);
    expect((await b.ok("signAndSubmit", { requestId: "s1", intent: limitOrder() })).status).toBe("ok");
  });

  it("passkey → device removes the protection with one prompt; after a reload it unlocks silently", async () => {
    const passkeys = new MockPasskeys();
    const a = await frame({ passkeys });
    const { address } = await a.activeAgent("passkey");
    const changing = a.ok("setStorageMode", { to: "device" });
    await waitFor(() => a.root?.querySelector(".ks-title")?.textContent === "Remove passkey protection?");
    // Shown in the frame's own fixed style, whatever theme the parent set.
    expect(a.root?.querySelector(".ks-prompt")?.classList.contains("ks-prompt--fixed")).toBe(true);
    expect(a.root?.querySelector(".ks-primary")?.textContent).toBe("Remove protection");
    await a.clickPrompt();
    expect(await changing).toMatchObject({ storageMode: "device", locked: false, agentAddress: address });
    a.destroy();
    const b = await frame({ idb: a.idb, clock: a.clock, hl: a.hl, passkeys });
    await b.ok("hello", { protocolVersion: 1 });
    expect(await b.ok("getStatus")).toMatchObject({ locked: false, storageMode: "device", agentAddress: address, keyState: "active" });
  });

  it("is a no-op for the current mode, refuses session keys, and keeps the device key when the user cancels", async () => {
    const passkeys = new MockPasskeys();
    const a = await frame({ passkeys });
    await a.activeAgent("device");
    expect((await a.ok("setStorageMode", { to: "device" })).storageMode).toBe("device");
    const cancelled = a.request("setStorageMode", { to: "passkey" });
    await a.clickPrompt("cancel");
    const r = await cancelled;
    expect(!r.ok && r.error.code).toBe("USER_CANCELLED");
    expect((await (await IdbSignerStore.open(a.idb)).getKeyRecord())?.storageMode).toBe("device");
    expect((await a.ok("getStatus")).storageMode).toBe("device");

    const s = await frame({ passkeys });
    await s.activeAgent("session");
    expect((await s.fail("setStorageMode", { to: "passkey" })).code).toBe("STORAGE_FAILED");
    const none = await frame({ passkeys });
    await none.ok("hello", { protocolVersion: 1 });
    expect((await none.fail("setStorageMode", { to: "passkey" })).code).toBe("NO_KEY");
    expect((await none.fail("setStorageMode", { to: "session" } as never)).code).toBe("INVALID_REQUEST");
  });

  it("reports PASSKEY_UNAVAILABLE when passkeys can't be used", async () => {
    const passkeys = new MockPasskeys();
    passkeys.supportResult = { available: false, prf: "unknown", reason: "WebAuthn is not available in this browser" };
    const a = await frame({ passkeys });
    await a.activeAgent("device");
    expect((await a.fail("setStorageMode", { to: "passkey" })).code).toBe("PASSKEY_UNAVAILABLE");
  });
});

describe("WebAuthnPasskeyProvider", () => {
  /** A window whose navigator.credentials records the options it receives. */
  function fakeWindow() {
    const prf = new Uint8Array(32).fill(5);
    const credential = { rawId: new Uint8Array([1, 2, 3]).buffer, getClientExtensionResults: () => ({ prf: { enabled: true, results: { first: prf.buffer.slice(0) } } }) };
    const create = vi.fn(async (_o: CredentialCreationOptions) => credential);
    const get = vi.fn(async (_o: CredentialRequestOptions) => credential);
    const win = { isSecureContext: true, crypto: webcrypto, document, PublicKeyCredential: function PublicKeyCredential() {}, navigator: { credentials: { create, get } } };
    return { win: win as unknown as Window, create, get, prf };
  }

  it("requires user verification for both ceremonies (PRF output differs with and without UV)", async () => {
    const { win, create, get, prf } = fakeWindow();
    const provider = new WebAuthnPasskeyProvider(win);
    const prfSalt = new Uint8Array(32).fill(9);
    const created = await provider.create({ rpId: "signer.kokoah.example", rpName: "Kokoah signer", userId: new Uint8Array(16), userName: "u", userDisplayName: "U", prfSalt, timeoutMs: 1_000 });
    expect(created).toEqual({ credentialId: new Uint8Array([1, 2, 3]), prfEnabled: true, prfFirst: prf });
    const createOptions = create.mock.calls[0]?.[0].publicKey;
    expect(createOptions?.authenticatorSelection?.userVerification).toBe("required");
    const got = await provider.get({ rpId: "signer.kokoah.example", credentialId: new Uint8Array([1, 2, 3]), prfSalt, timeoutMs: 1_000 });
    expect(got.prfFirst).toEqual(prf);
    const getOptions = get.mock.calls[0]?.[0].publicKey;
    expect(getOptions?.userVerification).toBe("required");
    expect(getOptions?.rpId).toBe("signer.kokoah.example");
  });
});

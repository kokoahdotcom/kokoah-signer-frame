/**
 * The order confirmation limit (setConfirmLimit): the user may lower the size above which orders wait for the frame's
 * prompt at once, raise it up to the default with the frame's own prompt, and above the default only with the master
 * wallet's signature, the frame's prompt and a day's wait from that prompt. Kept per master; the rolling totals follow
 * the limit in force.
 */
import { afterEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { IDBFactory } from "fake-indexeddb";
import { CONFIRM_LIMIT, confirmLimitMessage, type NetworkName } from "../src/protocol/index.js";
import { confirmSlot, IdbSignerStore, limitsSlot, type StoredConfirmLimit, type StoredConfirmRecord } from "../src/frame/storage.js";
import { Clock, DAY, FakeBus, FakeLocks, FrameHarness, limitOrder, MockHl, waitFor, type HarnessOptions } from "./helpers.js";

let h: FrameHarness;
const others: FrameHarness[] = [];
afterEach(() => {
  h?.destroy();
  for (const o of others.splice(0)) o.destroy();
});

const owner = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** An active key whose master is `master` in `frame`. */
async function activeKey(frame: FrameHarness, master: PrivateKeyAccount, replaceExisting = false) {
  const created = await frame.createAgent({ userAddress: master.address, validForDays: 30, storageMode: "device", ...(replaceExisting ? { replaceExisting } : {}) });
  frame.hl.approve(master.address, created.agentAddress, created.agentName, created.validUntil);
  await frame.ok("confirmAgent", {});
}

/** A frame with an active key whose master is `owner` (a wallet these tests can sign with). */
async function ready(o: HarnessOptions = {}): Promise<FrameHarness> {
  h = await FrameHarness.create(o);
  await h.ok("hello", { protocolVersion: 1 });
  await activeKey(h, owner);
  return h;
}

async function network(): Promise<NetworkName> {
  return (await h.ok("getStatus", {})).network;
}

/** The master wallet's signature of a raise to `usd`, made at `issuedAt` (default: now). */
async function signed(usd: number, issuedAt = h.clock.now(), by: PrivateKeyAccount = owner, net?: NetworkName) {
  const message = confirmLimitMessage({ account: owner.address, usd, issuedAt, network: net ?? (await network()) });
  return { usd, issuedAt, signature: await by.signMessage({ message }) };
}

const status = async () => (await h.ok("getStatus", {})).confirmLimit;
const prompts = (kind: string) => h.promptEvents().filter((e) => e.visible && e.kind === kind);
/** A BTC buy at the mark (100,000): 0.3 is $30,000. */
const btc = (size: string) => limitOrder({ coin: "BTC", size, price: "100000" });
const idleText = () => h.root?.querySelector(".ks-idle-text")?.textContent ?? "";

/** `setConfirmLimit` that waits for the frame's prompt and confirms it. */
async function confirmed(params: Record<string, unknown>, frame: FrameHarness = h) {
  const pending = frame.request("setConfirmLimit", params);
  await frame.clickPrompt();
  const r = await pending;
  if (!r.ok) throw new Error(`setConfirmLimit failed: ${r.error.code} ${r.error.message}`);
  return r.result;
}

/** Signs an order and answers its prompt if one shows: whether it asked. */
async function asked(requestId: string, size: string): Promise<boolean> {
  const before = prompts("order").length;
  const pending = h.request("signAndSubmit", { requestId, intent: btc(size) });
  const prompted = waitFor(() => prompts("order").length > before, 1_500).then(
    () => true,
    () => false,
  );
  const shown = await Promise.race([prompted, pending.then(() => false)]);
  if (shown) await h.clickPrompt();
  const r = await pending;
  if (!r.ok) throw new Error(`signAndSubmit failed: ${r.error.code} ${r.error.message}`);
  return shown;
}

/** Rewrites the stored confirmation limits (as anything else on the signer origin could), then loads a new frame on them. */
async function tampered(change: (masters: Record<string, StoredConfirmLimit>) => void) {
  const net = await network();
  const { clock, hl, idb } = h;
  h.destroy();
  const store = await IdbSignerStore.open(idb);
  const rec = await store.getConfirm(net);
  const masters = structuredClone(rec?.masters ?? {});
  change(masters);
  const next: StoredConfirmRecord = { slot: confirmSlot(net), v: 1, network: net, rev: (rec?.rev ?? 0) + 1, masters, updatedAt: clock.now() };
  expect(await store.replaceConfirm(next, rec?.rev ?? 0)).toBe(true);
  h = await FrameHarness.create({ idb, clock, hl });
  await h.ok("hello", { protocolVersion: 1 });
}
const ownerKey = owner.address.toLowerCase();

describe("the order confirmation limit", () => {
  it("is announced, and is the default until the user sets one", async () => {
    await ready();
    const hello = await h.ok("hello", { protocolVersion: 1 });
    expect(hello.capabilities.setsConfirmLimit).toBe(true);
    expect(hello.limits.confirmOrdersAboveUsd).toBe(CONFIRM_LIMIT.defaultUsd);
    expect(await status()).toEqual({ usd: 25_000, recentUsd: 100_000, dailyUsd: 250_000 });
    expect(idleText()).not.toContain("confirms orders");
  });

  it("needs an active key: one HL lists for its master", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    expect((await h.fail("setConfirmLimit", { usd: 10_000 })).code).toBe("NO_KEY");
    // A key the page created for any address, not approved by that wallet.
    await h.createAgent({ userAddress: owner.address, validForDays: 30, storageMode: "device" });
    expect((await h.fail("setConfirmLimit", { usd: 10_000 })).code).toBe("KEY_PENDING");
  });

  it("takes whole dollars within its bounds", async () => {
    await ready();
    for (const usd of [99, 1_000_001, 1_500.5]) expect((await h.fail("setConfirmLimit", { usd })).code).toBe("INVALID_REQUEST");
  });

  it("lowers at once, with no prompt, and orders above the lower limit then ask, saying so", async () => {
    await ready();
    expect((await h.ok("setConfirmLimit", { usd: 10_000 })).confirmLimit).toEqual({ usd: 10_000, recentUsd: 40_000, dailyUsd: 100_000 });
    expect(h.promptEvents()).toHaveLength(0);
    expect(idleText()).toContain("confirms orders above $10,000");
    const pending = h.request("signAndSubmit", { requestId: "a", intent: btc("0.12") });
    await waitFor(() => h.promptText() !== "");
    expect(h.promptText()).toContain("Orders above $10,000 need your confirmation.");
    await h.clickPrompt("cancel");
    expect((await pending).ok).toBe(false);
    expect(await asked("b", "0.09")).toBe(false);
  });

  it("changes nothing when sent again (the app sends it at every handshake)", async () => {
    await ready();
    await h.ok("setConfirmLimit", { usd: 10_000 });
    const changes = h.events("statusChanged").length;
    await h.ok("setConfirmLimit", { usd: 10_000 });
    expect(h.events("statusChanged")).toHaveLength(changes);
    expect(h.promptEvents()).toHaveLength(0);
  });

  it("goes back up to the default only after the frame's own prompt", async () => {
    await ready();
    await h.ok("setConfirmLimit", { usd: 10_000 });
    const pending = h.request("setConfirmLimit", { usd: 25_000 });
    await waitFor(() => h.promptText() !== "");
    expect(prompts("limits")).toHaveLength(1);
    expect(h.promptText()).toContain("Orders that need your confirmation: above $10,000 → above $25,000");
    await h.clickPrompt("cancel");
    expect((await pending).ok).toBe(false);
    expect((await status())?.usd).toBe(10_000);
    await confirmed({ usd: 25_000 });
    expect((await status())?.usd).toBe(25_000);
  });

  it("refuses a raise above the default without the master wallet's signature of it", async () => {
    await ready();
    const reason = async (params: Record<string, unknown>) => {
      const e = await h.fail("setConfirmLimit", params);
      expect(e.code).toBe("LIMIT_LOOSENING_REJECTED");
      return e.details?.reason;
    };
    const otherNetwork: NetworkName = (await network()) === "mainnet" ? "testnet" : "mainnet";
    expect(await reason({ usd: 150_000 })).toBe("signature");
    expect(await reason({ usd: 150_000, authorization: await signed(150_000, h.clock.now(), stranger) })).toBe("signature");
    expect(await reason({ usd: 150_000, authorization: await signed(150_000, h.clock.now(), owner, otherNetwork) })).toBe("signature");
    expect(await reason({ usd: 150_000, authorization: await signed(100_000) })).toBe("signature"); // signed for less
    const forged = await signed(100_000);
    expect(await reason({ usd: 150_000, authorization: { ...forged, usd: 150_000 } })).toBe("signature"); // not what was signed
    expect(await reason({ usd: 150_000, authorization: await signed(150_000, h.clock.now() - 8 * DAY) })).toBe("expired");
    expect(await reason({ usd: 150_000, authorization: await signed(150_000, h.clock.now() + 10 * MINUTE) })).toBe("expired");
    expect(h.promptEvents()).toHaveLength(0);
    expect((await status())?.usd).toBe(25_000);
  });

  it("raises a day after the user confirms, however long ago the wallet signed, the old limit asking until then", async () => {
    await ready();
    // Dated almost a week back (a page can ask the wallet for any date): the day still runs from the frame's prompt.
    const signedAt = h.clock.now() - 6 * DAY - 23 * 60 * MINUTE;
    const pending = h.request("setConfirmLimit", { usd: 150_000, authorization: await signed(150_000, signedAt) });
    await waitFor(() => h.promptText() !== "");
    const text = h.promptText();
    expect(text).toContain("Raise your confirmation limit?");
    expect(text).toContain("above $25,000 → above $150,000");
    expect(text).toContain(`Your wallet signed it: ${new Date(signedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    expect(text).toContain("It takes effect 24 hours after you confirm");
    expect(text).toContain("Until then orders above $25,000 keep asking");
    await h.clickPrompt();
    expect((await pending).ok).toBe(true);
    const confirmedAt = h.clock.now();
    expect(await status()).toEqual({ usd: 25_000, recentUsd: 100_000, dailyUsd: 250_000, pending: { usd: 150_000, effectiveAt: confirmedAt + DAY } });
    expect(idleText()).toContain("confirms orders above $25,000 (above $150,000 from");
    expect(await asked("before", "0.3")).toBe(true);
    h.clock.advance(DAY - MINUTE);
    expect((await status())?.usd).toBe(25_000);
    h.clock.advance(MINUTE);
    expect(await status()).toEqual({ usd: 150_000, recentUsd: 600_000, dailyUsd: 1_500_000 });
    expect(await asked("after", "1.4")).toBe(false); // $140,000 without a prompt
    expect(await asked("above", "1.6")).toBe(true); // $160,000 asks
  });

  it("counts a day from the signing time for a signature dated a little ahead", async () => {
    await ready();
    const ahead = h.clock.now() + 4 * MINUTE;
    await confirmed({ usd: 150_000, authorization: await signed(150_000, ahead) });
    expect((await status())?.pending).toEqual({ usd: 150_000, effectiveAt: ahead + DAY });
  });

  it("drops a waiting raise when the user keeps the limit, and refuses that signature afterwards, even one dated ahead", async () => {
    await ready();
    const raise = await signed(150_000, h.clock.now() + 4 * MINUTE);
    await confirmed({ usd: 150_000, authorization: raise });
    h.clock.advance(MINUTE);
    await h.ok("setConfirmLimit", { usd: 25_000 }); // the limit in force: cancels the raise, no prompt
    expect(await status()).toEqual({ usd: 25_000, recentUsd: 100_000, dailyUsd: 250_000 });
    const before = prompts("limits").length;
    const e = await h.fail("setConfirmLimit", { usd: 150_000, authorization: raise });
    expect(e.details?.reason).toBe("stale");
    expect(prompts("limits")).toHaveLength(before);
  });

  it("makes every older signature stale once a raise is accepted (a larger one the user turned down included)", async () => {
    await ready();
    const big = await signed(1_000_000);
    const declined = h.request("setConfirmLimit", { usd: 1_000_000, authorization: big });
    await h.clickPrompt("cancel");
    expect((await declined).ok).toBe(false);
    h.clock.advance(MINUTE);
    await confirmed({ usd: 150_000, authorization: await signed(150_000) });
    expect((await h.fail("setConfirmLimit", { usd: 1_000_000, authorization: big })).details?.reason).toBe("stale");
    expect((await status())?.pending?.usd).toBe(150_000);
  });

  it("sends the same waiting raise again as a no-op, which keeps its time", async () => {
    await ready();
    const raise = await signed(150_000);
    await confirmed({ usd: 150_000, authorization: raise });
    const pending = (await status())?.pending;
    h.clock.advance(60 * MINUTE);
    const shown = prompts("limits").length;
    await h.ok("setConfirmLimit", { usd: 150_000, authorization: raise });
    expect(prompts("limits")).toHaveLength(shown);
    expect((await status())?.pending).toEqual(pending);
  });

  it("lowers within a raised limit without a new signature; another device takes it after its own prompt and day", async () => {
    await ready();
    const raise = await signed(150_000);
    await confirmed({ usd: 150_000, authorization: raise });
    h.clock.advance(DAY);
    await h.ok("setConfirmLimit", { usd: 100_000, authorization: raise });
    expect(prompts("limits")).toHaveLength(1); // only the raise asked
    expect((await status())?.usd).toBe(100_000);
    // The app sends its setting at every handshake: here, a no-op.
    await h.ok("setConfirmLimit", { usd: 100_000, authorization: raise });
    // Another device: the same setting and signature, confirmed in that frame's prompt, in force a day later.
    const clock = h.clock;
    h.destroy();
    await ready({ clock });
    await confirmed({ usd: 100_000, authorization: raise });
    expect((await status())?.pending).toEqual({ usd: 100_000, effectiveAt: clock.now() + DAY });
    // A week after the wallet signed, a new device needs a new signature.
    h.destroy();
    await ready({ clock });
    h.clock.advance(6 * DAY + MINUTE);
    expect((await h.fail("setConfirmLimit", { usd: 100_000, authorization: raise })).details?.reason).toBe("expired");
  });

  it("keeps the confirmation limit when other limits change, even when an older build rewrites the limits record", async () => {
    await ready();
    await h.ok("setConfirmLimit", { usd: 10_000 });
    await h.ok("setLimits", { maxLeverage: 5 });
    expect((await status())?.usd).toBe(10_000);
    await h.loosen({});
    expect((await status())?.usd).toBe(10_000);
    // A build without confirmation limits writes the limits record as it knows it.
    const net = await network();
    const store = await IdbSignerStore.open(h.idb);
    const rec = await store.getLimits(net);
    const rev = rec?.rev ?? 0;
    await store.replaceLimits({ slot: limitsSlot(net), v: 1, network: net, rev: rev + 1, master: null, accounts: {}, updatedAt: h.clock.now() }, rev);
    expect((await status())?.usd).toBe(10_000);
  });

  it("holds for the master that set it; another wallet's key has its own, and a pending key can't touch either", async () => {
    await ready();
    await h.ok("setConfirmLimit", { usd: 1_000 });
    // Another wallet's key in this browser: the default, and its own limit.
    await activeKey(h, stranger, true);
    expect((await status())?.usd).toBe(25_000);
    await h.ok("setConfirmLimit", { usd: 5_000 });
    // A key the page made for the owner's address without the wallet: can't set anything.
    await h.createAgent({ userAddress: owner.address, validForDays: 30, storageMode: "device", replaceExisting: true });
    expect((await h.fail("setConfirmLimit", { usd: 24_999 })).code).toBe("KEY_PENDING");
    // The owner's key again: their $1,000 holds, so a $20,000 order asks.
    await activeKey(h, owner, true);
    expect((await status())?.usd).toBe(1_000);
    expect(await asked("x", "0.2")).toBe(true);
    await activeKey(h, stranger, true);
    expect((await status())?.usd).toBe(5_000);
  });

  it("binds orders already waiting to be signed when the user lowers it", async () => {
    const locks = new FakeLocks();
    await ready({ locks });
    // Order A holds the agent lock (its HL call hangs).
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => (releaseA = r));
    let first = true;
    h.hl.responder = async (call) => {
      if (first) {
        first = false;
        await gate;
      }
      return h.hl.defaultExchange(call);
    };
    const a = h.request("signAndSubmit", { requestId: "a", intent: btc("0.01") });
    await waitFor(() => h.hl.exchangeCalls.length === 1);
    // Order B: $20,000, below the $25,000 in force when it was read; it then waits for the lock.
    const b = h.request("signAndSubmit", { requestId: "b", intent: btc("0.2") });
    await waitFor(() => locks.requests.filter((n) => n.includes("/sign/")).length >= 2);
    // The lowering is stored at once, and answered once the order under way is sent.
    const lowering = h.ok("setConfirmLimit", { usd: 5_000 });
    await waitFor(() => locks.requests.filter((n) => n.includes("/sign/")).length >= 3);
    releaseA();
    expect((await lowering).confirmLimit.usd).toBe(5_000);
    expect((await a).ok).toBe(true);
    const rb = await b;
    expect(rb.ok).toBe(false);
    if (!rb.ok) expect(rb.error).toMatchObject({ code: "SIGNER_BUSY", retryable: true, details: { reason: "limitsChanged" } });
    expect(h.hl.exchangeCalls).toHaveLength(1);
    // Sent again, it asks.
    expect(await asked("b2", "0.2")).toBe(true);
  });

  it("scales the rolling totals with it: four times it in 10 minutes", async () => {
    await ready();
    await h.ok("setConfirmLimit", { usd: 1_000 });
    for (const id of ["o1", "o2", "o3", "o4"]) expect(await asked(id, "0.009")).toBe(false); // $900 each: $3,600
    expect(await asked("o5", "0.009")).toBe(true); // $4,500 would pass $4,000
  });

  it("refuses a raise the user confirmed while another tab changed the limit", async () => {
    const bus = new FakeBus();
    const locks = new FakeLocks();
    await ready({ bus, locks });
    const b = await FrameHarness.create({ idb: h.idb, clock: h.clock, hl: h.hl, locks, bus });
    others.push(b);
    await b.ok("hello", { protocolVersion: 1 });
    const raise = h.request("setConfirmLimit", { usd: 150_000, authorization: await signed(150_000) });
    await waitFor(() => h.promptText() !== "");
    expect((await b.ok("setConfirmLimit", { usd: 10_000 })).confirmLimit.usd).toBe(10_000);
    await h.clickPrompt();
    const r = await raise;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: "SIGNER_BUSY", details: { reason: "limitsChanged" } });
    expect(await status()).toEqual({ usd: 10_000, recentUsd: 40_000, dailyUsd: 100_000 });
  });

  it("refuses a raise the user confirmed after the key changed", async () => {
    await ready();
    await h.ok("setConfirmLimit", { usd: 10_000 });
    const raise = h.request("setConfirmLimit", { usd: 20_000 });
    await waitFor(() => h.promptText() !== "");
    await h.ok("revoke", {});
    await h.clickPrompt();
    const r = await raise;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: "SIGNER_BUSY", details: { reason: "keyChanged" } });
  });

  it("counts a stored limit above the default only with a valid signature, and a raise only a day after it", async () => {
    await ready();
    await confirmed({ usd: 150_000, authorization: await signed(150_000) });
    h.clock.advance(DAY);
    expect((await status())?.usd).toBe(150_000);
    const net = await network();
    const real = (await (await IdbSignerStore.open(h.idb)).getConfirm(net))!.masters[ownerKey]!;
    const bad = await signed(150_000, real.raise!.issuedAt, stranger);
    // Another wallet's signature: the default.
    await tampered((m) => (m[ownerKey] = { ...real, raise: { ...real.raise!, signature: bad.signature } }));
    expect((await status())?.usd).toBe(25_000);
    // A raise moved to less than a day after the wallet signed: the default.
    await tampered((m) => (m[ownerKey] = { ...real, raise: { ...real.raise!, effectiveAt: real.raise!.issuedAt + DAY - 1 } }));
    expect((await status())?.usd).toBe(25_000);
    // A raise above what the wallet signed: the default.
    await tampered((m) => (m[ownerKey] = { ...real, raise: { ...real.raise!, usd: 200_000 } }));
    expect((await status())?.usd).toBe(25_000);
    // A limit above the default with no signature, or above the one it has: the default.
    await tampered((m) => (m[ownerKey] = { usd: 900_000, since: 0, at: 0 }));
    expect((await status())?.usd).toBe(25_000);
    const { signedUsd, issuedAt, signature, effectiveAt } = real.raise!;
    await tampered((m) => (m[ownerKey] = { usd: 200_000, since: 0, at: 0, granted: { signedUsd, issuedAt, signature, effectiveAt } }));
    expect((await status())?.usd).toBe(25_000);
    // The same grant for what it allows: counted.
    await tampered((m) => (m[ownerKey] = { usd: 150_000, since: 0, at: 0, granted: { signedUsd, issuedAt, signature, effectiveAt } }));
    expect((await status())?.usd).toBe(150_000);
    // An entry with unreadable times keeps its (lower) limit; one with an unreadable limit is dropped.
    await tampered((m) => (m[ownerKey] = { usd: 1_000, since: -1, at: 0 }));
    expect((await status())?.usd).toBe(1_000);
    await tampered((m) => (m[ownerKey] = { usd: 7, since: 0, at: 0 }));
    expect((await status())?.usd).toBe(25_000);
  });

  it("keeps at most 256 wallets, never dropping a lowered one", async () => {
    await ready();
    const filler = (m: Record<string, StoredConfirmLimit>) => {
      for (let i = 0; i < 256; i++) m[`0x${i.toString(16).padStart(40, "0")}`] = { usd: 1_000, since: 0, at: i };
    };
    await tampered(filler);
    expect((await h.fail("setConfirmLimit", { usd: 10_000 })).code).toBe("STORAGE_FAILED");
    const atDefault = `0x${"0".repeat(39)}5`;
    await tampered((m) => {
      filler(m);
      m[atDefault] = { usd: 25_000, since: 0, at: 5 };
    });
    await h.ok("setConfirmLimit", { usd: 10_000 });
    const rec = await (await IdbSignerStore.open(h.idb)).getConfirm(await network());
    expect(Object.keys(rec!.masters)).toHaveLength(256);
    expect(rec!.masters[atDefault]).toBeUndefined();
    expect(rec!.masters[ownerKey]?.usd).toBe(10_000);
  });

  it("judges the day only on a clock checked with HL in this load, never on the device's alone", async () => {
    // The device clock is 12 hours behind HL.
    const clock = new Clock();
    const hl = new MockHl(clock);
    hl.serverOffsetMs = 12 * HOUR;
    await ready({ clock, hl });
    await waitFor(() => h.core.status().clockOffsetMs === 12 * HOUR);
    const idb = h.idb;
    // Reloaded while the page keeps HL's time from answering: no raise.
    h.destroy();
    hl.infoFailure = (body) => body.type === "exchangeStatus";
    h = await FrameHarness.create({ clock, hl, idb });
    await h.ok("hello", { protocolVersion: 1 });
    const authorization = await signed(150_000, clock.now() + hl.serverOffsetMs);
    const refused = await h.fail("setConfirmLimit", { usd: 150_000, authorization });
    expect(refused).toMatchObject({ code: "HL_UNAVAILABLE", retryable: true });
    expect(prompts("limits")).toHaveLength(0);
    // HL answers: the raise, a day from the confirmation on HL's time.
    hl.infoFailure = null;
    await confirmed({ usd: 150_000, authorization });
    const confirmedAt = clock.now() + hl.serverOffsetMs;
    expect((await status())?.pending).toEqual({ usd: 150_000, effectiveAt: confirmedAt + DAY });
    // A day later, a reload whose clock check fails: the raise doesn't count until it succeeds.
    clock.advance(DAY);
    h.destroy();
    hl.infoFailure = (body) => body.type === "exchangeStatus";
    h = await FrameHarness.create({ clock, hl, idb });
    await h.ok("hello", { protocolVersion: 1 });
    expect((await status())?.usd).toBe(25_000);
    hl.infoFailure = null;
    expect(await asked("checked", "1.4")).toBe(false); // the order's own clock check succeeds: $140,000 without a prompt
    expect((await status())?.usd).toBe(150_000);
  });

  it("lowers before the clock is checked, compared with what is stored, and stores every change it answers", async () => {
    const clock = new Clock();
    const hl = new MockHl(clock);
    await ready({ clock, hl });
    const raise = await signed(150_000);
    await confirmed({ usd: 150_000, authorization: raise });
    clock.advance(DAY);
    await h.ok("setConfirmLimit", { usd: 100_000, authorization: raise });
    const idb = h.idb;
    h.destroy();
    hl.infoFailure = (body) => body.type === "exchangeStatus";
    h = await FrameHarness.create({ clock, hl, idb });
    await h.ok("hello", { protocolVersion: 1 });
    expect((await status())?.usd).toBe(25_000); // nothing above the default counts yet
    // The stored $100,000 again: nothing to change. Lower ones: stored at once.
    await h.ok("setConfirmLimit", { usd: 100_000, authorization: raise });
    await h.ok("setConfirmLimit", { usd: 50_000, authorization: raise });
    await h.ok("setConfirmLimit", { usd: 25_000 });
    // A raise above the default needs HL's time.
    expect((await h.fail("setConfirmLimit", { usd: 150_000, authorization: await signed(150_000) })).code).toBe("HL_UNAVAILABLE");
    hl.infoFailure = null;
    expect(await asked("lowered", "0.9")).toBe(true); // $90,000 asks: the $25,000 was stored
    expect((await status())?.usd).toBe(25_000);
  });

  it("compares a change with what is stored even when a clock is behind, so a lowering is never answered without being stored", async () => {
    const clock = new Clock();
    const hl = new MockHl(clock);
    let mono = 0;
    await ready({ clock, hl, monotonic: () => mono });
    const raise = await signed(150_000);
    await confirmed({ usd: 150_000, authorization: raise });
    clock.advance(DAY + MINUTE);
    mono += DAY + MINUTE;
    await h.ok("setConfirmLimit", { usd: 100_000, authorization: raise });
    // The monotonic clock stops for a day (the device slept), and HL's time can't be read again.
    hl.infoFailure = (body) => body.type === "exchangeStatus";
    clock.advance(DAY);
    expect((await status())?.usd).toBe(100_000);
    await h.ok("setConfirmLimit", { usd: 25_000 });
    mono += DAY;
    expect((await status())?.usd).toBe(25_000);
    hl.infoFailure = null;
    expect(await asked("x", "0.9")).toBe(true);
  });

  it("dates a raise with HL's time read after the user confirms, whatever the local clocks say", async () => {
    const clock = new Clock();
    const hl = new MockHl(clock);
    let mono = 0;
    await ready({ clock, hl, monotonic: () => mono });
    // Both local clocks fall 16 hours behind HL (a sleep that stopped both, with no check since).
    hl.serverOffsetMs += 16 * HOUR;
    // The app dates the wallet's signature with the same local clock.
    const pending = h.request("setConfirmLimit", { usd: 150_000, authorization: await signed(150_000, clock.now()) });
    await h.clickPrompt();
    expect((await pending).ok).toBe(true);
    expect((await status())?.pending?.effectiveAt).toBe(clock.now() + hl.serverOffsetMs + DAY);
    // HL's time can't be read after the confirmation: nothing is stored.
    await h.ok("setConfirmLimit", { usd: 25_000 });
    clock.advance(MINUTE);
    mono += MINUTE;
    const again = h.request("setConfirmLimit", { usd: 150_000, authorization: await signed(150_000, clock.now()) });
    await waitFor(() => h.promptText() !== "");
    hl.infoFailure = (body) => body.type === "exchangeStatus";
    await h.clickPrompt();
    const r = await again;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: "HL_UNAVAILABLE", retryable: true });
    expect((await status())?.pending).toBeUndefined();
  });

  it("tells the parent when a new clock check puts a waiting raise in force", async () => {
    const clock = new Clock();
    const hl = new MockHl(clock);
    let mono = 0;
    await ready({ clock, hl, monotonic: () => mono });
    await confirmed({ usd: 150_000, authorization: await signed(150_000) });
    // A day passes while the monotonic clock stops: still waiting by it.
    clock.advance(DAY + MINUTE);
    expect((await status())?.pending).toBeDefined();
    const before = h.events("statusChanged").length;
    await h.core.syncClock();
    expect(h.events("statusChanged").length).toBeGreaterThan(before);
    expect(h.events("statusChanged").at(-1)?.confirmLimit?.usd).toBe(150_000);
    expect(idleText()).toContain("confirms orders above $150,000");
  });

  it("says when its clock isn't checked yet, and tells the parent once it is", async () => {
    const clock = new Clock();
    const hl = new MockHl(clock);
    await ready({ clock, hl });
    await h.ok("setConfirmLimit", { usd: 10_000 });
    const idb = h.idb;
    h.destroy();
    hl.infoFailure = (body) => body.type === "exchangeStatus";
    h = await FrameHarness.create({ clock, hl, idb });
    await h.ok("hello", { protocolVersion: 1 });
    expect(await status()).toEqual({ usd: 10_000, recentUsd: 40_000, dailyUsd: 100_000, clockUnchecked: true });
    hl.infoFailure = null;
    const before = h.events("statusChanged").length;
    await h.core.syncClock();
    expect(h.events("statusChanged").length).toBeGreaterThan(before);
    expect(h.events("statusChanged").at(-1)?.confirmLimit).toEqual({ usd: 10_000, recentUsd: 40_000, dailyUsd: 100_000 });
  });

  it("tries a first clock check that failed again by itself, and stops once it succeeds", async () => {
    const clock = new Clock();
    const hl = new MockHl(clock);
    await ready({ clock, hl });
    await h.ok("setConfirmLimit", { usd: 10_000 });
    const idb = h.idb;
    h.destroy();
    hl.infoFailure = (body) => body.type === "exchangeStatus";
    h = await FrameHarness.create({ clock, hl, idb });
    await h.ok("hello", { protocolVersion: 1 });
    expect((await status())?.clockUnchecked).toBe(true);
    // HL answers again: the frame's own retry checks the clock, with no action from the parent.
    hl.infoFailure = null;
    const before = h.events("statusChanged").length;
    await waitFor(() => h.events("statusChanged").length > before, 4_000);
    expect(await status()).toEqual({ usd: 10_000, recentUsd: 40_000, dailyUsd: 100_000 });
    // Checked: no more tries.
    const asked = () => hl.infoCalls.filter((c) => c.type === "exchangeStatus").length;
    const after = asked();
    await new Promise((r) => setTimeout(r, 2_500));
    expect(asked()).toBe(after);
  });

  it("tells the parent its clock is checked even when the account has no limit of its own", async () => {
    const clock = new Clock();
    const hl = new MockHl(clock);
    await ready({ clock, hl });
    const idb = h.idb;
    h.destroy();
    hl.infoFailure = (body) => body.type === "exchangeStatus";
    h = await FrameHarness.create({ clock, hl, idb });
    await h.ok("hello", { protocolVersion: 1 });
    expect((await status())?.clockUnchecked).toBe(true);
    hl.infoFailure = null;
    const before = h.events("statusChanged").length;
    await h.core.syncClock();
    expect(h.events("statusChanged")).toHaveLength(before + 1);
    expect(h.events("statusChanged").at(-1)?.confirmLimit).toEqual({ usd: 25_000, recentUsd: 100_000, dailyUsd: 250_000 });
  });

  it("doesn't wake up again and again before the clock is checked", async () => {
    const clock = new Clock();
    const hl = new MockHl(clock);
    await ready({ clock, hl });
    await confirmed({ usd: 150_000, authorization: await signed(150_000) });
    clock.advance(DAY + MINUTE); // due by the device clock
    const idb = h.idb;
    h.destroy();
    hl.infoFailure = (body) => body.type === "exchangeStatus";
    h = await FrameHarness.create({ clock, hl, idb });
    await h.ok("hello", { protocolVersion: 1 });
    const before = h.events("statusChanged").length;
    await new Promise((r) => setTimeout(r, 300));
    expect(h.events("statusChanged").length - before).toBeLessThanOrEqual(1);
  });

  it("keeps the day when the device clock is changed after the check", async () => {
    // The device clock is 10 hours behind HL at load; the system sets it right later, while HL's time can't be read.
    const clock = new Clock();
    const hl = new MockHl(clock);
    hl.serverOffsetMs = 10 * HOUR;
    let mono = 0;
    const monotonic = () => mono;
    await ready({ clock, hl, monotonic });
    await waitFor(() => h.core.status().clockOffsetMs === 10 * HOUR);
    await confirmed({ usd: 150_000, authorization: await signed(150_000, clock.now() + hl.serverOffsetMs) });
    const pending = (await status())?.pending;
    expect(pending?.effectiveAt).toBe(clock.now() + 10 * HOUR + DAY);
    hl.infoFailure = (body) => body.type === "exchangeStatus";
    clock.advance(10 * HOUR); // the device clock jumps to the right time; no time passed
    hl.serverOffsetMs = 0;
    // 14 real hours later: by the wall clock with the old offset it would be due; by the monotonic clock it isn't.
    clock.advance(14 * HOUR + MINUTE);
    mono += 14 * HOUR + MINUTE;
    expect((await status())?.usd).toBe(25_000);
    clock.advance(10 * HOUR);
    mono += 10 * HOUR;
    expect((await status())?.usd).toBe(150_000);
  });

  it("reports a stored limit whose grant this clock hasn't reached yet as waiting", async () => {
    await ready();
    const issuedAt = h.clock.now();
    const { signature } = await signed(150_000, issuedAt);
    await tampered((m) => (m[ownerKey] = { usd: 150_000, since: 0, at: 0, granted: { signedUsd: 150_000, issuedAt, signature, effectiveAt: issuedAt + DAY } }));
    expect(await status()).toEqual({ usd: 25_000, recentUsd: 100_000, dailyUsd: 250_000, pending: { usd: 150_000, effectiveAt: issuedAt + DAY } });
    expect(idleText()).toContain("(above $150,000 from");
    h.clock.advance(DAY);
    expect(await status()).toEqual({ usd: 150_000, recentUsd: 600_000, dailyUsd: 1_500_000 });
  });

  it("checks the clock with HL again when the device clock is set back, and then takes a fresh signature", async () => {
    const clock = new Clock();
    const hl = new MockHl(clock);
    let mono = 0;
    await ready({ clock, hl, monotonic: () => mono });
    clock.advance(-2 * HOUR); // the system sets the wall clock back; HL's time and the monotonic clock go on
    hl.serverOffsetMs = 2 * HOUR;
    await h.ok("setConfirmLimit", { usd: 25_000 });
    await waitFor(() => h.core.status().clockOffsetMs === 2 * HOUR);
    // The app dates the signature with the frame's clock, as it reports it.
    await confirmed({ usd: 150_000, authorization: await signed(150_000, h.core.correctedNow()) });
    expect((await status())?.pending?.usd).toBe(150_000);
  });

  it("dates a lowering with a clock that never runs ahead of HL, so fresh signatures still work after the clock is set right", async () => {
    // The device clock is a day ahead at load and HL's time can't be read; the user lowers the limit.
    const clock = new Clock();
    const hl = new MockHl(clock);
    hl.serverOffsetMs = -DAY;
    hl.infoFailure = (body) => body.type === "exchangeStatus";
    let mono = 0;
    h = await FrameHarness.create({ clock, hl, monotonic: () => mono });
    await h.ok("hello", { protocolVersion: 1 });
    const created = await h.createAgent({ userAddress: owner.address, validForDays: 30, storageMode: "device" });
    h.hl.approve(owner.address, created.agentAddress, created.agentName, created.validUntil);
    await h.ok("confirmAgent", {});
    await h.ok("setConfirmLimit", { usd: 10_000 });
    // HL answers again: a raise signed on HL's time is taken.
    hl.infoFailure = null;
    clock.advance(MINUTE);
    mono += MINUTE;
    await h.ok("getStatus", {});
    await h.core.syncClock();
    await confirmed({ usd: 150_000, authorization: await signed(150_000, clock.now() + hl.serverOffsetMs) });
    expect((await status())?.pending?.usd).toBe(150_000);
  });

  it("signs nothing when the stored confirmation limits can't be read", async () => {
    const idb = new IDBFactory();
    const real = await IdbSignerStore.open(idb);
    let broken = false;
    const store = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "getConfirm" && broken) return async () => Promise.reject(new Error("unreadable"));
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    await ready({ idb, store });
    await h.ok("setConfirmLimit", { usd: 10_000 });
    broken = true;
    const calls = h.hl.exchangeCalls.length;
    expect((await h.fail("signAndSubmit", { requestId: "x", intent: btc("0.01") })).code).toBe("STORAGE_FAILED");
    expect(h.hl.exchangeCalls).toHaveLength(calls);
  });

  it("drops a waiting raise when the user sets a limit up to the default", async () => {
    await ready();
    await h.ok("setConfirmLimit", { usd: 10_000 });
    await confirmed({ usd: 150_000, authorization: await signed(150_000) });
    expect((await status())?.pending?.usd).toBe(150_000);
    await confirmed({ usd: 20_000 });
    expect(await status()).toEqual({ usd: 20_000, recentUsd: 80_000, dailyUsd: 200_000 });
  });

  it("scales the 24-hour total with it: ten times it", async () => {
    await ready();
    await h.ok("setConfirmLimit", { usd: 1_000 });
    // $900 every 11 minutes: never $4,000 in 10 minutes, but $9,900 after eleven orders.
    for (let i = 0; i < 11; i++) {
      expect(await asked(`d${i}`, "0.009")).toBe(false);
      h.clock.advance(11 * MINUTE);
    }
    expect(await asked("d11", "0.009")).toBe(true); // $10,800 would pass $10,000
  });

  it("can't be raised in a frame with no user interface, which refuses orders above it in the user's numbers", async () => {
    await ready({ withUi: false });
    await h.ok("setConfirmLimit", { usd: 10_000 });
    expect((await h.fail("setConfirmLimit", { usd: 20_000 })).code).toBe("LIMIT_LOOSENING_REJECTED");
    const e = await h.fail("signAndSubmit", { requestId: "big", intent: btc("0.12") });
    expect(e.code).toBe("POLICY_DENIED");
    expect(JSON.stringify(e.details)).toContain("Orders of more than $10,000");
  });

  it("names the order's size as the reason, not an empty total of the last minutes", async () => {
    await ready();
    const pending = h.request("signAndSubmit", { requestId: "big", intent: btc("1.5") });
    await waitFor(() => h.promptText() !== "");
    expect(h.promptText()).toContain("Orders above $25,000 need your confirmation.");
    expect(h.promptText()).not.toContain("Orders of about $0");
    await h.clickPrompt();
    expect((await pending).ok).toBe(true);
  });
});

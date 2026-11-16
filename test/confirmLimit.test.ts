/**
 * The order confirmation limit (setConfirmLimit): the user may lower the size above which orders wait for the frame's
 * prompt at once, raise it up to the default with the frame's own prompt, and above the default only with the master
 * wallet's signature, the frame's prompt and a day's wait. The rolling totals follow the limit in force.
 */
import { afterEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { IDBFactory } from "fake-indexeddb";
import { CONFIRM_LIMIT, confirmLimitMessage, type NetworkName } from "../src/protocol/index.js";
import { IdbSignerStore } from "../src/frame/storage.js";
import { DAY, FrameHarness, limitOrder, waitFor, type HarnessOptions } from "./helpers.js";

let h: FrameHarness;
afterEach(() => h?.destroy());

const owner = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

/** A frame with an active key whose master is `owner` (a wallet these tests can sign with). */
async function ready(o: HarnessOptions = {}, master: PrivateKeyAccount = owner): Promise<FrameHarness> {
  h = await FrameHarness.create(o);
  await h.ok("hello", { protocolVersion: 1 });
  const created = await h.createAgent({ userAddress: master.address, validForDays: 30, storageMode: "device" });
  h.hl.approve(master.address, created.agentAddress, created.agentName, created.validUntil);
  await h.ok("confirmAgent", {});
  return h;
}

async function network(): Promise<NetworkName> {
  return (await h.ok("getStatus", {})).network;
}

/** The master wallet's signature of a raise to `usd`, made at `issuedAt` (default: now). */
async function signed(usd: number, issuedAt = h.clock.now(), by: PrivateKeyAccount = owner) {
  const message = confirmLimitMessage({ account: owner.address, usd, issuedAt, network: await network() });
  return { usd, issuedAt, signature: await by.signMessage({ message }) };
}

const status = async () => (await h.ok("getStatus", {})).confirmLimit;
const prompts = (kind: string) => h.promptEvents().filter((e) => e.visible && e.kind === kind);
/** A BTC buy at the mark (100,000): 0.3 is $30,000. */
const btc = (size: string) => limitOrder({ coin: "BTC", size, price: "100000" });

/** `setConfirmLimit` that waits for the frame's prompt and confirms it. */
async function confirmed(params: Record<string, unknown>) {
  const pending = h.request("setConfirmLimit", params);
  await h.clickPrompt();
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

describe("the order confirmation limit", () => {
  it("is announced, and is the default until the user sets one", async () => {
    await ready();
    const hello = await h.ok("hello", { protocolVersion: 1 });
    expect(hello.capabilities.setsConfirmLimit).toBe(true);
    expect(hello.limits.confirmOrdersAboveUsd).toBe(CONFIRM_LIMIT.defaultUsd);
    expect(await status()).toEqual({ usd: 25_000, recentUsd: 100_000, dailyUsd: 250_000 });
  });

  it("needs a key", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    expect((await h.fail("setConfirmLimit", { usd: 10_000 })).code).toBe("NO_KEY");
  });

  it("takes whole dollars within its bounds", async () => {
    await ready();
    for (const usd of [99, 1_000_001, 1_500.5]) expect((await h.fail("setConfirmLimit", { usd })).code).toBe("INVALID_REQUEST");
  });

  it("lowers at once, with no prompt, and orders above the lower limit then ask, saying so", async () => {
    await ready();
    expect((await h.ok("setConfirmLimit", { usd: 10_000 })).confirmLimit).toEqual({ usd: 10_000, recentUsd: 40_000, dailyUsd: 100_000 });
    expect(h.promptEvents()).toHaveLength(0);
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
    expect(await reason({ usd: 150_000 })).toBe("signature");
    expect(await reason({ usd: 150_000, authorization: await signed(150_000, h.clock.now(), stranger) })).toBe("signature");
    expect(await reason({ usd: 150_000, authorization: await signed(100_000) })).toBe("signature"); // signed for less
    const forged = await signed(100_000);
    expect(await reason({ usd: 150_000, authorization: { ...forged, usd: 150_000 } })).toBe("signature"); // not what was signed
    expect(await reason({ usd: 150_000, authorization: await signed(150_000, h.clock.now() - 8 * DAY) })).toBe("expired");
    expect(await reason({ usd: 150_000, authorization: await signed(150_000, h.clock.now() + 10 * 60_000) })).toBe("expired");
    expect(h.promptEvents()).toHaveLength(0);
    expect((await status())?.usd).toBe(25_000);
  });

  it("raises a day after the wallet signed, the old limit asking until then", async () => {
    await ready();
    const signedAt = h.clock.now();
    const pending = h.request("setConfirmLimit", { usd: 150_000, authorization: await signed(150_000, signedAt) });
    await waitFor(() => h.promptText() !== "");
    const text = h.promptText();
    expect(text).toContain("Raise your confirmation limit?");
    expect(text).toContain("above $25,000 → above $150,000, from");
    expect(text).toContain("a day after your wallet signed");
    expect(text).toContain("Until then orders above $25,000 keep asking.");
    await h.clickPrompt();
    expect((await pending).ok).toBe(true);
    expect(await status()).toEqual({ usd: 25_000, recentUsd: 100_000, dailyUsd: 250_000, pending: { usd: 150_000, effectiveAt: signedAt + DAY } });
    expect(await asked("before", "0.3")).toBe(true);
    h.clock.advance(DAY);
    expect(await status()).toEqual({ usd: 150_000, recentUsd: 600_000, dailyUsd: 1_500_000 });
    expect(await asked("after", "1.4")).toBe(false); // $140,000 without a prompt
    expect(await asked("above", "1.6")).toBe(true); // $160,000 asks
  });

  it("applies at once a raise the wallet signed more than a day ago, after the frame's prompt", async () => {
    await ready();
    const old = h.clock.now() - 2 * DAY;
    await confirmed({ usd: 150_000, authorization: await signed(150_000, old) });
    expect(await status()).toEqual({ usd: 150_000, recentUsd: 600_000, dailyUsd: 1_500_000 });
  });

  it("drops a waiting raise when the user lowers or keeps the limit, and refuses that signature afterwards", async () => {
    await ready();
    const raise = await signed(150_000);
    await confirmed({ usd: 150_000, authorization: raise });
    h.clock.advance(60_000);
    await h.ok("setConfirmLimit", { usd: 25_000 }); // the limit in force: cancels the raise, no prompt
    expect(await status()).toEqual({ usd: 25_000, recentUsd: 100_000, dailyUsd: 250_000 });
    const e = await h.fail("setConfirmLimit", { usd: 150_000, authorization: raise });
    expect(e.details?.reason).toBe("stale");
  });

  it("lowers within a raised limit without a new signature, and another device takes it with the raise's", async () => {
    const idbA = new IDBFactory();
    await ready({ idb: idbA });
    const raise = await signed(150_000, h.clock.now() - 2 * DAY);
    await confirmed({ usd: 150_000, authorization: raise });
    await h.ok("setConfirmLimit", { usd: 100_000 });
    expect(h.promptEvents().filter((e) => e.visible)).toHaveLength(1); // only the raise asked
    expect((await status())?.usd).toBe(100_000);
    // The app sends its setting at every handshake: here, a no-op.
    await h.ok("setConfirmLimit", { usd: 100_000, authorization: raise });
    // Another device: the same setting and signature, confirmed in that frame's prompt.
    h.destroy();
    await ready();
    await confirmed({ usd: 100_000, authorization: raise });
    expect((await status())?.usd).toBe(100_000);
    // A week after the wallet signed, a new device needs a new signature.
    h.destroy();
    await ready();
    h.clock.advance(6 * DAY);
    expect((await h.fail("setConfirmLimit", { usd: 100_000, authorization: raise })).details?.reason).toBe("expired");
  });

  it("keeps the confirmation limit when other limits change", async () => {
    await ready();
    await h.ok("setConfirmLimit", { usd: 10_000 });
    await h.ok("setLimits", { maxLeverage: 5 });
    expect((await status())?.usd).toBe(10_000);
    await h.loosen({});
    expect((await status())?.usd).toBe(10_000);
  });

  it("holds for the master that set it: for another wallet's key in this browser it is the default", async () => {
    const idb = new IDBFactory();
    await ready({ idb });
    await h.ok("setConfirmLimit", { usd: 10_000 });
    const net = await network();
    const { clock, hl } = h;
    h.destroy();
    // The same stored limit, named for another master: this key's master trades on the default.
    const store = await IdbSignerStore.open(idb);
    const rec = await store.getLimits(net);
    if (!rec?.confirm) throw new Error("no stored limit");
    await store.replaceLimits({ ...rec, rev: rec.rev + 1, confirm: { ...rec.confirm, master: stranger.address.toLowerCase() as `0x${string}` } }, rec.rev);
    h = await FrameHarness.create({ idb, clock, hl });
    await h.ok("hello", { protocolVersion: 1 });
    expect((await status())?.usd).toBe(25_000);
  });

  it("counts a stored raise only while its signature checks out", async () => {
    const idb = new IDBFactory();
    await ready({ idb });
    const issuedAt = h.clock.now() - 2 * DAY;
    await confirmed({ usd: 150_000, authorization: await signed(150_000, issuedAt) });
    const bad = await signed(150_000, issuedAt, stranger);
    const net = await network();
    const { clock, hl } = h;
    h.destroy();
    // Something else on the signer origin rewrites the record: another wallet's signature, then a raised limit with none.
    const store = await IdbSignerStore.open(idb);
    const rec = await store.getLimits(net);
    if (!rec?.confirm?.raise) throw new Error("no stored raise");
    await store.replaceLimits({ ...rec, rev: rec.rev + 1, confirm: { ...rec.confirm, raise: { ...rec.confirm.raise, signature: bad.signature } } }, rec.rev);
    h = await FrameHarness.create({ idb, clock, hl });
    await h.ok("hello", { protocolVersion: 1 });
    expect((await status())?.usd).toBe(25_000);
    const now = await store.getLimits(net);
    if (!now?.confirm) throw new Error("no stored limit");
    await store.replaceLimits({ ...now, rev: now.rev + 1, confirm: { master: now.confirm.master, usd: 900_000, since: 0 } }, now.rev);
    h.destroy();
    h = await FrameHarness.create({ idb, clock, hl });
    await h.ok("hello", { protocolVersion: 1 });
    expect((await status())?.usd).toBe(25_000);
  });

  it("can't be raised in a frame with no user interface", async () => {
    await ready({ withUi: false });
    await h.ok("setConfirmLimit", { usd: 10_000 });
    const e = await h.fail("setConfirmLimit", { usd: 20_000 });
    expect(e.code).toBe("LIMIT_LOOSENING_REJECTED");
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

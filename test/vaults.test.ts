/**
 * HLP deposits and vault withdrawals: the one fund movement a trading key may make (shared vaults/hlp.ts). Deposits go
 * into HLP only, within the caps, after the user's click in the frame's own prompt; withdrawals come only from a vault
 * the account holds.
 */
import { recoverL1Signer } from "@kokoah/shared/signing";
import { HLP_VAULT_ADDRESSES } from "@kokoah/shared/vaults";
import { afterEach, describe, expect, it } from "vitest";
import { FrameHarness, T0, testConfig, USER } from "./helpers.js";

let h: FrameHarness;
afterEach(() => h?.destroy());

const HLP = HLP_VAULT_ADDRESSES.testnet;
const OTHER = "0x2222222222222222222222222222222222222222";
const deposit = (usd: string) => ({ kind: "hlpDeposit", origin: "manual", usd });
const withdraw = (usd: string, vaultAddress = OTHER) => ({ kind: "vaultWithdraw", origin: "manual", vaultAddress, usd });
const codes = (e: { details?: { violations?: Array<{ code: string }> } }) => (e.details?.violations ?? []).map((v) => v.code);
const ledgerDeposit = (usdc: string, ago: number, vault = HLP) => ({ time: T0 - ago, hash: "0x0", delta: { type: "vaultDeposit", vault, usdc } });

async function promptText(): Promise<string> {
  await new Promise((r) => setTimeout(r, 20));
  return h.root?.querySelector(".ks-prompt")?.textContent ?? "";
}

describe("HLP deposit", () => {
  it("signs a deposit into the frame's own HLP address only after the user's click in the frame", async () => {
    h = await FrameHarness.create();
    const { address } = await h.activeAgent();
    const pending = h.ok("signAndSubmit", { requestId: "d1", intent: deposit("250") });
    const text = await promptText();
    expect(text).toContain("Deposit into HLP");
    expect(text).toContain("250 USDC");
    expect(text).toContain("4 days");
    expect(h.events("promptChanged").at(-1)).toEqual({ visible: true, kind: "vault-deposit" });
    expect(h.hl.exchangeCalls).toHaveLength(0);
    await h.clickPrompt();
    const r = await pending;
    expect(r).toMatchObject({ status: "ok", actionType: "vaultTransfer", cloids: [] });
    expect(h.hl.exchangeCalls).toHaveLength(1);
    const sent = h.hl.exchangeCalls[0]!.body;
    expect(sent.action).toEqual({ type: "vaultTransfer", vaultAddress: HLP, isDeposit: true, usd: 250_000_000 });
    expect(Object.keys(sent.action)).toEqual(["type", "vaultAddress", "isDeposit", "usd"]);
    expect(sent.vaultAddress).toBeUndefined();
    const signer = await recoverL1Signer({ action: sent.action, nonce: sent.nonce, network: testConfig().network, expiresAfter: sent.expiresAfter, signature: sent.signature as never });
    expect(signer.toLowerCase()).toBe(address);
    // The frame read the account's ledger itself, for the key's master.
    expect(h.hl.infoCalls.some((c) => c.type === "userNonFundingLedgerUpdates" && String(c.user).toLowerCase() === USER)).toBe(true);
  });

  it("signs nothing when the user cancels", async () => {
    h = await FrameHarness.create();
    await h.activeAgent();
    const pending = h.fail("signAndSubmit", { requestId: "d1", intent: deposit("10") });
    await h.clickPrompt("cancel");
    expect((await pending).code).toBe("USER_CANCELLED");
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("never takes a vault, an origin or extra fields from the parent", async () => {
    h = await FrameHarness.create();
    await h.activeAgent();
    for (const [i, intent] of [{ ...deposit("10"), vaultAddress: OTHER }, { ...deposit("10"), origin: "bot" }, { ...deposit("10"), isDeposit: true }, deposit("1.1234567")].entries()) {
      expect((await h.fail("signAndSubmit", { requestId: `bad-${i}`, intent })).code).toBe("INVALID_INTENT");
    }
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("refuses more than 10,000 USDC at once, and more than 25,000 in 24 hours counting the ledger, before asking", async () => {
    h = await FrameHarness.create();
    await h.activeAgent();
    expect(codes(await h.fail("signAndSubmit", { requestId: "big", intent: deposit("10000.01") }))).toEqual(["VAULT_DEPOSIT_LIMIT"]);
    h.hl.ledger = [ledgerDeposit("10000", 60_000), ledgerDeposit("9000", 3_600_000), ledgerDeposit("9999", 25 * 3_600_000), ledgerDeposit("5000", 1000, OTHER)];
    const day = await h.fail("signAndSubmit", { requestId: "day", intent: deposit("6000.01") });
    expect(codes(day)).toEqual(["VAULT_DEPOSIT_LIMIT"]);
    expect(day.details?.violations?.[0]?.message).toContain("6,000 USDC is left");
    expect(h.root?.querySelector<HTMLElement>(".ks-prompt")?.hidden).not.toBe(false);
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });

  it("counts its own just-sent deposits on top of a ledger that hasn't caught up", async () => {
    h = await FrameHarness.create();
    await h.activeAgent();
    for (const id of ["a", "b"]) {
      const p = h.ok("signAndSubmit", { requestId: id, intent: deposit("10000") });
      await h.clickPrompt();
      await p;
    }
    expect(codes(await h.fail("signAndSubmit", { requestId: "c", intent: deposit("5000.5") }))).toEqual(["VAULT_DEPOSIT_LIMIT"]);
    expect(h.hl.exchangeCalls).toHaveLength(2);
  });

  it("fails closed when Hyperliquid's ledger can't be read", async () => {
    h = await FrameHarness.create();
    await h.activeAgent();
    h.hl.infoFailure = (b) => b.type === "userNonFundingLedgerUpdates";
    expect((await h.fail("signAndSubmit", { requestId: "x", intent: deposit("10") })).code).toBe("MARKET_DATA_UNAVAILABLE");
    h.hl.infoFailure = null;
    h.hl.ledger = [{ time: T0, delta: { type: "vaultDeposit", vault: HLP } }];
    expect((await h.fail("signAndSubmit", { requestId: "y", intent: deposit("10") })).code).toBe("MARKET_DATA_UNAVAILABLE");
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });
});

describe("vault withdrawal", () => {
  it("withdraws from a vault the account holds, up to its equity, without a prompt", async () => {
    h = await FrameHarness.create();
    await h.activeAgent();
    h.hl.vaultEquities = [{ vaultAddress: OTHER, equity: "120.5" }];
    const r = await h.ok("signAndSubmit", { requestId: "w1", intent: withdraw("120.5") });
    expect(r.status).toBe("ok");
    expect(h.hl.exchangeCalls[0]!.body.action).toEqual({ type: "vaultTransfer", vaultAddress: OTHER, isDeposit: false, usd: 120_500_000 });
    expect(h.events("promptChanged")).toHaveLength(0);
  });

  it("refuses a vault the account doesn't hold, or more than its equity", async () => {
    h = await FrameHarness.create();
    await h.activeAgent();
    h.hl.vaultEquities = [{ vaultAddress: OTHER, equity: "100" }];
    expect(codes(await h.fail("signAndSubmit", { requestId: "w1", intent: withdraw("100.01") }))).toEqual(["VAULT_NOT_ALLOWED"]);
    expect(codes(await h.fail("signAndSubmit", { requestId: "w2", intent: withdraw("1", HLP) }))).toEqual(["VAULT_NOT_ALLOWED"]);
    h.hl.vaultEquities = { not: "a list" };
    expect((await h.fail("signAndSubmit", { requestId: "w3", intent: withdraw("1") })).code).toBe("MARKET_DATA_UNAVAILABLE");
    expect(h.hl.exchangeCalls).toHaveLength(0);
  });
});

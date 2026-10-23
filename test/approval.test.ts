/**
 * While the main wallet approves a new key (`createAgent` → the wallet signs `approveAgent`), the frame shows the new
 * key's full address and a short check code in its own fixed-style panel (`promptChanged` kind `agent-approval`), so
 * the user can compare them with the `agentAddress` the wallet shows. The panel needs no action, takes no focus and
 * gives way to real prompts; it ends with `confirmAgent` (either way), the user's Hide, another key, or a timeout.
 */
import { afterEach, describe, expect, it } from "vitest";
import { agentAddressCheckCode } from "../src/protocol/index.js";
import { FrameHarness, USER, waitFor } from "./helpers.js";

let h: FrameHarness;
afterEach(() => h?.destroy());

const panel = () => h.root?.querySelector<HTMLElement>(".ks-notice") ?? null;
const shownPanel = () => {
  const p = panel();
  return p !== null && !p.hidden;
};
const last = () => h.events("promptChanged").at(-1);

async function created(replaceExisting = false) {
  await h.ok("hello", { protocolVersion: 1 });
  return await h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device", replaceExisting });
}

describe("agent approval panel", () => {
  it("formats the check code from the address: its first and last 8 hex digits, in fours", () => {
    expect(agentAddressCheckCode("0x1A2B3C4D00000000000000000000000000005E6F7a8b")).toBe("1a2b 3c4d … 5e6f 7a8b");
  });

  it("is announced in the handshake", async () => {
    h = await FrameHarness.create();
    expect((await h.ok("hello", { protocolVersion: 1 })).capabilities.showsAgentApproval).toBe(true);
  });

  it("shows the new key's full address and check code until confirmAgent succeeds, without taking focus", async () => {
    h = await FrameHarness.create();
    const r = await created();
    expect(last()).toEqual({ visible: true, kind: "agent-approval" });
    expect(shownPanel()).toBe(true);
    const text = panel()!.textContent ?? "";
    expect(text).toContain(r.agentAddress);
    expect(text).toContain(agentAddressCheckCode(r.agentAddress));
    expect(text).toContain("Approve it only if your wallet shows this address");
    // Its own look, whatever the parent's theme; no prompt, nothing to confirm, focus left where it was.
    expect(panel()!.classList.contains("ks-notice--fixed")).toBe(true);
    expect(h.promptText()).toBe("");
    expect(panel()!.contains(h.root!.ownerDocument.activeElement)).toBe(false);
    h.hl.approve(USER, r.agentAddress, r.agentName, r.validUntil);
    await h.ok("confirmAgent", {});
    expect(last()).toEqual({ visible: false, kind: null });
    expect(shownPanel()).toBe(false);
  });

  it("ends when confirmAgent fails, when the user hides it, when another key replaces it, or after its timeout", async () => {
    h = await FrameHarness.create({ agentApprovalTimeoutMs: 200 });
    await created();
    expect((await h.fail("confirmAgent", {})).code).toBe("AGENT_NOT_FOUND");
    expect(shownPanel()).toBe(false);
    expect(last()).toEqual({ visible: false, kind: null });

    await created(true);
    expect(shownPanel()).toBe(true);
    panel()!.querySelector<HTMLButtonElement>(".ks-notice-close")!.click();
    expect(shownPanel()).toBe(false);
    expect(last()).toEqual({ visible: false, kind: null });

    const first = await created(true);
    const second = await created(true);
    expect(panel()!.textContent).toContain(second.agentAddress);
    expect(panel()!.textContent).not.toContain(first.agentAddress);
    await h.ok("revoke", {});
    expect(shownPanel()).toBe(false);

    await created(true);
    expect(shownPanel()).toBe(true);
    await waitFor(() => !shownPanel(), 2_000);
    expect(last()).toEqual({ visible: false, kind: null });
  });

  it("gives way to a prompt and comes back once it closes", async () => {
    h = await FrameHarness.create();
    await created();
    await h.ok("setLimits", { maxOrderNotionalUsd: 100 });
    const loosening = h.request("setLimits", { maxOrderNotionalUsd: 5_000 });
    await waitFor(() => h.promptText() !== "");
    expect(last()).toEqual({ visible: true, kind: "limits" });
    expect(shownPanel()).toBe(false);
    await h.clickPrompt("cancel");
    expect((await loosening).ok).toBe(false);
    expect(last()).toEqual({ visible: true, kind: "agent-approval" });
    expect(shownPanel()).toBe(true);
  });

  it("comes after a passkey prompt, and isn't shown in a frame without a user interface", async () => {
    h = await FrameHarness.create();
    await h.ok("hello", { protocolVersion: 1 });
    const pending = h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "passkey" });
    await h.clickPrompt();
    await pending;
    expect(h.events("promptChanged").filter((e) => e.visible).map((e) => e.kind)).toEqual(["passkey-create", "agent-approval"]);
    h.destroy();

    h = await FrameHarness.create({ withUi: false });
    await h.ok("hello", { protocolVersion: 1 });
    await h.createAgent({ userAddress: USER, validForDays: 30, storageMode: "device" });
    expect(h.events("promptChanged")).toHaveLength(0);
  });
});

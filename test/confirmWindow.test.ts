/**
 * Where the browser can't tell whether the frame's prompt is seen (no IntersectionObserver v2: Firefox, Safari, every
 * iOS browser), a step that moves money or loosens protection is confirmed in a window of the signer's own origin that
 * the frame opens from the user's click, by typing what it does (prompt.ts).
 */
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FrameHarness, MockPasskeys, waitFor } from "./helpers.js";
import { installIntersectionObserver } from "./visibility.js";

let h: FrameHarness | undefined;
let windows: Array<Window & typeof globalThis> = [];
beforeEach(() => {
  installIntersectionObserver(window, "geometry");
  windows = [];
});
afterEach(() => {
  h?.destroy();
  h = undefined;
  installIntersectionObserver(window, "occlusion");
});

/** A fresh window of the signer's origin, as `window.open("")` gives one (a second jsdom window here). */
function open(): Window & typeof globalThis {
  const w = new JSDOM("<!doctype html><html><head></head><body></body></html>", { pretendToBeVisual: true }).window;
  installIntersectionObserver(w, "geometry");
  let gone = false;
  Object.defineProperty(w, "closed", { get: () => gone });
  w.close = () => {
    gone = true;
  };
  windows.push(w);
  return w;
}

async function frame(o: { passkeys?: MockPasskeys } = {}): Promise<FrameHarness> {
  h = await FrameHarness.create({ promptWindow: { open }, ...(o.passkeys ? { passkeys: o.passkeys } : {}) });
  return h;
}

/** Clicks the frame's prompt button, which opens the confirmation window, and returns that window. */
async function openWindow(f: FrameHarness): Promise<Window & typeof globalThis> {
  const before = windows.length;
  await f.clickPrompt();
  await waitFor(() => windows.length > before);
  return windows.at(-1)!;
}

/** Types `text` into the window's prompt and presses its button, as the user does there. */
async function confirmThere(w: Window & typeof globalThis, text: string | null): Promise<void> {
  const doc = w.document;
  await waitFor(() => doc.querySelector<HTMLElement>(".ks-prompt")?.hidden === false);
  if (text !== null) {
    const input = doc.querySelector<HTMLInputElement>(".ks-code-input")!;
    input.value = text;
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
  }
  const button = doc.querySelector<HTMLButtonElement>(".ks-primary")!;
  await waitFor(() => !button.disabled);
  const at = (x: number) => ({ bubbles: true, isPrimary: true, pointerType: "mouse", screenX: x, screenY: 20, clientX: x, clientY: 20 });
  button.dispatchEvent(new w.PointerEvent("pointerover", at(10)));
  button.dispatchEvent(new w.PointerEvent("pointermove", at(12)));
  button.dispatchEvent(new w.PointerEvent("pointermove", at(14)));
  button.dispatchEvent(new w.PointerEvent("pointerdown", { ...at(14), button: 0 }));
  button.click();
}

describe("confirming in a window of its own", () => {
  it("signs an HLP deposit only after the user typed what it does there", async () => {
    const f = await frame();
    await f.activeAgent();
    const pending = f.ok("signAndSubmit", { requestId: "d", intent: { kind: "hlpDeposit", origin: "manual", usd: "250" } });
    await waitFor(() => f.promptText().includes("Deposit into HLP"));
    expect(f.root!.querySelector(".ks-primary")!.textContent).toBe("Open the confirmation window");
    const w = await openWindow(f);
    expect(w.document.querySelector(".ks-body")!.textContent).toContain("250 USDC");
    expect(w.document.querySelector(".ks-code-value")!.textContent).toBe("deposit 250");
    expect(f.hl.exchangeCalls).toHaveLength(0);
    // The wrong words don't do it.
    const button = w.document.querySelector<HTMLButtonElement>(".ks-primary")!;
    const input = w.document.querySelector<HTMLInputElement>(".ks-code-input")!;
    input.value = "deposit 2500";
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(button.disabled).toBe(true);
    await confirmThere(w, "Deposit 250");
    expect(await pending).toMatchObject({ status: "ok", actionType: "vaultTransfer" });
    expect(f.hl.exchangeCalls).toHaveLength(1);
    expect(w.closed).toBe(true);
  });

  it("asks for the first order's side, size and market for a large order", async () => {
    const f = await frame();
    await f.activeAgent();
    const pending = f.ok("signAndSubmit", { requestId: "o", intent: { kind: "order", coin: "BTC", side: "buy", orderType: "limit", size: "0.3", price: "100000", origin: "manual" } });
    await waitFor(() => f.promptText() !== "");
    const w = await openWindow(f);
    expect(w.document.querySelector(".ks-code-value")!.textContent).toBe("Buy 0.3 BTC");
    await confirmThere(w, "buy 0.3 btc");
    expect((await pending).status).toBe("ok");
  });

  it("removes passkey protection after the window's confirmation and a passkey click in the frame", async () => {
    const passkeys = new MockPasskeys();
    const f = await frame({ passkeys });
    await f.activeAgent("passkey");
    const before = passkeys.getCalls.length;
    const pending = f.ok("setStorageMode", { to: "device" });
    await waitFor(() => f.promptText().includes("Remove passkey protection?"));
    const w = await openWindow(f);
    await confirmThere(w, "remove protection");
    // Then WebAuthn, from a click in the frame itself.
    await waitFor(() => f.promptText().includes("Use your passkey"));
    expect(passkeys.getCalls.length).toBe(before);
    await f.clickPrompt();
    expect(await pending).toMatchObject({ storageMode: "device" });
    expect(passkeys.getCalls.length).toBe(before + 1);
  });

  it("keeps passkey protection when the user cancels the passkey step after the window's confirmation", async () => {
    const passkeys = new MockPasskeys();
    const f = await frame({ passkeys });
    await f.activeAgent("passkey");
    const before = passkeys.getCalls.length;
    const pending = f.fail("setStorageMode", { to: "device" });
    await waitFor(() => f.promptText().includes("Remove passkey protection?"));
    const w = await openWindow(f);
    await confirmThere(w, "remove protection");
    await waitFor(() => f.promptText().includes("Use your passkey"));
    await f.clickPrompt("cancel");
    expect(await pending).toMatchObject({ code: "USER_CANCELLED" });
    expect(passkeys.getCalls.length).toBe(before);
    expect((await f.ok("getStatus")).storageMode).toBe("passkey");
  });

  it("signs nothing when the user cancels there", async () => {
    const f = await frame();
    await f.activeAgent();
    const pending = f.fail("signAndSubmit", { requestId: "d", intent: { kind: "hlpDeposit", origin: "manual", usd: "10" } });
    await waitFor(() => f.promptText() !== "");
    const w = await openWindow(f);
    w.document.querySelector<HTMLButtonElement>(".ks-secondary")!.click();
    expect(await pending).toMatchObject({ code: "USER_CANCELLED", details: { prompt: "vault-deposit" } });
    expect(f.hl.exchangeCalls).toHaveLength(0);
    expect(w.closed).toBe(true);
  });
});

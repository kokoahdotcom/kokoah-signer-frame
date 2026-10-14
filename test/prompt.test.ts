/**
 * The in-frame prompt's guard against a hostile parent page (prompt.ts): the primary button works only after the prompt
 * has been shown for the arming delay and, where the browser reports occlusion (IntersectionObserver v2), only while
 * the whole prompt is visible; a click counts only after the user's own pointer moved over the armed button; resizing,
 * focus loss and hiding start over; hold prompts need the button held; focus starts on Cancel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptUi, PromptError, type PromptRequest } from "../src/frame/prompt.js";
import { pointerOnto } from "./helpers.js";

const REQ: PromptRequest = {
  kind: "passkey-unlock",
  title: "Unlock trading",
  body: "Use your passkey.",
  actionLabel: "Unlock",
  cancelLabel: "Cancel",
  timeoutMs: 60_000,
};
const HOLD: PromptRequest = { ...REQ, kind: "limits", title: "Loosen your limits?", body: "Largest order: $100 → $5,000", actionLabel: "Loosen limits", hold: true };

/** jsdom can't make trusted events: by default every dispatched event counts as the user's (`trusted: false` tests the real check). */
function setup(o: { armMs?: number; holdMs?: number; trusted?: boolean } = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const ui = new PromptUi(document, root, () => {}, { armMs: o.armMs ?? 800, holdMs: o.holdMs ?? 800, ...(o.trusted === false ? {} : { isTrusted: () => true }) });
  const primary = root.querySelector<HTMLButtonElement>(".ks-primary")!;
  const cancel = root.querySelector<HTMLButtonElement>(".ks-secondary")!;
  const status = root.querySelector<HTMLElement>(".ks-status")!;
  return { root, ui, primary, cancel, status };
}

const at = (x: number, y = 20, pointerType = "mouse") => ({ bubbles: true, isPrimary: true, pointerType, screenX: x, screenY: y, clientX: x, clientY: y });
const move = (b: HTMLElement, x: number, y = 20) => b.dispatchEvent(new PointerEvent("pointermove", at(x, y)));

describe("prompt arming", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("starts on Cancel and ignores the primary button until the prompt has been shown for the delay", async () => {
    const { ui, primary, cancel } = setup();
    const action = vi.fn(async () => "ok");
    const result = ui.run(REQ, action, () => ({ retry: false }));
    expect(document.activeElement).toBe(cancel);
    expect(primary.disabled).toBe(true);
    // A click timed to the moment the prompt opens does nothing (even if dispatched to a disabled-looking button).
    pointerOnto(primary);
    primary.click();
    vi.advanceTimersByTime(799);
    pointerOnto(primary);
    primary.click();
    expect(action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(primary.disabled).toBe(false);
    pointerOnto(primary);
    primary.click();
    await expect(result).resolves.toBe("ok");
    expect(action).toHaveBeenCalledOnce();
  });

  it("counts a click only after the pointer moved over the armed button", async () => {
    const { ui, primary } = setup();
    const action = vi.fn(async () => "ok");
    const result = ui.run(REQ, action, () => ({ retry: false }));
    // The pointer rests where the button appears (the user clicked something of the page there) and moved before it armed.
    primary.dispatchEvent(new PointerEvent("pointerover", at(10)));
    move(primary, 12);
    vi.advanceTimersByTime(800);
    primary.click();
    // A key press (Enter or Space on the button) is a click without a pointer.
    primary.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    // A pointermove that doesn't move (pressure or buttons changed) is no movement either.
    move(primary, 12);
    primary.click();
    expect(action).not.toHaveBeenCalled();
    move(primary, 13);
    primary.click();
    await expect(result).resolves.toBe("ok");
  });

  it("needs new movement after the pointer left the button", async () => {
    const { ui, primary } = setup({ armMs: 0 });
    const action = vi.fn(async () => "ok");
    const result = ui.run(REQ, action, () => ({ retry: false }));
    vi.advanceTimersByTime(0);
    move(primary, 10);
    move(primary, 11);
    primary.dispatchEvent(new PointerEvent("pointerleave", at(200)));
    primary.click();
    expect(action).not.toHaveBeenCalled();
    move(primary, 12);
    move(primary, 13);
    primary.click();
    await expect(result).resolves.toBe("ok");
  });

  it("ignores events a script dispatched: only the browser's own (trusted) input confirms", () => {
    const { ui, primary } = setup({ trusted: false, armMs: 0 });
    const action = vi.fn(async () => "ok");
    void ui.run(REQ, action, () => ({ retry: false })).catch(() => {});
    vi.advanceTimersByTime(0);
    expect(primary.disabled).toBe(false);
    pointerOnto(primary);
    primary.click();
    expect(action).not.toHaveBeenCalled();
  });

  it("takes a press as presence for a pointer that can't hover (touch)", async () => {
    const { ui, primary } = setup();
    const action = vi.fn(async () => "ok");
    const result = ui.run(REQ, action, () => ({ retry: false }));
    const tap = () => {
      primary.dispatchEvent(new PointerEvent("pointerdown", { ...at(10, 20, "touch"), button: 0 }));
      primary.dispatchEvent(new PointerEvent("pointerup", at(10, 20, "touch")));
      primary.click();
    };
    // A tap before the button armed doesn't count, nor does it count for later.
    tap();
    vi.advanceTimersByTime(800);
    primary.click();
    expect(action).not.toHaveBeenCalled();
    tap();
    await expect(result).resolves.toBe("ok");
  });

  for (const [what, disturb] of [
    ["the frame is resized", () => window.dispatchEvent(new Event("resize"))],
    ["the frame loses focus", () => window.dispatchEvent(new Event("blur"))],
    ["the page is hidden or shown", () => document.dispatchEvent(new Event("visibilitychange"))],
  ] as const) {
    it(`starts over when ${what}: disabled, the delay again, then new movement`, async () => {
      const { ui, primary } = setup();
      const action = vi.fn(async () => "ok");
      const result = ui.run(REQ, action, () => ({ retry: false }));
      vi.advanceTimersByTime(800);
      move(primary, 10);
      move(primary, 11);
      disturb();
      expect(primary.disabled).toBe(true);
      primary.click();
      vi.advanceTimersByTime(799);
      move(primary, 12);
      move(primary, 13);
      primary.click();
      expect(action).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(primary.disabled).toBe(false);
      primary.click();
      expect(action).not.toHaveBeenCalled();
      move(primary, 14);
      primary.click();
      await expect(result).resolves.toBe("ok");
    });
  }

  it("ends the prompt from Cancel, where focus starts, naming the prompt in the error", async () => {
    const { ui, cancel } = setup();
    const result = ui.run(REQ, async () => "ok", () => ({ retry: false }));
    cancel.click();
    await expect(result).rejects.toMatchObject({ code: "USER_CANCELLED", kind: "passkey-unlock" });
    await expect(result).rejects.toBeInstanceOf(PromptError);
  });

  describe("hold to confirm", () => {
    it("confirms only after the button was held for the hold time, showing progress", async () => {
      const { ui, primary, status } = setup();
      const action = vi.fn(async () => "ok");
      const result = ui.run(HOLD, action, () => ({ retry: false }));
      expect(primary.classList.contains("ks-hold")).toBe(true);
      expect(status.textContent).toBe("Press and hold the button to confirm.");
      vi.advanceTimersByTime(800);
      // A click is not enough.
      pointerOnto(primary);
      primary.dispatchEvent(new PointerEvent("pointerup", at(14)));
      primary.click();
      vi.advanceTimersByTime(5_000);
      expect(action).not.toHaveBeenCalled();
      // Released early: nothing, and the bar empties.
      primary.dispatchEvent(new PointerEvent("pointerdown", { ...at(14), button: 0 }));
      expect(primary.classList.contains("ks-holding")).toBe(true);
      expect(status.textContent).toBe("Keep holding…");
      vi.advanceTimersByTime(799);
      primary.dispatchEvent(new PointerEvent("pointerup", at(14)));
      expect(primary.classList.contains("ks-holding")).toBe(false);
      vi.advanceTimersByTime(5_000);
      expect(action).not.toHaveBeenCalled();
      // Held long enough.
      primary.dispatchEvent(new PointerEvent("pointerdown", { ...at(14), button: 0 }));
      vi.advanceTimersByTime(800);
      await expect(result).resolves.toBe("ok");
      expect(action).toHaveBeenCalledOnce();
      expect(primary.classList.contains("ks-hold")).toBe(false);
    });

    it("needs the pointer's movement first, and stops when it leaves or the frame is disturbed", async () => {
      const { ui, primary } = setup({ armMs: 0 });
      const action = vi.fn(async () => "ok");
      const result = ui.run(HOLD, action, () => ({ retry: false }));
      vi.advanceTimersByTime(0);
      // A mouse that didn't move over the button can't start a hold.
      primary.dispatchEvent(new PointerEvent("pointerdown", { ...at(10), button: 0 }));
      vi.advanceTimersByTime(2_000);
      expect(action).not.toHaveBeenCalled();
      pointerOnto(primary);
      vi.advanceTimersByTime(400);
      primary.dispatchEvent(new PointerEvent("pointerleave", at(300)));
      vi.advanceTimersByTime(2_000);
      pointerOnto(primary);
      vi.advanceTimersByTime(400);
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(2_000);
      expect(action).not.toHaveBeenCalled();
      // Touch: the press itself, held.
      primary.dispatchEvent(new PointerEvent("pointerdown", { ...at(10, 20, "touch"), button: 0 }));
      vi.advanceTimersByTime(800);
      await expect(result).resolves.toBe("ok");
    });

    it("keeps a long press from opening the context menu", () => {
      const { ui, primary } = setup();
      void ui.run(HOLD, async () => "ok", () => ({ retry: false })).catch(() => {});
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      primary.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    });
  });

  describe("with IntersectionObserver v2", () => {
    let callback: ((entries: Array<{ isVisible: boolean }>) => void) | undefined;
    const original = { io: window.IntersectionObserver, entry: (window as { IntersectionObserverEntry?: unknown }).IntersectionObserverEntry };
    beforeEach(() => {
      class FakeEntry {}
      Object.defineProperty(FakeEntry.prototype, "isVisible", { value: false });
      class FakeObserver {
        constructor(cb: (entries: Array<{ isVisible: boolean }>) => void, init: { trackVisibility?: boolean }) {
          expect(init.trackVisibility).toBe(true);
          callback = cb;
        }
        observe() {}
        disconnect() {
          callback = undefined;
        }
      }
      Object.assign(window, { IntersectionObserver: FakeObserver, IntersectionObserverEntry: FakeEntry });
    });
    afterEach(() => Object.assign(window, { IntersectionObserver: original.io, IntersectionObserverEntry: original.entry }));

    it("counts the delay only while the whole prompt is visible, and restarts it when covered", async () => {
      const { ui, primary } = setup();
      const action = vi.fn(async () => "ok");
      const result = ui.run(REQ, action, () => ({ retry: false }));
      vi.advanceTimersByTime(5_000);
      expect(primary.disabled).toBe(true);
      callback!([{ isVisible: true }]);
      vi.advanceTimersByTime(500);
      callback!([{ isVisible: false }]);
      vi.advanceTimersByTime(5_000);
      expect(primary.disabled).toBe(true);
      callback!([{ isVisible: true }]);
      vi.advanceTimersByTime(800);
      expect(primary.disabled).toBe(false);
      move(primary, 10);
      move(primary, 11);
      callback!([{ isVisible: false }]);
      expect(primary.disabled).toBe(true);
      primary.click();
      expect(action).not.toHaveBeenCalled();
      callback!([{ isVisible: true }]);
      vi.advanceTimersByTime(800);
      // Covered meanwhile: the pointer must move again.
      primary.click();
      expect(action).not.toHaveBeenCalled();
      move(primary, 12);
      move(primary, 13);
      primary.click();
      await expect(result).resolves.toBe("ok");
      expect(callback).toBeUndefined();
    });
  });
});

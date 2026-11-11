/**
 * The in-frame prompt's guard against a hostile parent page (prompt.ts): the primary button works only after the prompt
 * has been shown for the arming delay and, where the browser reports occlusion (IntersectionObserver v2), only while
 * the whole prompt is visible; a click counts only after the user's own pointer moved over the armed button; the
 * keyboard confirms only after the user's own Tab onto it and Enter or Space held; resizing, focus loss and hiding
 * start over; hold prompts need the button held; focus starts on Cancel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { confirmTextKey, PromptUi, PromptError, type PromptRequest } from "../src/frame/prompt.js";
import { PROMPT_SIZE_MAX_PX } from "../src/protocol/index.js";
import { pointerOnto } from "./helpers.js";
import { installIntersectionObserver } from "./visibility.js";

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
      // The frame forgot the pointer: these moves are the first it sees again, and count from 800 ms on.
      move(primary, 12);
      move(primary, 13);
      primary.click();
      expect(action).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(primary.disabled).toBe(false);
      primary.click();
      move(primary, 14);
      primary.click();
      expect(action).not.toHaveBeenCalled();
      vi.advanceTimersByTime(799);
      move(primary, 15);
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
      move(primary, 9);
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

  describe("from the keyboard", () => {
    const key = (target: EventTarget, type: "keydown" | "keyup", k: string, repeat = false) => {
      const ev = new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, repeat });
      target.dispatchEvent(ev);
      return ev;
    };
    /** The user's Tab (or Shift+Tab) in the frame onto `b`: the browser moves focus right after the keydown. */
    const tabTo = (b: HTMLElement) => {
      key(document.activeElement ?? document.body, "keydown", "Tab");
      b.focus();
    };

    it("confirms any prompt after Tab onto the armed button and Enter held for the hold time", async () => {
      const { ui, primary, status } = setup();
      const action = vi.fn(async () => "ok");
      // A passkey prompt: a short click for the pointer, a hold for the keyboard.
      const result = ui.run(REQ, action, () => ({ retry: false }));
      expect(primary.getAttribute("aria-describedby")).toBe("ks-key-hint");
      expect(document.getElementById("ks-key-hint")?.textContent).toBe("Press and hold Enter or Space to confirm.");
      vi.advanceTimersByTime(800);
      tabTo(primary);
      expect(status.textContent).toBe("Press and hold Enter or Space to confirm.");
      // Enter never clicks the button.
      expect(key(primary, "keydown", "Enter").defaultPrevented).toBe(true);
      expect(primary.classList.contains("ks-holding")).toBe(true);
      vi.advanceTimersByTime(400);
      key(primary, "keydown", "Enter", true); // auto-repeat keeps the hold going
      expect(action).not.toHaveBeenCalled();
      vi.advanceTimersByTime(400);
      await expect(result).resolves.toBe("ok");
      expect(action).toHaveBeenCalledOnce();
    });

    it("doesn't confirm when Enter or Space is released early, and Space doesn't click either", async () => {
      const { ui, primary, status } = setup({ armMs: 0 });
      const action = vi.fn(async () => "ok");
      const result = ui.run(HOLD, action, () => ({ retry: false }));
      vi.advanceTimersByTime(0);
      tabTo(primary);
      key(primary, "keydown", " ");
      vi.advanceTimersByTime(799);
      expect(key(primary, "keyup", " ").defaultPrevented).toBe(true);
      expect(primary.classList.contains("ks-holding")).toBe(false);
      expect(status.textContent).toBe("Press and hold Enter or Space to confirm.");
      vi.advanceTimersByTime(5_000);
      expect(action).not.toHaveBeenCalled();
      key(primary, "keydown", " ");
      vi.advanceTimersByTime(800);
      await expect(result).resolves.toBe("ok");
    });

    it("ignores focus a script moved, a Tab whose moment passed, and keys a script dispatched", () => {
      const { ui, primary } = setup({ armMs: 0 });
      const action = vi.fn(async () => "ok");
      void ui.run(REQ, action, () => ({ retry: false })).catch(() => {});
      vi.advanceTimersByTime(0);
      primary.focus();
      key(primary, "keydown", "Enter");
      vi.advanceTimersByTime(2_000);
      primary.blur();
      key(document.body, "keydown", "Tab");
      vi.advanceTimersByTime(1);
      primary.focus();
      key(primary, "keydown", "Enter");
      vi.advanceTimersByTime(2_000);
      expect(action).not.toHaveBeenCalled();
      document.body.replaceChildren();
      const untrusted = setup({ armMs: 0, trusted: false });
      void untrusted.ui.run(REQ, action, () => ({ retry: false })).catch(() => {});
      vi.advanceTimersByTime(0);
      tabTo(untrusted.primary);
      key(untrusted.primary, "keydown", "Enter");
      vi.advanceTimersByTime(2_000);
      expect(action).not.toHaveBeenCalled();
    });

    it("needs a fresh press after focus, and starts over when the button loses focus or the frame is disturbed", async () => {
      const { ui, primary, cancel } = setup();
      const action = vi.fn(async () => "ok");
      const result = ui.run(HOLD, action, () => ({ retry: false }));
      vi.advanceTimersByTime(800);
      tabTo(primary);
      // A key already held down (only its auto-repeat arrives) doesn't start a hold.
      key(primary, "keydown", "Enter", true);
      vi.advanceTimersByTime(2_000);
      key(primary, "keydown", "Enter");
      vi.advanceTimersByTime(400);
      primary.blur();
      vi.advanceTimersByTime(2_000);
      expect(action).not.toHaveBeenCalled();
      tabTo(primary);
      key(primary, "keydown", "Enter");
      vi.advanceTimersByTime(400);
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(800);
      // Armed again, but the keyboard must bring focus back: Tab away and Shift+Tab back.
      key(primary, "keydown", "Enter");
      vi.advanceTimersByTime(2_000);
      expect(action).not.toHaveBeenCalled();
      tabTo(cancel);
      tabTo(primary);
      key(primary, "keydown", "Enter");
      vi.advanceTimersByTime(800);
      await expect(result).resolves.toBe("ok");
    });
  });

  describe("with IntersectionObserver v2", () => {
    type Entry = { isVisible: boolean; isIntersecting?: boolean; intersectionRatio?: number };
    let callback: ((entries: Entry[]) => void) | undefined;
    let options: { threshold?: number[] } | undefined;
    const seen = { isVisible: true, isIntersecting: true, intersectionRatio: 1 };
    const hidden = { isVisible: false, isIntersecting: true, intersectionRatio: 1 };
    const original = { io: window.IntersectionObserver, entry: (window as { IntersectionObserverEntry?: unknown }).IntersectionObserverEntry };
    beforeEach(() => {
      class FakeEntry {}
      Object.defineProperty(FakeEntry.prototype, "isVisible", { value: false });
      class FakeObserver {
        constructor(cb: (entries: Entry[]) => void, init: { trackVisibility?: boolean; threshold?: number[] }) {
          expect(init.trackVisibility).toBe(true);
          callback = cb;
          options = init;
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
      callback!([seen]);
      vi.advanceTimersByTime(500);
      callback!([hidden]);
      vi.advanceTimersByTime(5_000);
      expect(primary.disabled).toBe(true);
      callback!([seen]);
      vi.advanceTimersByTime(800);
      expect(primary.disabled).toBe(false);
      move(primary, 10);
      move(primary, 11);
      callback!([hidden]);
      expect(primary.disabled).toBe(true);
      primary.click();
      expect(action).not.toHaveBeenCalled();
      callback!([seen]);
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

    it("stays disarmed while any part of the prompt is clipped, even when what shows is unobscured", () => {
      const { ui, primary } = setup();
      const action = vi.fn(async () => "ok");
      void ui.run(HOLD, action, () => ({ retry: false })).catch(() => {});
      expect(options?.threshold).toContain(1);
      // The parent hides the order lines (overflow: hidden, a smaller box): visible, intersecting, but not all of it.
      callback!([{ isVisible: true, isIntersecting: true, intersectionRatio: 0.6 }]);
      vi.advanceTimersByTime(5_000);
      expect(primary.disabled).toBe(true);
      callback!([{ isVisible: true, isIntersecting: false, intersectionRatio: 0 }]);
      vi.advanceTimersByTime(5_000);
      expect(primary.disabled).toBe(true);
      // Whole again (give or take rounding): armed after the delay.
      callback!([{ isVisible: true, isIntersecting: true, intersectionRatio: 0.999 }]);
      vi.advanceTimersByTime(800);
      expect(primary.disabled).toBe(false);
      callback!([{ isVisible: true, isIntersecting: true, intersectionRatio: 0.9 }]);
      expect(primary.disabled).toBe(true);
    });

    it("asks no words to type and opens no window: the browser tells whether the prompt is seen", () => {
      const { ui, root } = setup();
      void ui.run({ ...HOLD, fixedStyle: true }, async () => "ok", () => ({ retry: false })).catch(() => {});
      expect(root.querySelector<HTMLElement>(".ks-code")!.hidden).toBe(true);
    });
  });

  describe("where the browser can't tell whether the prompt is seen", () => {
    afterEach(() => installIntersectionObserver(window, "occlusion"));

    it("never arms without IntersectionObserver, on any prompt", () => {
      installIntersectionObserver(window, "none");
      const { ui, primary, status } = setup({ armMs: 0 });
      const action = vi.fn(async () => "ok");
      void ui.run(REQ, action, () => ({ retry: false })).catch(() => {});
      pointerOnto(primary);
      vi.advanceTimersByTime(30_000);
      expect(primary.disabled).toBe(true);
      expect(status.textContent).toContain("can't show that the prompt is in view");
      pointerOnto(primary);
      primary.click();
      expect(action).not.toHaveBeenCalled();
    });

    it("with IntersectionObserver v1 only, arms only while all of the prompt is in view", async () => {
      let callback: ((entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void) | undefined;
      let init: { trackVisibility?: boolean; threshold?: number[] } | undefined;
      class V1 {
        constructor(cb: typeof callback, options: typeof init) {
          callback = cb;
          init = options;
        }
        observe() {}
        disconnect() {}
      }
      Object.assign(window, { IntersectionObserver: V1, IntersectionObserverEntry: class {} });
      const { ui, primary } = setup();
      const action = vi.fn(async () => "ok");
      const result = ui.run(REQ, action, () => ({ retry: false }));
      pointerOnto(primary);
      expect(init?.trackVisibility).toBeUndefined();
      expect(init?.threshold).toContain(0.995);
      vi.advanceTimersByTime(5_000);
      expect(primary.disabled).toBe(true);
      // The parent clips part of it, then shows it whole.
      callback!([{ isIntersecting: true, intersectionRatio: 0.6 }]);
      vi.advanceTimersByTime(5_000);
      expect(primary.disabled).toBe(true);
      callback!([{ isIntersecting: true, intersectionRatio: 1 }]);
      vi.advanceTimersByTime(800);
      expect(primary.disabled).toBe(false);
      callback!([{ isIntersecting: false, intersectionRatio: 0 }]);
      expect(primary.disabled).toBe(true);
      callback!([{ isIntersecting: true, intersectionRatio: 1 }]);
      vi.advanceTimersByTime(800);
      // A prompt that isn't fixed-style confirms in the frame.
      pointerOnto(primary);
      primary.click();
      await expect(result).resolves.toBe("ok");
    });

    describe("a fixed-style prompt confirms in a window of its own", () => {
      const FIXED: PromptRequest = { ...HOLD, fixedStyle: true, confirmText: "loosen limits" };
      let opened: Array<Window & typeof globalThis> = [];
      let closed: number;
      const popup = () => {
        const w = new JSDOM("<!doctype html><html><head></head><body></body></html>", { pretendToBeVisual: true }).window as unknown as Window & typeof globalThis;
        installIntersectionObserver(w, "geometry");
        // As a browser's: `closed` once closed (by the user or the frame).
        let gone = false;
        Object.defineProperty(w, "closed", { get: () => gone });
        w.close = () => {
          if (!gone) closed++;
          gone = true;
        };
        opened.push(w);
        return w;
      };
      beforeEach(() => {
        installIntersectionObserver(window, "geometry");
        opened = [];
        closed = 0;
      });
      const frame = (o: { openWindow?: () => Window | null; trusted?: boolean } = {}) => {
        const root = document.createElement("div");
        document.body.append(root);
        const ui = new PromptUi(document, root, () => {}, {
          armMs: 800,
          holdMs: 800,
          ...(o.trusted === false ? {} : { isTrusted: () => true }),
          openWindow: o.openWindow ?? popup,
          timersFor: () => globalThis,
        });
        return { root, ui, primary: root.querySelector<HTMLButtonElement>(".ks-primary")!, status: root.querySelector<HTMLElement>(".ks-status")! };
      };
      /** The pointer's movement and press on `el`, made in `el`'s own window. */
      const pressIn = (w: Window & typeof globalThis, el: HTMLElement) => {
        const at = (x: number) => ({ bubbles: true, isPrimary: true, pointerType: "mouse", screenX: x, screenY: 20, clientX: x, clientY: 20 });
        el.dispatchEvent(new w.PointerEvent("pointerover", at(10)));
        el.dispatchEvent(new w.PointerEvent("pointermove", at(12)));
        el.dispatchEvent(new w.PointerEvent("pointermove", at(14)));
        el.dispatchEvent(new w.PointerEvent("pointerdown", { ...at(14), button: 0 }));
      };
      const typeIn = (w: Window & typeof globalThis, text: string) => {
        const input = w.document.querySelector<HTMLInputElement>(".ks-code-input")!;
        input.value = text;
        input.dispatchEvent(new w.Event("input", { bubbles: true }));
      };
      const open = (f: ReturnType<typeof frame>) => {
        pointerOnto(f.primary);
        vi.advanceTimersByTime(800);
        pointerOnto(f.primary);
        f.primary.click();
      };

      it("opens it from the user's click, shows the same prompt there and confirms it once its words are typed", async () => {
        const f = frame();
        const action = vi.fn(async () => "done");
        const result = f.ui.run(FIXED, action, () => ({ retry: false }));
        // In the frame: no code and no hold; its button only opens the window.
        expect(f.primary.textContent).toBe("Open the confirmation window");
        expect(f.primary.classList.contains("ks-hold")).toBe(false);
        expect(f.root.querySelector<HTMLElement>(".ks-code")!.hidden).toBe(true);
        expect(f.status.textContent).toBe("This browser confirms this in a separate Kokoah signer window.");
        expect(opened).toHaveLength(0);
        open(f);
        expect(opened).toHaveLength(1);
        expect(f.status.textContent).toBe("Confirm in the Kokoah signer window that opened.");
        const w = opened[0]!;
        const doc = w.document;
        expect(doc.title).toBe("Kokoah signer: confirm");
        expect(doc.querySelector(".ks-title")!.textContent).toBe(FIXED.title);
        expect(doc.querySelector(".ks-body")!.textContent).toBe(FIXED.body);
        expect(doc.querySelector(".ks-code-value")!.textContent).toBe("loosen limits");
        const there = doc.querySelector<HTMLButtonElement>(".ks-primary")!;
        expect(there.textContent).toBe(FIXED.actionLabel);
        expect(there.classList.contains("ks-hold")).toBe(true);
        // Armed in time, but nothing works before the words are typed.
        vi.advanceTimersByTime(5_000);
        expect(there.disabled).toBe(true);
        pressIn(w, there);
        vi.advanceTimersByTime(2_000);
        expect(action).not.toHaveBeenCalled();
        typeIn(w, "loosen");
        expect(there.disabled).toBe(true);
        // Case, spaces and punctuation don't matter.
        typeIn(w, " Loosen   LIMITS! ");
        expect(there.disabled).toBe(false);
        pressIn(w, there);
        vi.advanceTimersByTime(800);
        await expect(result).resolves.toBe("done");
        expect(action).toHaveBeenCalledOnce();
        // The window is closed once it is done, and the frame's prompt is gone.
        expect(closed).toBe(1);
        expect(f.root.querySelector<HTMLElement>(".ks-prompt")!.hidden).toBe(true);
      });

      it("types the action label when the prompt names no words", async () => {
        const f = frame();
        const { confirmText: _words, ...noWords } = FIXED;
        void f.ui.run(noWords, async () => "ok", () => ({ retry: false })).catch(() => {});
        open(f);
        expect(opened[0]!.document.querySelector(".ks-code-value")!.textContent).toBe("Loosen limits");
      });

      it("says so when the browser blocks the window, and opens it once the user tries again", async () => {
        let blocked = true;
        const f = frame({ openWindow: () => (blocked ? null : popup()) });
        const result = f.ui.run(FIXED, async () => "ok", () => ({ retry: false }));
        open(f);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.status.textContent).toContain("blocked the confirmation window");
        expect(f.root.querySelector<HTMLElement>(".ks-prompt")!.hidden).toBe(false);
        blocked = false;
        pointerOnto(f.primary);
        f.primary.click();
        expect(opened).toHaveLength(1);
        f.ui.run(REQ, async () => "x", () => ({ retry: false })).catch((e: unknown) => expect(e).toMatchObject({ code: "PROMPT_BUSY" }));
        opened[0]!.document.querySelector<HTMLButtonElement>(".ks-secondary")!.click();
        await expect(result).rejects.toMatchObject({ code: "USER_CANCELLED", kind: "limits" });
      });

      it("lets the frame's prompt open it again after the user closed it, and closes it when the frame's prompt ends", async () => {
        const f = frame();
        const result = f.ui.run({ ...FIXED, timeoutMs: 20_000 }, async () => "ok", () => ({ retry: false }));
        open(f);
        opened[0]!.close();
        await vi.advanceTimersByTimeAsync(600);
        expect(f.status.textContent).toContain("was closed");
        expect(f.root.querySelector<HTMLElement>(".ks-prompt")!.hidden).toBe(false);
        pointerOnto(f.primary);
        f.primary.click();
        expect(opened).toHaveLength(2);
        // The frame's prompt times out: its window goes with it.
        const timedOut = expect(result).rejects.toMatchObject({ code: "USER_TIMEOUT" });
        await vi.advanceTimersByTimeAsync(20_000);
        await timedOut;
        expect(closed).toBe(2);
        expect(opened[1]!.closed).toBe(true);
      });

      it("ignores what a script types there, and doesn't open a window for a click a script made", () => {
        const f = frame({ trusted: false });
        void f.ui.run(FIXED, async () => "ok", () => ({ retry: false })).catch(() => {});
        open(f);
        expect(opened).toHaveLength(0);
      });

      it("asks nothing on prompts that aren't fixed-style, and confirms in the frame where the browser can tell", async () => {
        const plain = frame();
        const r1 = plain.ui.run(REQ, async () => "ok", () => ({ retry: false }));
        open(plain);
        await expect(r1).resolves.toBe("ok");
        expect(opened).toHaveLength(0);
        installIntersectionObserver(window, "occlusion");
        const chromium = frame();
        const r2 = chromium.ui.run({ ...FIXED, hold: false }, async () => "ok", () => ({ retry: false }));
        expect(chromium.root.querySelector<HTMLElement>(".ks-code")!.hidden).toBe(true);
        open(chromium);
        await expect(r2).resolves.toBe("ok");
        expect(opened).toHaveLength(0);
      });

      it("compares the words without case, spaces or punctuation but the decimal point", () => {
        expect(confirmTextKey(" Deposit 1,000.5 USDC ")).toBe("deposit1000.5usdc");
        expect(confirmTextKey("remove $250.5")).toBe("remove250.5");
        expect(confirmTextKey("Buy 0.1 BTC")).toBe(confirmTextKey("buy 0.1 btc"));
        expect(confirmTextKey("buy 0.1 btc")).not.toBe(confirmTextKey("buy 1 btc"));
      });
    });
  });

  it("scrolls back and starts over when the parent moves the frame to a fragment", async () => {
    const { ui, primary } = setup();
    const action = vi.fn(async () => "ok");
    const result = ui.run(REQ, action, () => ({ retry: false }));
    // The pointer is in the frame from the start (a mouse first seen later waits the arming time there; see below).
    move(primary, 9);
    vi.advanceTimersByTime(800);
    expect(primary.disabled).toBe(false);
    document.documentElement.scrollTop = 120;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(document.documentElement.scrollTop).toBe(0);
    expect(primary.disabled).toBe(true);
    vi.advanceTimersByTime(800);
    move(primary, 10);
    move(primary, 11);
    primary.click();
    await expect(result).resolves.toBe("ok");
  });

  describe("the prompt's text shown whole", () => {
    /** Makes the prompt's text `scroll` px tall in a box of `client` px (jsdom lays nothing out). */
    const size = (root: HTMLElement, scroll: number, client: number) => {
      const body = root.querySelector<HTMLElement>(".ks-body")!;
      Object.defineProperty(body, "scrollHeight", { configurable: true, get: () => scroll });
      Object.defineProperty(body, "clientHeight", { configurable: true, get: () => client });
      return body;
    };
    afterEach(() => {
      // jsdom's window is 1024 × 768.
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
    });

    it("doesn't arm while part of the text is scrolled out of view, until the user scrolls it to its end", async () => {
      const { root, ui, primary, status } = setup();
      const body = size(root, 500, 150);
      const action = vi.fn(async () => "ok");
      const result = ui.run(HOLD, action, () => ({ retry: false }));
      move(primary, 9);
      vi.advanceTimersByTime(5_000);
      expect(primary.disabled).toBe(true);
      expect(status.textContent).toBe("Scroll to the end of the text above to confirm.");
      // Halfway is not the end.
      body.scrollTop = 200;
      body.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(800);
      expect(primary.disabled).toBe(true);
      body.scrollTop = 350;
      body.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(799);
      expect(primary.disabled).toBe(true);
      vi.advanceTimersByTime(1);
      expect(primary.disabled).toBe(false);
      expect(status.textContent).toBe("Press and hold the button to confirm.");
      move(primary, 10);
      move(primary, 11);
      primary.dispatchEvent(new PointerEvent("pointerdown", { ...at(11), button: 0 }));
      vi.advanceTimersByTime(800);
      await expect(result).resolves.toBe("ok");
    });

    it("arms at once when the text fits, and never in a frame too small to show it", () => {
      const fits = setup();
      size(fits.root, 200, 200);
      void fits.ui.run(REQ, async () => "ok", () => ({ retry: false })).catch(() => {});
      vi.advanceTimersByTime(800);
      expect(fits.primary.disabled).toBe(false);
      document.body.replaceChildren();

      // Two lines in view: scrolling through them doesn't count.
      const tiny = setup();
      const body = size(tiny.root, 500, 44);
      void tiny.ui.run(REQ, async () => "ok", () => ({ retry: false })).catch(() => {});
      body.scrollTop = 456;
      body.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(5_000);
      expect(tiny.primary.disabled).toBe(true);
      expect(tiny.status.textContent).toBe("This window is too small to show the whole prompt. Make it larger to confirm.");
      document.body.replaceChildren();

      // A window under 280 × 300, whatever its text.
      const narrow = setup();
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 200 });
      void narrow.ui.run(REQ, async () => "ok", () => ({ retry: false })).catch(() => {});
      vi.advanceTimersByTime(5_000);
      expect(narrow.primary.disabled).toBe(true);
      expect(narrow.status.textContent).toContain("too small");
      // Made larger (the frame is resized): it arms.
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(800);
      expect(narrow.primary.disabled).toBe(false);
    });

    it("checks again when it is confirmed", async () => {
      const { root, ui, primary } = setup();
      size(root, 200, 200);
      const action = vi.fn(async () => "ok");
      void ui.run(REQ, action, () => ({ retry: false })).catch(() => {});
      move(primary, 9);
      vi.advanceTimersByTime(800);
      move(primary, 10);
      size(root, 500, 200);
      primary.click();
      expect(action).not.toHaveBeenCalled();
      expect(primary.disabled).toBe(true);
    });
  });

  describe("the prompt moving under the pointer", () => {
    it("starts over when the frame moves under the pointer", async () => {
      const { ui, primary } = setup();
      const action = vi.fn(async () => "ok");
      const result = ui.run(REQ, action, () => ({ retry: false }));
      move(primary, 9);
      vi.advanceTimersByTime(800);
      move(primary, 10);
      // A small difference between the two (rounding at a low zoom) is no move.
      primary.dispatchEvent(new PointerEvent("pointermove", { ...at(10), clientX: 13 }));
      expect(primary.disabled).toBe(false);
      // The pointer stays put on the screen while its place in the frame jumps: the frame moved.
      primary.dispatchEvent(new PointerEvent("pointermove", { ...at(10), clientX: 60 }));
      expect(primary.disabled).toBe(true);
      primary.click();
      expect(action).not.toHaveBeenCalled();
      // Its movement counts again only once the delay passed again.
      vi.advanceTimersByTime(799);
      primary.dispatchEvent(new PointerEvent("pointermove", { ...at(11), clientX: 61 }));
      primary.click();
      expect(action).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      primary.dispatchEvent(new PointerEvent("pointermove", { ...at(12), clientX: 62 }));
      primary.click();
      await expect(result).resolves.toBe("ok");
    });

    it("counts a mouse it sees for the first time only after the delay, but a touch's press at once", async () => {
      const { ui, primary } = setup();
      const action = vi.fn(async () => "ok");
      const result = ui.run(REQ, action, () => ({ retry: false }));
      vi.advanceTimersByTime(800);
      // First seen once armed: it may have arrived by the frame moving under it.
      pointerOnto(primary);
      primary.click();
      expect(action).not.toHaveBeenCalled();
      vi.advanceTimersByTime(800);
      move(primary, 15);
      primary.click();
      await expect(result).resolves.toBe("ok");

      const touch = setup();
      const tapped = vi.fn(async () => "ok");
      const tapResult = touch.ui.run(REQ, tapped, () => ({ retry: false }));
      vi.advanceTimersByTime(800);
      touch.primary.dispatchEvent(new PointerEvent("pointerdown", { ...at(10, 20, "touch"), button: 0 }));
      touch.primary.click();
      await expect(tapResult).resolves.toBe("ok");
    });
  });
  describe("the pointer leaving the frame", () => {
    it("forgets where the pointer was once it leaves, so the next entry waits the delay again", async () => {
      const { ui, primary } = setup();
      const action = vi.fn(async () => "ok");
      const result = ui.run(REQ, action, () => ({ retry: false }));
      move(primary, 9);
      vi.advanceTimersByTime(800);
      // Out of the frame's document; the parent moves the frame so the button meets the pointer, which comes back.
      document.dispatchEvent(new PointerEvent("pointerout", { ...at(10), relatedTarget: null }));
      primary.dispatchEvent(new PointerEvent("pointerover", { ...at(300), clientX: 20 }));
      move(primary, 301);
      primary.click();
      expect(action).not.toHaveBeenCalled();
      vi.advanceTimersByTime(800);
      move(primary, 302);
      primary.click();
      await expect(result).resolves.toBe("ok");
    });

    it("starts over when a mouse's move on screen and in the frame differ by much more than the zoom explains", () => {
      const { ui, primary } = setup();
      void ui.run(REQ, async () => "ok", () => ({ retry: false })).catch(() => {});
      move(primary, 9);
      vi.advanceTimersByTime(800);
      // 20 px on screen, 20 in the frame: the zoom is 1.
      primary.dispatchEvent(new PointerEvent("pointermove", { ...at(29), clientX: 29 }));
      expect(primary.disabled).toBe(false);
      // 20 px on screen but 50 in the frame, the same way: the frame moved against the pointer.
      primary.dispatchEvent(new PointerEvent("pointermove", { ...at(49), clientX: 79 }));
      expect(primary.disabled).toBe(true);
    });
  });
});

describe("the prompt's size (promptSize) and look", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    document.documentElement.className = "";
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  });

  /**
   * A prompt UI whose events (`size …`, `shown …`) are recorded in order. jsdom lays nothing out: the root's padding
   * is 24 px, the panels are `panel` px tall and the prompt's text `text.scroll` px in a box of `text.client`.
   */
  function sized() {
    const root = document.createElement("div");
    root.style.padding = "24px";
    document.body.append(root);
    const log: string[] = [];
    const ui = new PromptUi(document, root, (visible, kind) => log.push(`shown ${visible} ${kind}`), { armMs: 0, isTrusted: () => true, onSize: (h) => log.push(`size ${h}`) });
    const layout = { panel: 250, scroll: 40, client: 40 };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const height = /ks-prompt|ks-notice/.test(this.className) ? layout.panel : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: height, width: 300, height, toJSON: () => ({}) };
    });
    const body = root.querySelector<HTMLElement>(".ks-body")!;
    Object.defineProperty(body, "scrollHeight", { configurable: true, get: () => layout.scroll });
    Object.defineProperty(body, "clientHeight", { configurable: true, get: () => layout.client });
    const resize = (width = window.innerWidth) => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      window.dispatchEvent(new Event("resize"));
    };
    const cancel = () => root.querySelector<HTMLButtonElement>(".ks-secondary")!.click();
    return { root, ui, log, layout, resize, cancel };
  }

  it("reports the natural height before it says the prompt is shown, at least the least height a prompt arms in", () => {
    const { ui, log, layout, cancel } = sized();
    void ui.run(REQ, async () => "ok", () => ({ retry: false })).catch(() => {});
    // 24 + 250 + 24 = 298: the frame asks for the 300 px a prompt needs to arm.
    expect(log).toEqual(["size 300", "shown true passkey-unlock"]);
    cancel();
    layout.panel = 400;
    void ui.run(HOLD, async () => "ok", () => ({ retry: false })).catch(() => {});
    expect(log.slice(-2)).toEqual(["size 448", "shown true limits"]);
  });

  it("counts the text scrolled out of view whole, and stays within the protocol's bounds", () => {
    const { ui, log, layout, cancel } = sized();
    layout.panel = 500;
    layout.scroll = 900;
    layout.client = 300;
    void ui.run(HOLD, async () => "ok", () => ({ retry: false })).catch(() => {});
    expect(log[0]).toBe("size 1148");
    cancel();
    layout.panel = 5_000;
    void ui.run(HOLD, async () => "ok", () => ({ retry: false })).catch(() => {});
    expect(log.at(-2)).toBe(`size ${PROMPT_SIZE_MAX_PX}`);
  });

  it("never shrinks within one prompt at one width, starts again at another width and for the next prompt", () => {
    const { ui, log, layout, resize, cancel } = sized();
    layout.panel = 400;
    void ui.run(HOLD, async () => "ok", () => ({ retry: false })).catch(() => {});
    layout.panel = 430; // a status line that wrapped
    resize();
    layout.panel = 400; // and its shorter text again: the frame doesn't resize (and start the prompt over) for it
    resize();
    expect(log.filter((l) => l.startsWith("size"))).toEqual(["size 448", "size 478"]);
    resize(700);
    expect(log.at(-1)).toBe("size 448");
    cancel();
    layout.panel = 300;
    void ui.run(REQ, async () => "ok", () => ({ retry: false })).catch(() => {});
    expect(log.slice(-2)).toEqual(["size 348", "shown true passkey-unlock"]);
  });

  it("reports nothing while the frame isn't laid out (a hidden iframe), then once it is", () => {
    const { ui, log, layout, resize } = sized();
    layout.panel = 0;
    void ui.run(REQ, async () => "ok", () => ({ retry: false })).catch(() => {});
    expect(log).toEqual(["shown true passkey-unlock"]);
    layout.panel = 320;
    resize();
    expect(log).toEqual(["shown true passkey-unlock", "size 368"]);
  });

  it("reports the agent approval notice's height too, and the frame's own fixed look for it and for fixed-style prompts", () => {
    const { ui, log, layout, cancel } = sized();
    const fixed = () => document.documentElement.classList.contains("ks-fixed-look");
    void ui.run(REQ, async () => "ok", () => ({ retry: false })).catch(() => {});
    expect(fixed()).toBe(false);
    cancel();
    void ui.run({ ...HOLD, fixedStyle: true }, async () => "ok", () => ({ retry: false })).catch(() => {});
    expect(fixed()).toBe(true);
    cancel();
    expect(fixed()).toBe(false);
    layout.panel = 280;
    const end = ui.showNotice({ kind: "agent-approval", title: "Check the key", body: "Compare it.", lines: ["0xabc"], closeLabel: "Hide", timeoutMs: 60_000 });
    expect(log.slice(-2)).toEqual(["size 328", "shown true agent-approval"]);
    expect(fixed()).toBe(true);
    end();
    expect(fixed()).toBe(false);
  });

  it("draws its icon with DOM calls (no HTML parsing), hidden from screen readers: a lock, a key, or a caution sign", () => {
    const { root, ui, cancel } = sized();
    const shape = () => {
      const svg = root.querySelector(".ks-icon svg");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      return svg?.querySelector("path")?.getAttribute("d")?.slice(0, 12);
    };
    void ui.run(REQ, async () => "ok", () => ({ retry: false })).catch(() => {});
    expect(shape()).toBe("M7 11V7a5 5 ");
    cancel();
    void ui.run({ ...REQ, kind: "passkey-create" }, async () => "ok", () => ({ retry: false })).catch(() => {});
    expect(shape()).toBe("M2.586 17.41");
    cancel();
    void ui.run({ ...REQ, fixedStyle: true }, async () => "ok", () => ({ retry: false })).catch(() => {});
    expect(shape()).toBe("m21.73 18-8-");
    expect(root.querySelectorAll(".ks-icon svg")).toHaveLength(1);
  });
});

/**
 * The in-frame prompt's guard against a hostile parent page (prompt.ts): the primary button works only after the prompt
 * has been shown for the arming delay and, where the browser reports occlusion (IntersectionObserver v2), only while
 * the whole prompt is visible; a click counts only after the user's own pointer moved over the armed button; the
 * keyboard confirms only after the user's own Tab onto it and Enter or Space held; resizing, focus loss and hiding
 * start over; hold prompts need the button held; focus starts on Cancel.
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

    it("asks for no code: the browser tells whether the prompt is seen", () => {
      const { ui, root } = setup();
      void ui.run({ ...HOLD, fixedStyle: true }, async () => "ok", () => ({ retry: false })).catch(() => {});
      expect(root.querySelector<HTMLElement>(".ks-code")!.hidden).toBe(true);
    });
  });

  describe("a code to type where the browser can't tell whether the prompt is seen", () => {
    const FIXED: PromptRequest = { ...HOLD, fixedStyle: true };
    const codeOf = (root: HTMLElement) => root.querySelector(".ks-code-value")!.textContent!;
    const type = (root: HTMLElement, text: string) => {
      const input = root.querySelector<HTMLInputElement>(".ks-code-input")!;
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const digits = (...codes: string[]) => {
      const queue = [...codes];
      return () => queue.shift() ?? "999";
    };

    it("shows a random code on fixed-style prompts and keeps the button off until it is typed", async () => {
      const root = document.createElement("div");
      document.body.append(root);
      const ui = new PromptUi(document, root, () => {}, { armMs: 800, holdMs: 800, isTrusted: () => true, randomDigits: digits("482") });
      const primary = root.querySelector<HTMLButtonElement>(".ks-primary")!;
      const action = vi.fn(async () => "ok");
      const result = ui.run(FIXED, action, () => ({ retry: false }));
      expect(root.querySelector<HTMLElement>(".ks-code")!.hidden).toBe(false);
      expect(codeOf(root)).toBe("482");
      expect(document.activeElement).toBe(root.querySelector(".ks-code-input"));
      expect(root.querySelector(".ks-status")!.textContent).toBe("Type the code shown above first.");
      vi.advanceTimersByTime(5_000);
      // A decoy's "hold to confirm": armed in time, but without the code nothing works.
      expect(primary.disabled).toBe(true);
      pointerOnto(primary);
      vi.advanceTimersByTime(2_000);
      expect(action).not.toHaveBeenCalled();
      type(root, "48");
      expect(primary.disabled).toBe(true);
      type(root, "482");
      expect(primary.disabled).toBe(false);
      pointerOnto(primary);
      vi.advanceTimersByTime(800);
      await expect(result).resolves.toBe("ok");
      expect(root.querySelector<HTMLElement>(".ks-code")!.hidden).toBe(true);
    });

    it("shows a new code after a wrong one, and gives up after three", async () => {
      const root = document.createElement("div");
      document.body.append(root);
      const ui = new PromptUi(document, root, () => {}, { armMs: 0, holdMs: 0, isTrusted: () => true, randomDigits: digits("111", "222", "333") });
      const result = ui.run(FIXED, async () => "ok", () => ({ retry: false }));
      type(root, "123");
      expect(codeOf(root)).toBe("222");
      expect(root.querySelector(".ks-status")!.textContent).toContain("not the code shown");
      // The old code no longer works.
      type(root, "111");
      expect(codeOf(root)).toBe("333");
      type(root, "000");
      await expect(result).rejects.toMatchObject({ code: "USER_CANCELLED", kind: "limits" });
    });

    it("ignores what a script types, and asks nothing on prompts that aren't fixed-style", () => {
      const root = document.createElement("div");
      document.body.append(root);
      const ui = new PromptUi(document, root, () => {}, { armMs: 0, holdMs: 0, isTrusted: () => false, randomDigits: digits("482") });
      const primary = root.querySelector<HTMLButtonElement>(".ks-primary")!;
      void ui.run(FIXED, async () => "ok", () => ({ retry: false })).catch(() => {});
      vi.advanceTimersByTime(0);
      type(root, "482");
      expect(primary.disabled).toBe(true);
      document.body.replaceChildren();
      const plain = setup({ armMs: 0 });
      void plain.ui.run(REQ, async () => "ok", () => ({ retry: false })).catch(() => {});
      expect(plain.root.querySelector<HTMLElement>(".ks-code")!.hidden).toBe(true);
    });

    it("draws its digits from crypto.getRandomValues by default", () => {
      const { ui, root } = setup();
      void ui.run(FIXED, async () => "ok", () => ({ retry: false })).catch(() => {});
      expect(codeOf(root)).toMatch(/^\d{3}$/);
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
});

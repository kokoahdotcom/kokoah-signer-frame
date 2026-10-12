/**
 * The in-frame prompt's guard against a hostile parent page (prompt.ts `arm`): the primary button works only after the
 * prompt has been shown for the arming delay, and, where the browser reports occlusion (IntersectionObserver v2), only
 * while the whole prompt is visible; focus starts on Cancel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptUi, PromptError, type PromptRequest } from "../src/frame/prompt.js";

const REQ: PromptRequest = {
  kind: "limits",
  title: "Loosen your limits?",
  body: "Max order $1,000,000",
  actionLabel: "Allow",
  cancelLabel: "Cancel",
  timeoutMs: 60_000,
};

function setup(armMs = 800) {
  const root = document.createElement("div");
  document.body.append(root);
  const ui = new PromptUi(document, root, () => {}, armMs);
  const primary = root.querySelector<HTMLButtonElement>(".ks-primary")!;
  const cancel = root.querySelector<HTMLButtonElement>(".ks-secondary")!;
  return { root, ui, primary, cancel };
}

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
    primary.onclick?.(new PointerEvent("click"));
    vi.advanceTimersByTime(799);
    primary.onclick?.(new PointerEvent("click"));
    expect(action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(primary.disabled).toBe(false);
    primary.click();
    await expect(result).resolves.toBe("ok");
    expect(action).toHaveBeenCalledOnce();
  });

  it("ends the prompt from Cancel, where focus starts", async () => {
    const { ui, cancel } = setup();
    const result = ui.run(REQ, async () => "ok", () => ({ retry: false }));
    cancel.click();
    await expect(result).rejects.toBeInstanceOf(PromptError);
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
      callback!([{ isVisible: false }]);
      expect(primary.disabled).toBe(true);
      primary.onclick?.(new PointerEvent("click"));
      expect(action).not.toHaveBeenCalled();
      callback!([{ isVisible: true }]);
      vi.advanceTimersByTime(800);
      primary.click();
      await expect(result).resolves.toBe("ok");
      expect(callback).toBeUndefined();
    });
  });
});

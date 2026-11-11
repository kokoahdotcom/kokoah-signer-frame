/**
 * jsdom has no IntersectionObserver. These fakes report every element they observe as wholly in view, at once (inside
 * `observe`): `occlusion` is IntersectionObserver v2 (Chromium: `isVisible` too), `geometry` v1 only (Firefox, Safari),
 * and `none` removes it.
 */
export type VisibilityMode = "occlusion" | "geometry" | "none";

type Win = Window & { IntersectionObserver?: unknown; IntersectionObserverEntry?: unknown };

export function installIntersectionObserver(win: Window, mode: VisibilityMode): void {
  const w = win as Win;
  if (mode === "none") {
    delete w.IntersectionObserver;
    delete w.IntersectionObserverEntry;
    return;
  }
  class FakeEntry {}
  if (mode === "occlusion") Object.defineProperty(FakeEntry.prototype, "isVisible", { value: false });
  class FakeObserver {
    private readonly cb: (entries: unknown[]) => void;
    constructor(cb: (entries: unknown[]) => void) {
      this.cb = cb;
    }
    observe(target: Element) {
      this.cb([{ target, isIntersecting: true, intersectionRatio: 1, ...(mode === "occlusion" ? { isVisible: true } : {}) }]);
    }
    unobserve() {}
    disconnect() {}
  }
  Object.assign(w, { IntersectionObserver: FakeObserver, IntersectionObserverEntry: FakeEntry });
}

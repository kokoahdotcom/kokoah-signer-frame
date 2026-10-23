/**
 * The frame's tiny in-frame UI: an idle status line and a prompt (short text, a primary button, a cancel button) used
 * when the user must act inside the frame (WebAuthn needs a click in the frame's own document; an HLP deposit, a
 * loosening of the user's limits and large orders need the user's own confirmation of the frame's own description of
 * them).
 *
 * The DOM is built with `createElement` and `textContent` only: the frame's CSP has `trusted-types 'none'`, so any
 * HTML sink (`innerHTML`, …) would throw. Styling comes from `frame.css` and CSS custom properties that the parent
 * may set through `setTheme` (validated here).
 *
 * @module
 */
import { THEME_VARIABLES, type SetThemeParams, type ThemeVariable } from "../protocol/index.js";

/**
 * `vault-deposit`: the user confirms an HLP deposit inside the frame before the trading key signs it, `vault-withdraw`
 * a vault withdrawal. `limits`: the user confirms a `setLimits` that loosens their stored limits. `order`: the user
 * confirms orders above `CONFIRM_ORDERS_ABOVE_USD`, or past `CONFIRM_UNPROMPTED_ABOVE_USD` signed without a prompt
 * lately (policy.ts), before they are signed. `margin`: the user confirms taking margin out of an isolated position.
 * `key-remove`: the user confirms deleting a passkey-protected key, or replacing it with one that unlocks without it.
 * `agent-approval`: not a prompt but a notice ({@link PromptUi.showNotice}): the new key's address while the main
 * wallet approves it.
 */
export type PromptKind = "passkey-create" | "passkey-unlock" | "vault-deposit" | "vault-withdraw" | "limits" | "order" | "margin" | "key-remove" | "agent-approval";

export interface PromptRequest {
  kind: PromptKind;
  title: string;
  body: string;
  actionLabel: string;
  cancelLabel: string;
  timeoutMs: number;
  /**
   * Shown in the frame's own fixed colors and size, whatever the parent's `setTheme` set: for a step that weakens the
   * key's protection, so the parent can't hide or disguise what the user is agreeing to. Where the browser can't tell
   * whether the prompt is seen (no IntersectionObserver v2), such a prompt also asks for a code it shows.
   */
  fixedStyle?: boolean;
  /**
   * Confirmed by pressing and holding the primary button (`holdMs`, with a filling bar) instead of a click: for a step
   * that moves money or loosens the user's protection, so a click the parent lured onto the button isn't enough.
   */
  hold?: boolean;
}

/**
 * A panel that needs no action (`PromptUi.showNotice`): shown in the frame's own fixed look while no prompt is open, a
 * prompt takes its place until it closes. `lines` are shown one per line in a monospace font (an address, a code).
 */
export interface NoticeRequest {
  kind: PromptKind;
  title: string;
  body: string;
  lines: string[];
  closeLabel: string;
  timeoutMs: number;
}

interface NoticeEntry {
  kind: PromptKind;
  timer: ReturnType<typeof setTimeout>;
}

/** Why a prompt ended without success. `kind`: the prompt's. */
export class PromptError extends Error {
  readonly code: "USER_CANCELLED" | "USER_TIMEOUT" | "PROMPT_BUSY";
  readonly kind: PromptKind;
  constructor(code: PromptError["code"], message: string, kind: PromptKind) {
    super(message);
    this.name = "PromptError";
    this.code = code;
    this.kind = kind;
  }
}

/** What to do when the action fails: show `message` and let the user retry, or give up with the error. */
export type ActionFailure = { retry: true; message: string } | { retry: false };

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * How long the prompt must have been shown, and seen whole and unobscured where the browser can tell, before its
 * primary button works. The parent page learns the moment a prompt opens (`promptChanged`, so it can make room for
 * it); without this, a hostile page could time a click or a key press onto a prompt the user never saw, or cover it.
 */
export const PROMPT_ARM_MS = 800;

/** How long the primary button of a `hold` prompt must be pressed, and Enter or Space held on any prompt's. */
export const PROMPT_HOLD_MS = 800;

const HOLD_HINT = "Press and hold the button to confirm.";
const KEY_HINT = "Press and hold Enter or Space to confirm.";
const CODE_HINT = "Type the code shown above first.";
const CODE_MISS = "That is not the code shown. A new code is shown: type it to confirm.";

/** Digits of the code a fixed-style prompt asks for where the browser can't tell whether the prompt is seen. */
export const PROMPT_CODE_DIGITS = 3;
/** Wrong codes typed before the prompt gives up (USER_CANCELLED). */
export const PROMPT_CODE_ATTEMPTS = 3;
/**
 * How much of the prompt must be in view, where the browser reports it (IntersectionObserver), before it arms: all of
 * it, give or take rounding. A parent that clips part of it (the order lines) leaves it disarmed.
 */
export const PROMPT_FULL_INTERSECTION = 0.995;

type VisibilityEntry = IntersectionObserverEntry & { isVisible?: boolean };

/** Timing of the prompt and, for tests (jsdom can't make trusted events), which input events count as the user's. */
export interface PromptUiOptions {
  armMs?: number;
  holdMs?: number;
  /** Default `ev.isTrusted`: events a script dispatches never confirm. */
  isTrusted?: (ev: Event) => boolean;
  /** Test seam: the confirmation code's digits (default `crypto.getRandomValues`). */
  randomDigits?: (count: number) => string;
}

function randomDigits(doc: Document, count: number): string {
  const crypto = doc.defaultView?.crypto;
  if (!crypto) throw new Error("No crypto.getRandomValues for the prompt's code");
  const bytes = new Uint32Array(count);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => String(b % 10)).join("");
}

/**
 * The primary button works only for the user's own pointer or keyboard on the frame's own document:
 * - it is armed once the prompt has been shown for `armMs` (and, where the browser reports occlusion, seen; see
 *   {@link PromptUi.arm}); resizing the frame, the frame losing focus or the page being hidden starts that over;
 * - then a click (or, for a `hold` prompt, a press) counts only after real, trusted pointer movement over the armed
 *   button (screen coordinates that change); for a pointer that can't hover (touch, most pens) the press itself;
 *   leaving the button needs new movement. A pointer that was already resting where the button appeared doesn't count;
 * - a `hold` prompt confirms only after the button stayed pressed for `holdMs` with the pointer on it;
 * - from the keyboard, any prompt confirms only when the armed button got focus from the user's own Tab or Shift+Tab
 *   inside the frame (not a script's `focus()`, not focus that came from the parent page) and Enter or Space is then
 *   held for `holdMs` (a fresh press; auto-repeat keeps it going). A key press alone never clicks the button;
 * - where the browser can't tell whether the prompt is seen (no IntersectionObserver v2: Firefox, Safari, every iOS
 *   browser), a fixed-style prompt also shows a random code the user types first: a parent that hides the prompt under
 *   a decoy can't know it. A wrong code shows a new one; after {@link PROMPT_CODE_ATTEMPTS} wrong ones the prompt gives
 *   up (USER_CANCELLED). Where it can tell, the prompt must be wholly in view and unobscured;
 * - the parent moving the frame's document to a fragment (`#ks-body`) scrolls it back and starts over.
 */
export class PromptUi {
  private readonly onChange: (visible: boolean, kind: PromptKind | null) => void;
  private readonly armMs: number;
  private readonly holdMs: number;
  private readonly isTrusted: (ev: Event) => boolean;
  private readonly digits: (count: number) => string;
  private armed = false;
  /** The code the open prompt asks for (null: none asked), whether the user typed it, and wrong ones so far. */
  private code: string | null = null;
  private codeOk = false;
  private codeMisses = 0;
  private cancel: (() => void) | null = null;
  private armTimer: ReturnType<typeof setTimeout> | undefined;
  private observer: IntersectionObserver | null = null;
  /** The user's pointer moved over the armed primary button (or pressed it, for a pointer that can't hover). */
  private pointerSeen = false;
  private lastPointer: { x: number; y: number } | null = null;
  /** The armed primary button got focus from the user's own Tab or Shift+Tab inside the frame. */
  private keyboardFocus = false;
  /** A trusted Tab keydown whose focus move hasn't landed yet. */
  private tabbing = false;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  /** What is holding the button down while `holdTimer` runs. */
  private holdBy: "pointer" | "key" | null = null;
  /** The open prompt's: whether it confirms by holding, and what confirming does. */
  private hold = false;
  private confirm: (() => void) | null = null;
  private readonly idle: HTMLElement;
  private readonly idleText: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly codeBox: HTMLElement;
  private readonly codeValue: HTMLElement;
  private readonly codeInput: HTMLInputElement;
  private readonly primary: HTMLButtonElement;
  private readonly secondary: HTMLButtonElement;
  private readonly status: HTMLElement;
  private active: PromptKind | null = null;
  /** The notice shown while no prompt is open (see {@link PromptUi.showNotice}). */
  private notice: NoticeEntry | null = null;
  private readonly noticePanel: HTMLElement;
  private readonly noticeTitle: HTMLElement;
  private readonly noticeBody: HTMLElement;
  private readonly noticeLines: HTMLElement;
  private readonly noticeClose: HTMLButtonElement;

  constructor(doc: Document, root: HTMLElement, onChange: (visible: boolean, kind: PromptKind | null) => void, options: PromptUiOptions = {}) {
    this.onChange = onChange;
    this.armMs = options.armMs ?? PROMPT_ARM_MS;
    this.holdMs = options.holdMs ?? PROMPT_HOLD_MS;
    this.isTrusted = options.isTrusted ?? ((ev) => ev.isTrusted);
    this.digits = options.randomDigits ?? ((count) => randomDigits(doc, count));
    this.idle = el(doc, "section", "ks-idle");
    this.idle.setAttribute("aria-label", "Kokoah signer status");
    this.idleText = el(doc, "p", "ks-idle-text", "Kokoah signer");
    this.idle.append(this.idleText);

    this.panel = el(doc, "section", "ks-prompt");
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-modal", "true");
    this.panel.hidden = true;
    this.title = el(doc, "h1", "ks-title");
    this.title.id = "ks-title";
    this.body = el(doc, "p", "ks-body");
    this.body.id = "ks-body";
    this.panel.setAttribute("aria-labelledby", "ks-title");
    this.panel.setAttribute("aria-describedby", "ks-body");
    // The code to type where the browser can't tell whether the prompt is seen (see the class notes).
    this.codeBox = el(doc, "div", "ks-code");
    this.codeBox.hidden = true;
    const codeLabel = el(doc, "label", "ks-code-label");
    codeLabel.htmlFor = "ks-code-input";
    this.codeValue = el(doc, "strong", "ks-code-value");
    codeLabel.append("To confirm, type this code: ", this.codeValue);
    this.codeInput = el(doc, "input", "ks-code-input");
    this.codeInput.id = "ks-code-input";
    this.codeInput.type = "text";
    this.codeInput.inputMode = "numeric";
    this.codeInput.autocomplete = "off";
    this.codeInput.maxLength = PROMPT_CODE_DIGITS;
    this.codeInput.spellcheck = false;
    this.codeBox.append(codeLabel, this.codeInput);
    const actions = el(doc, "div", "ks-actions");
    this.primary = el(doc, "button", "ks-button ks-primary");
    this.primary.type = "button";
    // The bar of a hold fills in exactly the hold time (CSSOM, which style-src 'self' allows).
    this.primary.style.setProperty("--ks-hold-ms", `${this.holdMs}ms`);
    // Screen readers announce how to confirm from the keyboard when the button gets focus.
    const keyHint = el(doc, "span", "ks-sr-only", KEY_HINT);
    keyHint.id = "ks-key-hint";
    this.primary.setAttribute("aria-describedby", "ks-key-hint");
    this.secondary = el(doc, "button", "ks-button ks-secondary");
    this.secondary.type = "button";
    actions.append(this.primary, this.secondary);
    this.status = el(doc, "p", "ks-status");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.panel.append(this.title, this.body, this.codeBox, actions, keyHint, this.status);
    this.codeInput.addEventListener("input", (ev) => this.onCode(ev));

    // The notice: a region, not a dialog (it asks for nothing and never takes focus), always in the frame's own look.
    this.noticePanel = el(doc, "section", "ks-notice ks-notice--fixed");
    this.noticePanel.hidden = true;
    this.noticePanel.setAttribute("role", "region");
    this.noticePanel.setAttribute("aria-live", "polite");
    this.noticeTitle = el(doc, "h1", "ks-notice-title");
    this.noticeTitle.id = "ks-notice-title";
    this.noticePanel.setAttribute("aria-labelledby", "ks-notice-title");
    this.noticeBody = el(doc, "p", "ks-notice-body");
    this.noticeLines = el(doc, "div", "ks-notice-lines");
    this.noticeClose = el(doc, "button", "ks-button ks-secondary ks-notice-close");
    this.noticeClose.type = "button";
    this.noticeClose.addEventListener("click", (ev) => {
      if (this.isTrusted(ev)) this.endNotice();
    });
    this.noticePanel.append(this.noticeTitle, this.noticeBody, this.noticeLines, this.noticeClose);
    root.append(this.idle, this.panel, this.noticePanel);

    const button = this.primary;
    button.addEventListener("pointerover", (ev) => this.onPointer(ev, false));
    button.addEventListener("pointermove", (ev) => this.onPointer(ev, true));
    button.addEventListener("pointerdown", (ev) => this.onPress(ev));
    button.addEventListener("pointerup", () => this.releaseHold("pointer"));
    button.addEventListener("pointerleave", () => this.forgetPointer());
    button.addEventListener("pointercancel", () => this.forgetPointer());
    button.addEventListener("click", (ev) => this.onClick(ev));
    button.addEventListener("keydown", (ev) => this.onKey(ev, true));
    button.addEventListener("keyup", (ev) => this.onKey(ev, false));
    button.addEventListener("focus", () => this.onFocus());
    button.addEventListener("blur", () => this.forgetKeyboard());
    // The user's own Tab or Shift+Tab in the frame: the focus move it causes lands before any timer runs.
    doc.addEventListener(
      "keydown",
      (ev) => {
        if (ev.key !== "Tab" || !this.isTrusted(ev)) return;
        this.tabbing = true;
        setTimeout(() => (this.tabbing = false), 0);
      },
      true,
    );
    // A long press must not open the context menu (or a touch callout) instead of confirming.
    button.addEventListener("contextmenu", (ev) => {
      if (this.hold) ev.preventDefault();
    });
    // Moved out of view, resized by the parent, or the user went elsewhere: shown and seen again before it works.
    const win = doc.defaultView;
    win?.addEventListener("resize", () => this.rearm());
    win?.addEventListener("blur", () => this.rearm());
    doc.addEventListener("visibilitychange", () => this.rearm());
    // The parent can move the frame's document to a fragment (`#ks-body`) to scroll part of the prompt out of view.
    win?.addEventListener("hashchange", () => {
      this.scrollToTop();
      this.rearm();
    });
  }

  /**
   * Shows a notice (replacing any other) until the returned function ends it, the user hides it, or `timeoutMs` passes.
   * While a prompt is open the notice waits behind it; `onChange` reports whichever is shown. The notice takes no focus
   * and has no action but hiding it.
   */
  showNotice(req: NoticeRequest): () => void {
    this.endNotice();
    const doc = this.noticePanel.ownerDocument;
    this.noticeTitle.textContent = req.title;
    this.noticeBody.textContent = req.body;
    this.noticeLines.replaceChildren(...req.lines.map((line) => el(doc, "p", "ks-notice-line", line)));
    this.noticeClose.textContent = req.closeLabel;
    const entry: NoticeEntry = { kind: req.kind, timer: setTimeout(() => this.endNotice(entry), req.timeoutMs) };
    this.notice = entry;
    if (this.active === null) {
      this.idle.hidden = true;
      this.noticePanel.hidden = false;
      this.onChange(true, req.kind);
    }
    return () => this.endNotice(entry);
  }

  /** Ends the notice (only `entry`, when given). */
  private endNotice(entry?: NoticeEntry): void {
    const n = this.notice;
    if (n === null || (entry !== undefined && entry !== n)) return;
    clearTimeout(n.timer);
    this.notice = null;
    this.noticePanel.hidden = true;
    if (this.active === null) {
      this.idle.hidden = false;
      this.onChange(false, null);
    }
  }

  /** Updates the idle status line (network, key state). */
  setIdleText(text: string): void {
    this.idleText.textContent = text;
  }

  /**
   * Shows the prompt and resolves with `action()`'s result. `action` is called synchronously from the click handler
   * of the primary button, so it runs with the click's user activation (required by WebAuthn); for a `hold` prompt or
   * from the keyboard, when the hold completes (the press's activation still holds then).
   */
  run<T>(req: PromptRequest, action: () => Promise<T>, onFailure: (e: unknown) => ActionFailure): Promise<T> {
    if (this.active !== null) return Promise.reject(new PromptError("PROMPT_BUSY", "Another prompt is already waiting for the user.", req.kind));
    this.active = req.kind;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let running = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.confirm = null;
        this.cancel = null;
        this.secondary.onclick = null;
        this.panel.onkeydown = null;
        this.hide();
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new PromptError("USER_TIMEOUT", "The user did not respond in time.", req.kind))), req.timeoutMs);
      this.confirm = () => {
        if (settled || running || !this.armed || (this.code !== null && !this.codeOk)) return;
        running = true;
        this.setBusy(true, req.hold ? "Confirmed." : "Waiting for your passkey…");
        let p: Promise<T>;
        try {
          p = action();
        } catch (e) {
          p = Promise.reject(e);
        }
        p.then(
          (value) => finish(() => resolve(value)),
          (e: unknown) => {
            running = false;
            const f = onFailure(e);
            if (f.retry && !settled) {
              this.setBusy(false, f.message);
              this.primary.focus();
            } else finish(() => reject(e));
          },
        );
      };
      this.secondary.onclick = () => {
        if (!running) finish(() => reject(new PromptError("USER_CANCELLED", "The user cancelled.", req.kind)));
      };
      this.cancel = () => finish(() => reject(new PromptError("USER_CANCELLED", "The user typed a wrong code too often.", req.kind)));
      this.panel.onkeydown = (ev: KeyboardEvent) => {
        if (ev.key === "Escape" && !running) finish(() => reject(new PromptError("USER_CANCELLED", "The user cancelled.", req.kind)));
      };
      this.show(req);
    });
  }

  private show(req: PromptRequest): void {
    this.hold = req.hold === true;
    this.panel.classList.toggle("ks-prompt--fixed", req.fixedStyle === true);
    this.primary.classList.toggle("ks-hold", this.hold);
    this.title.textContent = req.title;
    this.body.textContent = req.body;
    this.primary.textContent = req.actionLabel;
    this.secondary.textContent = req.cancelLabel;
    this.codeMisses = 0;
    this.newCode(req.fixedStyle === true && !this.tracksVisibility());
    this.setBusy(false, this.restingStatus());
    this.idle.hidden = true;
    this.noticePanel.hidden = true;
    this.panel.hidden = false;
    this.scrollToTop();
    this.onChange(true, req.kind);
    // Focus starts on Cancel, or on the code to type: a key press meant for the page (Enter, Space) can't confirm.
    if (this.code !== null) this.codeInput.focus();
    else this.secondary.focus();
    this.arm();
  }

  /** Whether the browser reports occlusion (IntersectionObserver v2, `isVisible`). */
  private tracksVisibility(): boolean {
    const win = this.panel.ownerDocument.defaultView as (Window & typeof globalThis) | null;
    return !!win?.IntersectionObserver && !!win.IntersectionObserverEntry && "isVisible" in win.IntersectionObserverEntry.prototype;
  }

  /** Shows a fresh code to type (`ask`), or none. */
  private newCode(ask: boolean): void {
    this.code = ask ? this.digits(PROMPT_CODE_DIGITS).slice(0, PROMPT_CODE_DIGITS).padStart(PROMPT_CODE_DIGITS, "0") : null;
    this.codeOk = false;
    this.codeBox.hidden = !ask;
    this.codeValue.textContent = this.code ?? "";
    this.codeInput.value = "";
  }

  /** The user typed in the code field: the right code lets the armed button work; a wrong one shows a new code. */
  private onCode(ev: Event): void {
    if (this.active === null || this.code === null || !this.isTrusted(ev)) return;
    const typed = this.codeInput.value.replace(/\D/g, "");
    if (typed !== this.codeInput.value) this.codeInput.value = typed;
    if (typed.length < PROMPT_CODE_DIGITS) {
      this.codeOk = false;
      this.primary.disabled = true;
      return;
    }
    if (typed === this.code) {
      this.codeOk = true;
      if (this.armed && this.panel.getAttribute("aria-busy") !== "true") this.primary.disabled = false;
      this.status.textContent = this.restingStatus();
      return;
    }
    this.codeMisses++;
    if (this.codeMisses >= PROMPT_CODE_ATTEMPTS) {
      this.cancel?.();
      return;
    }
    this.newCode(true);
    this.primary.disabled = true;
    this.status.textContent = CODE_MISS;
  }

  /** Back to the top of the frame's document and of the prompt (after a fragment moved them). */
  private scrollToTop(): void {
    const doc = this.panel.ownerDocument;
    for (const e of [doc.scrollingElement, doc.documentElement, doc.body, this.panel, this.body]) {
      if (e) {
        e.scrollTop = 0;
        e.scrollLeft = 0;
      }
    }
  }

  /**
   * Enables the primary button once the prompt has been shown for `armMs` (and its code typed, when it asks for one).
   * Where the browser reports occlusion (IntersectionObserver v2, `isVisible`), that time counts only while the whole
   * prompt is in view ({@link PROMPT_FULL_INTERSECTION}), visible and unobscured; clipping, covering, fading or hiding
   * it disables the button again and restarts the wait. Either way, the pointer must then move over the button again,
   * or the keyboard bring focus to it again.
   */
  private arm(): void {
    this.disarm();
    const start = () => {
      clearTimeout(this.armTimer);
      this.armTimer = setTimeout(() => {
        this.armed = true;
        if (this.panel.getAttribute("aria-busy") !== "true" && (this.code === null || this.codeOk)) this.primary.disabled = false;
      }, this.armMs);
    };
    const win = this.panel.ownerDocument.defaultView as (Window & typeof globalThis) | null;
    if (!win || !this.tracksVisibility()) {
      start();
      return;
    }
    this.observer = new win.IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1) as VisibilityEntry | undefined;
        if (entry?.isVisible === true && entry.isIntersecting && entry.intersectionRatio >= PROMPT_FULL_INTERSECTION) start();
        else this.disarm(false);
      },
      // `trackVisibility` and `delay` are IntersectionObserver v2 options (not in every DOM typing).
      { threshold: [PROMPT_FULL_INTERSECTION, 1], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
    );
    this.observer.observe(this.panel);
  }

  /** Arms the open prompt again from the start (see the constructor's resize, blur and visibility listeners). */
  private rearm(): void {
    if (this.active !== null) this.arm();
  }

  /**
   * Disables the primary button until the prompt is armed again and forgets the pointer and the keyboard focus; also
   * stops watching the prompt unless `stopWatching` is false.
   */
  private disarm(stopWatching = true): void {
    clearTimeout(this.armTimer);
    this.armed = false;
    this.primary.disabled = true;
    this.forgetPointer();
    this.forgetKeyboard();
    if (stopWatching) {
      this.observer?.disconnect();
      this.observer = null;
    }
  }

  /** Where the user's pointer is on the primary button; a move there while it is armed lets it confirm. */
  private onPointer(ev: PointerEvent, moved: boolean): void {
    if (this.active === null || !this.isTrusted(ev)) return;
    const at = { x: ev.screenX, y: ev.screenY };
    const last = this.lastPointer;
    if (moved && this.armed && last !== null && (at.x !== last.x || at.y !== last.y)) this.pointerSeen = true;
    this.lastPointer = at;
  }

  private onPress(ev: PointerEvent): void {
    if (this.active === null || !this.isTrusted(ev) || !ev.isPrimary || ev.button !== 0) return;
    // A pointer that can't hover is over the button only while it presses it.
    if (ev.pointerType !== "mouse" && this.armed) this.pointerSeen = true;
    if (this.hold) this.startHold("pointer");
  }

  private onClick(ev: MouseEvent): void {
    if (this.active === null || this.hold || !this.isTrusted(ev) || !this.armed || !this.pointerSeen) return;
    this.confirm?.();
  }

  /** Focus came to the primary button: from the keyboard only right after the user's own Tab in the frame. */
  private onFocus(): void {
    this.keyboardFocus = this.active !== null && this.armed && this.tabbing;
    this.tabbing = false;
    if (this.keyboardFocus && this.holdTimer === undefined && this.panel.getAttribute("aria-busy") !== "true") this.status.textContent = KEY_HINT;
  }

  /** Enter and Space on the primary button: never a click; a fresh press held for `holdMs` once it has keyboard focus. */
  private onKey(ev: KeyboardEvent, down: boolean): void {
    if (this.active === null || (ev.key !== "Enter" && ev.key !== " ")) return;
    // Enter would click on keydown and Space on keyup.
    ev.preventDefault();
    if (!this.isTrusted(ev)) return;
    if (!down) this.releaseHold("key");
    else if (!ev.repeat) this.startHold("key");
  }

  private startHold(by: "pointer" | "key"): void {
    const present = by === "pointer" ? this.pointerSeen : this.keyboardFocus;
    if (!this.armed || !present || this.holdTimer !== undefined || this.panel.getAttribute("aria-busy") === "true") return;
    this.holdBy = by;
    this.primary.classList.add("ks-holding");
    this.status.textContent = "Keep holding…";
    this.holdTimer = setTimeout(() => {
      this.holdTimer = undefined;
      this.holdBy = null;
      this.primary.classList.remove("ks-holding");
      this.confirm?.();
    }, this.holdMs);
  }

  /** Stops a hold that hasn't completed (released early, pointer or focus gone, prompt disarmed); `by`: only that one's. */
  private releaseHold(by?: "pointer" | "key"): void {
    if (this.holdTimer === undefined || (by !== undefined && by !== this.holdBy)) return;
    clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    this.holdBy = null;
    this.primary.classList.remove("ks-holding");
    if (this.active !== null) this.status.textContent = this.restingStatus();
  }

  /** What the status line says while nothing is happening. */
  private restingStatus(): string {
    if (this.code !== null && !this.codeOk) return CODE_HINT;
    return this.keyboardFocus ? KEY_HINT : this.hold ? HOLD_HINT : "";
  }

  /** The pointer left the button (or the prompt was disarmed): it must move over the button again. */
  private forgetPointer(): void {
    this.pointerSeen = false;
    this.lastPointer = null;
    this.releaseHold("pointer");
  }

  /** The button lost focus (or the prompt was disarmed): the keyboard must bring it back with Tab. */
  private forgetKeyboard(): void {
    const had = this.keyboardFocus;
    this.keyboardFocus = false;
    this.releaseHold("key");
    if (had && this.active !== null && this.status.textContent === KEY_HINT) this.status.textContent = this.restingStatus();
  }

  private hide(): void {
    this.disarm();
    this.newCode(false);
    this.hold = false;
    this.primary.classList.remove("ks-hold");
    this.panel.hidden = true;
    this.active = null;
    this.status.textContent = "";
    // A notice that waited behind the prompt comes back.
    if (this.notice !== null) {
      this.noticePanel.hidden = false;
      this.onChange(true, this.notice.kind);
    } else {
      this.idle.hidden = false;
      this.onChange(false, null);
    }
  }

  private setBusy(busy: boolean, status: string): void {
    this.primary.disabled = busy || !this.armed || (this.code !== null && !this.codeOk);
    this.codeInput.disabled = busy;
    this.secondary.disabled = busy;
    this.panel.setAttribute("aria-busy", busy ? "true" : "false");
    this.status.textContent = status;
  }
}

// ---------------------------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------------------------

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([0-9a-zA-Z.,%/ +-]{1,80}\)|[a-zA-Z]{3,24})$/;
const LENGTH_RE = /^(0|\d{1,4}(\.\d{1,3})?(px|rem|em|%))$/;
const FONT_RE = /^[A-Za-z0-9 ,"'_-]{1,120}$/;

function validator(name: ThemeVariable): (value: string) => boolean {
  switch (name) {
    case "--ks-radius":
    case "--ks-font-size":
      return (x) => LENGTH_RE.test(x);
    case "--ks-padding":
      return (x) => {
        const parts = x.trim().split(/\s+/);
        return parts.length >= 1 && parts.length <= 4 && parts.every((p) => LENGTH_RE.test(p));
      };
    case "--ks-font":
      return (x) => FONT_RE.test(x) && !/url|expression/i.test(x);
    default:
      return (x) => COLOR_RE.test(x) && !/url|expression|var/i.test(x);
  }
}

/** Validates theme params; returns the invalid variable names (empty when all are valid). */
export function invalidThemeVariables(params: SetThemeParams): string[] {
  const bad: string[] = [];
  for (const [name, value] of Object.entries(params.variables ?? {})) {
    if (!(THEME_VARIABLES as readonly string[]).includes(name) || typeof value !== "string" || !validator(name as ThemeVariable)(value.trim())) bad.push(name);
  }
  return bad;
}

/** Applies validated theme params through the CSSOM (not blocked by `style-src 'self'`, unlike `style` attributes). */
export function applyTheme(doc: Document, params: SetThemeParams): ThemeVariable[] {
  const applied: ThemeVariable[] = [];
  const style = doc.documentElement.style;
  for (const [name, value] of Object.entries(params.variables ?? {})) {
    if (typeof value !== "string") continue;
    style.setProperty(name, value.trim());
    applied.push(name as ThemeVariable);
  }
  if (params.colorScheme !== undefined) style.setProperty("color-scheme", params.colorScheme);
  return applied;
}

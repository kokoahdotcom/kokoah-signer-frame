/**
 * The frame's tiny in-frame UI: an idle status line and a prompt (short text, a primary button, a cancel button) used
 * when the user must act inside the frame (WebAuthn needs a click in the frame's own document; an HLP deposit, a
 * loosening of the user's limits and large orders need the user's own confirmation of the frame's own description of
 * them).
 *
 * A prompt confirms only where the browser shows it is in view: IntersectionObserver must report all of it (at least
 * {@link PROMPT_FULL_INTERSECTION}) on every browser, and also visible and unobscured where the browser can tell
 * (IntersectionObserver v2, Chromium). Where it can't (Firefox, Safari, every iOS browser), a fixed-style prompt (one
 * that moves money or loosens the user's protection) is confirmed in a top-level window of the signer's own origin that
 * the frame opens on the user's click, where the parent page can't cover it, by typing what it does (its
 * `confirmText`).
 *
 * The DOM is built with `createElement` and `textContent` only: the frame's CSP has `trusted-types 'none'`, so any
 * HTML sink (`innerHTML`, …) would throw. Styling comes from `frame.css` and CSS custom properties that the parent
 * may set through `setTheme` (validated here).
 *
 * @module
 */
import { PROMPT_SIZE_MAX_PX, PROMPT_SIZE_MIN_PX, THEME_VARIABLES, type SetThemeParams, type ThemeVariable } from "../protocol/index.js";

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
   * whether the prompt is seen (no IntersectionObserver v2), such a prompt is confirmed in a window of its own (see the
   * module notes), by typing {@link PromptRequest.confirmText}.
   */
  fixedStyle?: boolean;
  /**
   * What the user types to confirm a fixed-style prompt in its own window: a few words saying what it does ("deposit
   * 1000"). Default: the action label. Compared without case, spaces or punctuation other than the decimal point.
   */
  confirmText?: string;
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
  timer: TimerId;
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

/** The prompt's icons (Lucide's `lock`, `key-round` and `triangle-alert`, ISC license): 24 × 24 strokes. */
const ICONS = {
  lock: [
    ["rect", { width: "18", height: "11", x: "3", y: "11", rx: "2", ry: "2" }],
    ["path", { d: "M7 11V7a5 5 0 0 1 10 0v4" }],
  ],
  key: [
    ["path", { d: "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" }],
    ["circle", { cx: "16.5", cy: "7.5", r: ".5", fill: "currentColor" }],
  ],
  alert: [
    ["path", { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" }],
    ["path", { d: "M12 9v4" }],
    ["path", { d: "M12 17h.01" }],
  ],
} as const satisfies Record<string, ReadonlyArray<readonly [string, Readonly<Record<string, string>>]>>;

/** An icon as SVG built with DOM calls (no HTML parsing), drawn in the text colour and hidden from screen readers. */
function icon(doc: Document, name: keyof typeof ICONS): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) {
    svg.setAttribute(k, v);
  }
  for (const [tag, attrs] of ICONS[name]) {
    const shape = doc.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.append(shape);
  }
  return svg;
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
const TOO_SMALL = "This window is too small to show the whole prompt. Make it larger to confirm.";
const SCROLL_HINT = "Scroll to the end of the text above to confirm.";
const KEY_HINT = "Press and hold Enter or Space to confirm.";
const CODE_HINT = "Type the words shown above first.";
const NOT_SEEN = "This browser can't show that the prompt is in view, so it can't be confirmed here. Update the browser to confirm.";
const WINDOW_LABEL = "Open the confirmation window";
const WINDOW_HINT = "This browser confirms this in a separate Kokoah signer window.";
const WINDOW_OPEN = "Confirm in the Kokoah signer window that opened.";
const WINDOW_BLOCKED =
  "The browser blocked the confirmation window. Allow pop-ups for the Kokoah signer, then try again. In an app's built-in browser, which can't open it, open Kokoah in Safari or your usual browser.";
const WINDOW_CLOSED = "The confirmation window was closed. Open it again, or choose Cancel.";

/**
 * How much of the prompt must be in view, as IntersectionObserver reports it (on every browser), before it arms: all of
 * it, give or take rounding. A parent that clips part of it (the order lines) leaves it disarmed.
 */
export const PROMPT_FULL_INTERSECTION = 0.995;

/** The confirmation window's size (CSS px), as the frame asks the browser for it. */
export const PROMPT_WINDOW_FEATURES = "popup=yes,width=460,height=660";

/**
 * `text` as {@link PromptRequest.confirmText} compares it: lowercase, letters, digits, the decimal point and single
 * spaces between words only (so "Buy 1 1INCH" and "Buy 11 INCH" stay apart).
 */
export function confirmTextKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.\s]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** A timer's id, from a window's timers or Node's. */
type TimerId = ReturnType<typeof globalThis.setTimeout> | number;

/** The timers a prompt runs on: its own window's (a confirmation window's prompt doesn't wait on the frame's). */
export interface PromptTimers {
  setTimeout(fn: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId | undefined): void;
}

/** Why the confirmation window step didn't complete (the in-frame prompt stays, so the user can try again). */
class WindowStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowStepError";
  }
}

/**
 * Least size (CSS px) of the frame's window for a prompt to arm. Smaller, the parent leaves room for little more than
 * the title and the buttons, and the prompt's text would need scrolling. The height the frame reports for a prompt
 * (`promptSize`) is never less.
 */
export const PROMPT_MIN_WIDTH = 280;
export const PROMPT_MIN_HEIGHT = PROMPT_SIZE_MIN_PX;
/**
 * Lines of the prompt's text that must be in view at once when it doesn't fit whole (a small phone): the user then
 * scrolls it to its end before the prompt arms, so every line has been shown.
 */
export const PROMPT_MIN_BODY_LINES = 5;

type VisibilityEntry = IntersectionObserverEntry & { isVisible?: boolean };

/** How often, and how many times, a prompt that isn't laid out yet is measured again (see `measureUntilKnown`). */
const SIZE_RETRY_MS = 16;
const SIZE_TRIES = 20;

/**
 * Timing of the prompt, where its size goes and, for tests (jsdom can't make trusted events), which input events count
 * as the user's.
 */
export interface PromptUiOptions {
  armMs?: number;
  holdMs?: number;
  /** The timers this prompt runs on (default: the global ones, the frame's). */
  timers?: PromptTimers;
  /** Default `ev.isTrusted`: events a script dispatches never confirm. */
  isTrusted?: (ev: Event) => boolean;
  /**
   * Opens the confirmation window (see the module notes) from the user's click in the frame: by default
   * `window.open("", "_blank", PROMPT_WINDOW_FEATURES)`, an `about:blank` window of the signer's own origin (and CSP)
   * that the frame fills itself. Null: blocked.
   */
  openWindow?: (frame: Window) => Window | null;
  /** The timers of a confirmation window's prompt (default: that window's own). */
  timersFor?: (w: Window) => PromptTimers;
  /** This prompt is the one in the confirmation window (a top-level window of the signer's origin): no further window. */
  topLevel?: boolean;
  /**
   * The natural height of the shown prompt or notice (the `promptSize` event, see {@link PromptUi.measure}): called
   * before `onChange` reports it shown (or, while the frame isn't laid out, as soon as it is), and again when that
   * height changes.
   */
  onSize?: (height: number) => void;
}

/** Fills a fresh `about:blank` confirmation window with the frame's own stylesheets and a root for the prompt. */
function prepareWindow(w: Window, frame: Document): HTMLElement {
  const doc = w.document;
  doc.title = "Kokoah signer: confirm";
  doc.documentElement.lang = frame.documentElement.lang || "en";
  const meta = doc.createElement("meta");
  meta.name = "viewport";
  meta.content = "width=device-width, initial-scale=1";
  doc.head.append(meta);
  // The same stylesheets, with their integrity attributes (style-src 'self': the window has the signer's origin and CSP).
  for (const link of frame.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) doc.head.append(doc.importNode(link, true));
  doc.documentElement.classList.add("ks-window");
  const root = doc.createElement("main");
  root.className = "ks-root";
  doc.body.replaceChildren(root);
  return root;
}

/**
 * The primary button works only for the user's own pointer or keyboard on the frame's own document:
 * - it is armed once the prompt has been shown for `armMs` while IntersectionObserver reports all of it in view (and,
 *   where the browser reports occlusion, visible and unobscured; see {@link PromptUi.arm}); a browser without
 *   IntersectionObserver never arms it; resizing the frame, the frame losing focus or the page being hidden starts that
 *   over;
 * - then a click (or, for a `hold` prompt, a press) counts only after real, trusted pointer movement over the armed
 *   button (screen coordinates that change); for a pointer that can't hover (touch, most pens) the press itself;
 *   leaving the button needs new movement. A pointer that was already resting where the button appeared doesn't count;
 * - a `hold` prompt confirms only after the button stayed pressed for `holdMs` with the pointer on it;
 * - from the keyboard, any prompt confirms only when the armed button got focus from the user's own Tab or Shift+Tab
 *   inside the frame (not a script's `focus()`, not focus that came from the parent page) and Enter or Space is then
 *   held for `holdMs` (a fresh press; auto-repeat keeps it going). A key press alone never clicks the button;
 * - where the browser can't tell whether the prompt is seen (no IntersectionObserver v2: Firefox, Safari, every iOS
 *   browser), a fixed-style prompt's button only opens the confirmation window (a top-level `about:blank` window of the
 *   signer's origin, filled by the frame); there the same prompt, with the same rules, also asks the user to type what
 *   it does ({@link PromptRequest.confirmText}) before it confirms. Closing that window leaves the frame's prompt to
 *   open it again or cancel; the frame's prompt ending (cancel, timeout) closes it;
 * - every browser: the prompt arms, and confirms, only in a window of at least {@link PROMPT_MIN_WIDTH} ×
 *   {@link PROMPT_MIN_HEIGHT}, while its text is shown whole (no part of it scrolled out of view), or, where it can't
 *   be (a small phone), once the user scrolled it to its end with at least {@link PROMPT_MIN_BODY_LINES} lines in view;
 *   a parent that makes the frame too small leaves it disarmed, saying so;
 * - the prompt moving on screen under the pointer (the parent moves the frame: the pointer's place in the frame changes
 *   while its place on the screen doesn't, moves the other way, or by a clearly different amount than a mouse's moves
 *   have so far) starts over, and a mouse pointer the frame sees for the first time in a prompt, or again after it
 *   left the frame (it may have arrived by the frame moving under it), counts only after `armMs` there;
 * - the parent moving the frame's document to a fragment (`#ks-body`) scrolls it back and starts over.
 */
export class PromptUi {
  private readonly onChange: (visible: boolean, kind: PromptKind | null) => void;
  private readonly onSize: ((height: number) => void) | null;
  /**
   * The last height reported for what is shown (null: none yet since it was shown), and the least height to report at
   * the window width `sizeWidth` (the largest so far there): within one prompt the reported height never shrinks.
   */
  private sizeSent: number | null = null;
  private sizeFloor = 0;
  private sizeWidth = -1;
  private sizeRetry: TimerId | undefined;
  private readonly armMs: number;
  private readonly holdMs: number;
  private readonly isTrusted: (ev: Event) => boolean;
  private readonly options: PromptUiOptions;
  private readonly timers: PromptTimers;
  private readonly topLevel: boolean;
  /** The confirmation window open for the current prompt, and its prompt. */
  private child: { w: Window; ui: PromptUi } | null = null;
  /** The open prompt's button only opens the confirmation window (see {@link PromptUi.run}). */
  private opensWindow = false;
  private armed = false;
  /** The words the open prompt asks for (their {@link confirmTextKey}; null: none asked), and whether they were typed. */
  private code: string | null = null;
  private codeOk = false;
  private cancel: (() => void) | null = null;
  private armTimer: TimerId | undefined;
  private observer: IntersectionObserver | null = null;
  /** The user's pointer moved over the armed primary button (or pressed it, for a pointer that can't hover). */
  private pointerSeen = false;
  private lastPointer: { x: number; y: number } | null = null;
  /** The armed primary button got focus from the user's own Tab or Shift+Tab inside the frame. */
  private keyboardFocus = false;
  /**
   * The last trusted pointer event in the frame during this prompt, where it was on screen and in the frame, while the
   * pointer stays in the frame; and how far a mouse moves on screen per CSS px in the frame (the zoom), once measured.
   */
  private framePointer: { sx: number; sy: number; cx: number; cy: number } | null = null;
  private screenPerFramePx: number | null = null;
  /** A mouse pointer counts on the button only from this time (ms since the epoch). */
  private pointerReadyAt = 0;
  /** The user scrolled the prompt's text to its end during this prompt. */
  private bodyRead = false;
  /** A trusted Tab keydown whose focus move hasn't landed yet. */
  private tabbing = false;
  private holdTimer: TimerId | undefined;
  /** What is holding the button down while `holdTimer` runs. */
  private holdBy: "pointer" | "key" | null = null;
  /** The open prompt's: whether it confirms by holding, and what confirming does. */
  private hold = false;
  private confirm: (() => void) | null = null;
  private readonly root: HTMLElement;
  private readonly idle: HTMLElement;
  private readonly idleText: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly icon: HTMLElement;
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
    this.onSize = options.onSize ?? null;
    this.armMs = options.armMs ?? PROMPT_ARM_MS;
    this.holdMs = options.holdMs ?? PROMPT_HOLD_MS;
    this.isTrusted = options.isTrusted ?? ((ev) => ev.isTrusted);
    this.options = options;
    this.topLevel = options.topLevel === true;
    // The frame's own (global) timers, or the confirmation window's for its prompt.
    this.timers = options.timers ?? globalThis;
    this.root = root;
    this.idle = el(doc, "section", "ks-idle");
    this.idle.setAttribute("aria-label", "Kokoah signer status");
    this.idleText = el(doc, "p", "ks-idle-text", "Kokoah signer");
    this.idle.append(this.idleText);

    this.panel = el(doc, "section", "ks-prompt");
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-modal", "true");
    this.panel.hidden = true;
    this.icon = el(doc, "div", "ks-icon");
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
    codeLabel.append("To confirm, type: ", this.codeValue);
    this.codeInput = el(doc, "input", "ks-code-input");
    this.codeInput.id = "ks-code-input";
    this.codeInput.type = "text";
    this.codeInput.autocomplete = "off";
    this.codeInput.setAttribute("autocapitalize", "none");
    this.codeInput.setAttribute("autocorrect", "off");
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
    // Cancel, then the action: on the right of it, or on top in a narrow frame (frame.css).
    actions.append(this.secondary, this.primary);
    this.status = el(doc, "p", "ks-status");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.panel.append(this.icon, this.title, this.body, this.codeBox, this.status, actions, keyHint);
    this.codeInput.addEventListener("input", (ev) => this.onCode(ev));
    this.body.addEventListener("scroll", () => this.onBodyScroll());

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
    // Every pointer event in the frame: did the prompt move under the pointer? (Runs before the button's own.)
    for (const type of ["pointerover", "pointermove", "pointerdown"] as const) doc.addEventListener(type, (ev) => this.onFramePointer(ev), true);
    // The pointer left the frame's document: where it comes back says nothing about where it was.
    for (const type of ["pointerout", "mouseout"] as const) {
      doc.addEventListener(type, (ev) => {
        if ((ev as MouseEvent).relatedTarget === null) this.forgetFramePointer();
      }, true);
    }
    doc.documentElement.addEventListener("pointerleave", () => this.forgetFramePointer());
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
        this.timers.setTimeout(() => (this.tabbing = false), 0);
      },
      true,
    );
    // A long press must not open the context menu (or a touch callout) instead of confirming.
    button.addEventListener("contextmenu", (ev) => {
      if (this.hold) ev.preventDefault();
    });
    // Moved out of view, resized by the parent, or the user went elsewhere: shown and seen again before it works.
    const win = doc.defaultView;
    win?.addEventListener("resize", () => {
      this.forgetFramePointer();
      this.rearm();
      this.measure();
    });
    // What is shown changed size (a status line that wraps, another width): the parent learns its new height.
    const Observer = (win as (Window & typeof globalThis) | null)?.ResizeObserver;
    if (this.onSize && Observer) {
      const observer = new Observer(() => this.measure());
      for (const e of [this.panel, this.body, this.noticePanel]) observer.observe(e);
    }
    win?.addEventListener("blur", () => {
      this.forgetFramePointer();
      this.rearm();
    });
    doc.addEventListener("visibilitychange", () => {
      this.forgetFramePointer();
      this.rearm();
    });
    // The parent can move the frame's document to a fragment (`#ks-body`) to scroll part of the prompt out of view.
    win?.addEventListener("hashchange", () => {
      this.scrollToTop();
      this.rearm();
    });
    // The frame going away takes its confirmation window with it.
    win?.addEventListener("pagehide", () => this.closeChild());
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
    const entry: NoticeEntry = { kind: req.kind, timer: this.timers.setTimeout(() => this.endNotice(entry), req.timeoutMs) };
    this.notice = entry;
    if (this.active === null) {
      this.idle.hidden = true;
      this.noticePanel.hidden = false;
      this.shown(true, req.kind);
    }
    return () => this.endNotice(entry);
  }

  /** Ends the notice (only `entry`, when given). */
  private endNotice(entry?: NoticeEntry): void {
    const n = this.notice;
    if (n === null || (entry !== undefined && entry !== n)) return;
    this.timers.clearTimeout(n.timer);
    this.notice = null;
    this.noticePanel.hidden = true;
    if (this.active === null) {
      this.idle.hidden = false;
      this.shown(false, null);
    }
  }

  /**
   * A prompt or the notice was just shown (`kind`), or neither is any more: the frame's whole look follows (a fixed-style
   * prompt and the notice make the frame their card, frame.css `ks-fixed-look`), the parent learns its height, then
   * that it is shown.
   */
  private shown(fixedLook: boolean, kind: PromptKind | null): void {
    this.root.ownerDocument.documentElement.classList.toggle("ks-fixed-look", fixedLook);
    this.sizeSent = null;
    this.sizeFloor = 0;
    this.sizeWidth = -1;
    this.timers.clearTimeout(this.sizeRetry);
    if (kind === null) {
      this.onChange(false, null);
      return;
    }
    this.measureUntilKnown(SIZE_TRIES);
    this.onChange(true, kind);
  }

  /**
   * Measures now and, while the frame isn't laid out yet (the parent unhides the iframe only once it learns a prompt
   * opened, and a browser renders an iframe it doesn't show only lazily), again shortly, a few times.
   */
  private measureUntilKnown(tries: number): void {
    if (!this.onSize) return;
    this.measure();
    if (this.sizeSent !== null || tries <= 1) return;
    this.sizeRetry = this.timers.setTimeout(() => this.measureUntilKnown(tries - 1), SIZE_RETRY_MS);
  }

  /**
   * Reports the natural height of the shown prompt or notice (`onSize`): the root's margin, border and padding and the
   * panel, with any text scrolled out of view counted whole, so the parent can size the frame to show it all. Clamped
   * to {@link PROMPT_SIZE_MIN_PX} (the least height a prompt arms in) and {@link PROMPT_SIZE_MAX_PX}. While one is
   * shown at one window width the height never shrinks, so a status line that wraps once doesn't make the frame resize
   * (and the prompt start over) each time it changes. Nothing is reported while the frame isn't laid out (a hidden
   * iframe): it is measured again once it is shown.
   */
  private measure(): void {
    const panel = this.active !== null ? this.panel : this.notice !== null ? this.noticePanel : null;
    const win = this.root.ownerDocument.defaultView;
    if (!this.onSize || !panel || panel.hidden || !win) return;
    const box = panel.getBoundingClientRect();
    if (box.height <= 0 || win.innerWidth <= 0) return;
    const s = win.getComputedStyle(this.root);
    const px = (v: string) => Number.parseFloat(v) || 0;
    const around = px(s.marginTop) + px(s.borderTopWidth) + px(s.paddingTop) + px(s.paddingBottom) + px(s.borderBottomWidth) + px(s.marginBottom);
    const scroller = panel === this.panel ? this.body : panel;
    const unseen = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (win.innerWidth !== this.sizeWidth) {
      this.sizeWidth = win.innerWidth;
      this.sizeFloor = 0;
    }
    const natural = Math.ceil(around + box.height + unseen - 0.01);
    const height = Math.min(PROMPT_SIZE_MAX_PX, Math.max(PROMPT_SIZE_MIN_PX, this.sizeFloor, natural));
    this.sizeFloor = height;
    if (height === this.sizeSent) return;
    this.sizeSent = height;
    this.onSize(height);
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
    if (req.fixedStyle === true && !this.topLevel && this.visibility() !== "occlusion") {
      // The frame can't show the user is seeing it: its button opens the confirmation window, where it is confirmed.
      const step: PromptRequest = { ...req, actionLabel: WINDOW_LABEL, hold: false };
      return this.runHere(
        step,
        () => this.inWindow(req, action, onFailure),
        (e) => (e instanceof WindowStepError ? { retry: true, message: e.message } : onFailure(e)),
        WINDOW_OPEN,
        true,
      );
    }
    return this.runHere(req, action, onFailure);
  }

  /** Whether `req` is confirmed in the confirmation window here (see the module notes). */
  confirmsInWindow(req: Pick<PromptRequest, "fixedStyle">): boolean {
    return req.fixedStyle === true && !this.topLevel && this.visibility() !== "occlusion";
  }

  /**
   * Opens the confirmation window (from the user's click: this runs synchronously in it), shows `req` there and resolves
   * with its result. Blocked, or closed (or reloaded) before it was confirmed: {@link WindowStepError}, and the frame's
   * prompt stays to open it again. Once confirmed there, closing it changes nothing: the result stands. Actions confirmed
   * in the window must not need its user activation (core.ts gives them none: the work is done after the prompt).
   */
  private inWindow<T>(req: PromptRequest, action: () => Promise<T>, onFailure: (e: unknown) => ActionFailure): Promise<T> {
    const frame = this.panel.ownerDocument.defaultView;
    let w: Window | null = null;
    try {
      w = frame ? (this.options.openWindow ?? ((f: Window) => f.open("", "_blank", PROMPT_WINDOW_FEATURES)))(frame) : null;
    } catch {
      w = null;
    }
    if (!w) return Promise.reject(new WindowStepError(WINDOW_BLOCKED));
    let root: HTMLElement;
    try {
      root = prepareWindow(w, this.panel.ownerDocument);
    } catch {
      // Not a window the frame can fill (another origin): never confirm there.
      w.close();
      return Promise.reject(new WindowStepError(WINDOW_BLOCKED));
    }
    const opened = w;
    const ui = new PromptUi(opened.document, root, () => {}, {
      ...(this.options.armMs !== undefined ? { armMs: this.options.armMs } : {}),
      ...(this.options.holdMs !== undefined ? { holdMs: this.options.holdMs } : {}),
      ...(this.options.isTrusted ? { isTrusted: this.options.isTrusted } : {}),
      timers: this.options.timersFor?.(opened) ?? { setTimeout: opened.setTimeout.bind(opened), clearTimeout: opened.clearTimeout.bind(opened) },
      topLevel: true,
    });
    this.child = { w: opened, ui };
    let started = false;
    const confirmed = () => {
      started = true;
      return action();
    };
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const end = (fn: () => void) => {
        if (done) return;
        done = true;
        this.timers.clearTimeout(poll);
        if (this.child?.w === opened) this.child = null;
        try {
          opened.close();
        } catch {
          // Already gone.
        }
        fn();
      };
      // Closed or reloaded by the user before confirming: the frame's prompt offers it again.
      const gone = () => {
        if (!done && !started) end(() => reject(new WindowStepError(WINDOW_CLOSED)));
      };
      const check = () => {
        if (done) return;
        if (opened.closed) gone();
        if (!done) poll = this.timers.setTimeout(check, 500);
      };
      let poll = this.timers.setTimeout(check, 500);
      opened.addEventListener("pagehide", gone);
      ui.run({ ...req, fixedStyle: true }, confirmed, onFailure).then(
        (value) => end(() => resolve(value)),
        (e: unknown) => end(() => reject(e)),
      );
    });
  }

  /** Closes the confirmation window, if one is open (its prompt ends as cancelled). */
  private closeChild(): void {
    const c = this.child;
    if (c === null) return;
    this.child = null;
    c.ui.cancelOpen();
    try {
      c.w.close();
    } catch {
      // Already gone.
    }
  }

  /** Ends the open prompt as cancelled (its window closed, or the frame's prompt ended). */
  private cancelOpen(): void {
    this.cancel?.();
  }

  private runHere<T>(req: PromptRequest, action: () => Promise<T>, onFailure: (e: unknown) => ActionFailure, busyText?: string, opensWindow = false): Promise<T> {
    this.active = req.kind;
    this.opensWindow = opensWindow;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let running = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        this.confirm = null;
        this.cancel = null;
        this.secondary.onclick = null;
        this.panel.onkeydown = null;
        this.hide();
        fn();
      };
      const timer = this.timers.setTimeout(() => finish(() => reject(new PromptError("USER_TIMEOUT", "The user did not respond in time.", req.kind))), req.timeoutMs);
      this.confirm = () => {
        if (settled || running || !this.armed || (this.code !== null && !this.codeOk)) return;
        // Shown whole at the moment it is confirmed, too.
        if (!this.fits()) {
          this.rearm();
          return;
        }
        running = true;
        this.setBusy(true, busyText ?? (req.hold ? "Confirmed." : "Waiting for your passkey…"));
        // While its window is open, the frame's prompt can still be cancelled (which closes the window).
        if (this.opensWindow) this.secondary.disabled = false;
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
        if (!running || this.opensWindow) finish(() => reject(new PromptError("USER_CANCELLED", "The user cancelled.", req.kind)));
      };
      this.cancel = () => finish(() => reject(new PromptError("USER_CANCELLED", "The prompt was closed.", req.kind)));
      this.panel.onkeydown = (ev: KeyboardEvent) => {
        if (ev.key === "Escape" && (!running || this.opensWindow)) finish(() => reject(new PromptError("USER_CANCELLED", "The user cancelled.", req.kind)));
      };
      this.show(req);
    });
  }

  private show(req: PromptRequest): void {
    this.hold = req.hold === true;
    this.panel.classList.toggle("ks-prompt--fixed", req.fixedStyle === true);
    this.primary.classList.toggle("ks-hold", this.hold);
    this.icon.replaceChildren(icon(this.panel.ownerDocument, req.fixedStyle === true ? "alert" : req.kind === "passkey-create" ? "key" : "lock"));
    this.title.textContent = req.title;
    this.body.textContent = req.body;
    this.primary.textContent = req.actionLabel;
    this.secondary.textContent = req.cancelLabel;
    this.forgetFramePointer();
    this.pointerReadyAt = 0;
    this.bodyRead = false;
    // In the confirmation window, a fixed-style prompt also asks the user to type what it does.
    this.newCode(req.fixedStyle === true && this.topLevel ? (req.confirmText ?? req.actionLabel) : null);
    this.setBusy(false, this.confirmsInWindow(req) ? WINDOW_HINT : this.restingStatus());
    this.idle.hidden = true;
    this.noticePanel.hidden = true;
    this.panel.hidden = false;
    this.scrollToTop();
    this.shown(req.fixedStyle === true, req.kind);
    // Focus starts on Cancel, or on the code to type: a key press meant for the page (Enter, Space) can't confirm.
    if (this.code !== null) this.codeInput.focus();
    else this.secondary.focus();
    this.arm();
  }

  /**
   * What the browser can tell about the prompt being seen: `occlusion` (IntersectionObserver v2, `isVisible`: in view,
   * visible and unobscured), `geometry` (IntersectionObserver v1: in view only), or `none` (no IntersectionObserver).
   */
  private visibility(): "occlusion" | "geometry" | "none" {
    const win = this.panel.ownerDocument.defaultView as (Window & typeof globalThis) | null;
    if (!win?.IntersectionObserver) return "none";
    return win.IntersectionObserverEntry && "isVisible" in win.IntersectionObserverEntry.prototype ? "occlusion" : "geometry";
  }

  /** Shows the words to type (`text`), or none. */
  private newCode(text: string | null): void {
    this.code = text === null ? null : confirmTextKey(text);
    this.codeOk = false;
    this.codeBox.hidden = text === null;
    this.codeValue.textContent = text ?? "";
    this.codeInput.value = "";
    this.codeInput.maxLength = Math.max(80, (text ?? "").length * 2);
  }

  /** The user typed in the field: the words shown let the armed button work. */
  private onCode(ev: Event): void {
    if (this.active === null || this.code === null || !this.isTrusted(ev)) return;
    this.codeOk = confirmTextKey(this.codeInput.value) === this.code;
    if (!this.codeOk) {
      this.primary.disabled = true;
      return;
    }
    // Not armed: the status says why (not in view, too small), or it is the resting one already.
    if (!this.armed) return;
    if (this.panel.getAttribute("aria-busy") !== "true") this.primary.disabled = false;
    this.status.textContent = this.restingStatus();
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
   * Why the prompt can't arm now, or null: the window is below the least size, or the prompt's text doesn't fit whole
   * and wasn't scrolled to its end (or too little of it is in view to read it that way).
   */
  private unfit(): string | null {
    const win = this.panel.ownerDocument.defaultView;
    if (win && (win.innerWidth < PROMPT_MIN_WIDTH || win.innerHeight < PROMPT_MIN_HEIGHT)) return TOO_SMALL;
    const b = this.body;
    if (b.scrollHeight <= b.clientHeight + 1) return null;
    const style = win?.getComputedStyle(b);
    const line = Number.parseFloat(style?.lineHeight ?? "") || (Number.parseFloat(style?.fontSize ?? "") || 15) * 1.45;
    if (b.clientHeight < PROMPT_MIN_BODY_LINES * line - 1) return TOO_SMALL;
    return this.bodyRead ? null : SCROLL_HINT;
  }

  private fits(): boolean {
    return this.unfit() === null;
  }

  /** The user scrolled the prompt's text: once at its end, a prompt that couldn't arm for it arms. */
  private onBodyScroll(): void {
    const b = this.body;
    if (this.active === null || this.bodyRead || b.scrollTop + b.clientHeight < b.scrollHeight - 2) return;
    this.bodyRead = true;
    if (!this.armed) this.rearm();
  }

  /**
   * Enables the primary button once the prompt has been shown for `armMs` (and its words typed, when it asks for them).
   * That time counts only while IntersectionObserver reports the whole prompt in view ({@link PROMPT_FULL_INTERSECTION})
   * and, where the browser reports occlusion (IntersectionObserver v2, `isVisible`), visible and unobscured; clipping,
   * covering, fading or hiding it disables the button again and restarts the wait. A browser without
   * IntersectionObserver never arms it. Either way, the prompt's text must be shown whole in a window large enough for it
   * ({@link PromptUi.fits}; resizing the frame arms it again), and the pointer must then move over the button again, or
   * the keyboard bring focus to it again.
   */
  private arm(): void {
    this.disarm();
    const start = () => {
      this.timers.clearTimeout(this.armTimer);
      this.armTimer = this.timers.setTimeout(() => {
        const why = this.unfit();
        if (why !== null) {
          this.status.textContent = why;
          return;
        }
        if (this.status.textContent === TOO_SMALL || this.status.textContent === SCROLL_HINT) this.status.textContent = this.restingStatus();
        this.armed = true;
        if (this.panel.getAttribute("aria-busy") !== "true" && (this.code === null || this.codeOk)) this.primary.disabled = false;
      }, this.armMs);
    };
    const win = this.panel.ownerDocument.defaultView as (Window & typeof globalThis) | null;
    const mode = this.visibility();
    if (!win || mode === "none") {
      this.status.textContent = NOT_SEEN;
      return;
    }
    const occlusion = mode === "occlusion";
    this.observer = new win.IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1) as VisibilityEntry | undefined;
        if (entry !== undefined && (!occlusion || entry.isVisible === true) && entry.isIntersecting && entry.intersectionRatio >= PROMPT_FULL_INTERSECTION) start();
        else this.disarm(false);
      },
      // `trackVisibility` and `delay` are IntersectionObserver v2 options (not in every DOM typing).
      (occlusion ? { threshold: [PROMPT_FULL_INTERSECTION, 1], trackVisibility: true, delay: 100 } : { threshold: [PROMPT_FULL_INTERSECTION, 1] }) as IntersectionObserverInit,
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
    this.timers.clearTimeout(this.armTimer);
    this.armed = false;
    this.primary.disabled = true;
    this.forgetPointer();
    this.forgetKeyboard();
    if (stopWatching) {
      this.observer?.disconnect();
      this.observer = null;
    }
  }

  /**
   * Any trusted pointer event in the frame while a prompt is open. Between two of them the pointer's place in the frame
   * and on the screen change together; when its place in the frame changes while its place on the screen doesn't (or
   * moves the other way), the frame moved under it: the prompt starts over. The first one the frame sees in a prompt
   * gives no such baseline, so a mouse pointer then counts only after `armMs`.
   */
  private onFramePointer(ev: PointerEvent): void {
    if (this.active === null || !this.isTrusted(ev)) return;
    const now = { sx: ev.screenX, sy: ev.screenY, cx: ev.clientX, cy: ev.clientY };
    const last = this.framePointer;
    this.framePointer = now;
    if (last === null) {
      if (ev.pointerType === "mouse") this.pointerReadyAt = Date.now() + this.armMs;
      return;
    }
    // At least 8 CSS px in the frame: at the lowest browser zoom (25%) a real move of that much still moves 2 screen px.
    const shifted = (screen: number, frame: number) => Math.abs(frame) >= 8 && (Math.abs(screen) < 1 || Math.sign(screen) !== Math.sign(frame));
    // A mouse moves on screen by a fixed multiple of what it moves in the frame (the zoom). Measured on clear moves
    // (16 CSS px and 8 screen px, so rounding stays small), a move off that multiple by more than 40% means the frame
    // moved too. Not for touch and pens, where pinch zoom changes it.
    const offScale = (screen: number, frame: number): boolean => {
      if (ev.pointerType !== "mouse" || Math.abs(frame) < 16 || Math.abs(screen) < 8) return false;
      const ratio = screen / frame;
      if (this.screenPerFramePx === null) {
        if (ratio > 0) this.screenPerFramePx = ratio;
        return false;
      }
      return Math.abs(ratio - this.screenPerFramePx) > 0.4 * this.screenPerFramePx;
    };
    const dx = [now.sx - last.sx, now.cx - last.cx] as const;
    const dy = [now.sy - last.sy, now.cy - last.cy] as const;
    if (shifted(...dx) || shifted(...dy) || offScale(...dx) || offScale(...dy)) {
      this.rearm();
      this.pointerReadyAt = Date.now() + this.armMs;
    }
  }

  /** The frame no longer knows where the pointer is: its next event counts as the first. */
  private forgetFramePointer(): void {
    this.framePointer = null;
    this.screenPerFramePx = null;
  }

  /** Where the user's pointer is on the primary button; a move there while it is armed lets it confirm. */
  private onPointer(ev: PointerEvent, moved: boolean): void {
    if (this.active === null || !this.isTrusted(ev)) return;
    const at = { x: ev.screenX, y: ev.screenY };
    const last = this.lastPointer;
    if (moved && this.armed && last !== null && (at.x !== last.x || at.y !== last.y) && Date.now() >= this.pointerReadyAt) this.pointerSeen = true;
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
    else if (ev.repeat) return;
    // Opening the confirmation window confirms nothing, and a browser lets a page open one only from the key event
    // itself: a fresh press opens it (with the same focus and arming rules), no hold.
    else if (this.opensWindow) {
      if (this.armed && this.keyboardFocus && this.fits()) this.confirm?.();
    } else this.startHold("key");
  }

  private startHold(by: "pointer" | "key"): void {
    const present = by === "pointer" ? this.pointerSeen : this.keyboardFocus;
    if (!this.armed || !present || this.holdTimer !== undefined || this.panel.getAttribute("aria-busy") === "true") return;
    if (!this.fits()) {
      this.rearm();
      return;
    }
    this.holdBy = by;
    this.primary.classList.add("ks-holding");
    this.status.textContent = "Keep holding…";
    this.holdTimer = this.timers.setTimeout(() => {
      this.holdTimer = undefined;
      this.holdBy = null;
      this.primary.classList.remove("ks-holding");
      this.confirm?.();
    }, this.holdMs);
  }

  /** Stops a hold that hasn't completed (released early, pointer or focus gone, prompt disarmed); `by`: only that one's. */
  private releaseHold(by?: "pointer" | "key"): void {
    if (this.holdTimer === undefined || (by !== undefined && by !== this.holdBy)) return;
    this.timers.clearTimeout(this.holdTimer);
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
    this.closeChild();
    this.opensWindow = false;
    this.disarm();
    this.newCode(null);
    this.hold = false;
    this.primary.classList.remove("ks-hold");
    this.panel.hidden = true;
    this.active = null;
    this.status.textContent = "";
    // A notice that waited behind the prompt comes back.
    if (this.notice !== null) {
      this.noticePanel.hidden = false;
      this.shown(true, this.notice.kind);
    } else {
      this.idle.hidden = false;
      this.shown(false, null);
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

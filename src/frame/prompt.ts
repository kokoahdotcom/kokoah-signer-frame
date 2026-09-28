/**
 * The frame's tiny in-frame UI: an idle status line and a prompt (short text, a primary button, a cancel button) used
 * when the user must act inside the frame (WebAuthn needs a click in the frame's own document).
 *
 * The DOM is built with `createElement` and `textContent` only: the frame's CSP has `trusted-types 'none'`, so any
 * HTML sink (`innerHTML`, …) would throw. Styling comes from `frame.css` and CSS custom properties that the parent
 * may set through `setTheme` (validated here).
 *
 * @module
 */
import { THEME_VARIABLES, type SetThemeParams, type ThemeVariable } from "../protocol/index.js";

export type PromptKind = "passkey-create" | "passkey-unlock";

export interface PromptRequest {
  kind: PromptKind;
  title: string;
  body: string;
  actionLabel: string;
  cancelLabel: string;
  timeoutMs: number;
  /**
   * Shown in the frame's own fixed colors and size, whatever the parent's `setTheme` set: for a step that weakens the
   * key's protection, so the parent can't hide or disguise what the user is agreeing to.
   */
  fixedStyle?: boolean;
}

/** Why a prompt ended without success. */
export class PromptError extends Error {
  readonly code: "USER_CANCELLED" | "USER_TIMEOUT" | "PROMPT_BUSY";
  constructor(code: PromptError["code"], message: string) {
    super(message);
    this.name = "PromptError";
    this.code = code;
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

export class PromptUi {
  private readonly onChange: (visible: boolean, kind: PromptKind | null) => void;
  private readonly idle: HTMLElement;
  private readonly idleText: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly primary: HTMLButtonElement;
  private readonly secondary: HTMLButtonElement;
  private readonly status: HTMLElement;
  private active: PromptKind | null = null;

  constructor(doc: Document, root: HTMLElement, onChange: (visible: boolean, kind: PromptKind | null) => void) {
    this.onChange = onChange;
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
    const actions = el(doc, "div", "ks-actions");
    this.primary = el(doc, "button", "ks-button ks-primary");
    this.primary.type = "button";
    this.secondary = el(doc, "button", "ks-button ks-secondary");
    this.secondary.type = "button";
    actions.append(this.primary, this.secondary);
    this.status = el(doc, "p", "ks-status");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.panel.append(this.title, this.body, actions, this.status);
    root.append(this.idle, this.panel);
  }

  /** Updates the idle status line (network, key state). */
  setIdleText(text: string): void {
    this.idleText.textContent = text;
  }

  /**
   * Shows the prompt and resolves with `action()`'s result. `action` is called synchronously from the click handler
   * of the primary button, so it runs with the click's user activation (required by WebAuthn).
   */
  run<T>(req: PromptRequest, action: () => Promise<T>, onFailure: (e: unknown) => ActionFailure): Promise<T> {
    if (this.active !== null) return Promise.reject(new PromptError("PROMPT_BUSY", "Another prompt is already waiting for the user."));
    this.active = req.kind;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let running = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.primary.onclick = null;
        this.secondary.onclick = null;
        this.panel.onkeydown = null;
        this.hide();
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new PromptError("USER_TIMEOUT", "The user did not respond in time."))), req.timeoutMs);
      this.primary.onclick = () => {
        if (settled || running) return;
        running = true;
        this.setBusy(true, "Waiting for your passkey…");
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
        if (!running) finish(() => reject(new PromptError("USER_CANCELLED", "The user cancelled.")));
      };
      this.panel.onkeydown = (ev: KeyboardEvent) => {
        if (ev.key === "Escape" && !running) finish(() => reject(new PromptError("USER_CANCELLED", "The user cancelled.")));
      };
      this.show(req);
    });
  }

  private show(req: PromptRequest): void {
    this.panel.classList.toggle("ks-prompt--fixed", req.fixedStyle === true);
    this.title.textContent = req.title;
    this.body.textContent = req.body;
    this.primary.textContent = req.actionLabel;
    this.secondary.textContent = req.cancelLabel;
    this.setBusy(false, "");
    this.idle.hidden = true;
    this.panel.hidden = false;
    this.onChange(true, req.kind);
    this.primary.focus();
  }

  private hide(): void {
    this.panel.hidden = true;
    this.idle.hidden = false;
    this.active = null;
    this.status.textContent = "";
    this.onChange(false, null);
  }

  private setBusy(busy: boolean, status: string): void {
    this.primary.disabled = busy;
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

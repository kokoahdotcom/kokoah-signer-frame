/**
 * `KokoahSignerClient`: the frontend's side of the signer frame protocol (docs/PROTOCOL.md).
 *
 * It creates and manages the (hidden) iframe, performs the `hello` handshake, correlates request ids, times requests
 * out, exposes one typed method per protocol method and surfaces the frame's events. It has no runtime dependencies;
 * types come from `@kokoah/shared` and the protocol module.
 *
 * ```ts
 * import { KokoahSignerClient } from "@kokoah/signer-frame/client";
 *
 * const signer = new KokoahSignerClient({ frameUrl: import.meta.env.VITE_SIGNER_FRAME_URL });
 * const hello = await signer.hello();          // check hello.network and hello.builder against public-config
 * signer.on("statusChanged", (s) => …);
 * signer.on("promptChanged", ({ visible }) => …);  // show the iframe while visible (passkey ceremonies)
 * const r = await signer.signAndSubmit({ requestId: crypto.randomUUID(), intent });
 * ```
 *
 * @module
 */
import {
  isFrameToParentMessage,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  type ConfirmAgentParams,
  type CreateAgentParams,
  type CreateAgentResult,
  type EventData,
  type EventName,
  type FrameToParentMessage,
  type HelloParams,
  type HelloResult,
  type MethodName,
  type MethodParams,
  type MethodResults,
  type RequestMessage,
  type RevokeParams,
  type RevokeResult,
  type SetLimitsParams,
  type SetLimitsResult,
  type SetThemeParams,
  type SetThemeResult,
  type SignAndSubmitParams,
  type SignAndSubmitResult,
  type SignerError,
  type SignerErrorCode,
  type SignerStatus,
} from "../protocol/index.js";

export * from "../protocol/index.js";

/** Errors raised by the client itself (in addition to the frame's `SignerErrorCode`s). */
export type ClientErrorCode =
  /** No response within the timeout. For `signAndSubmit`, the action may still have been submitted: call again with the same `requestId`. */
  | "TIMEOUT"
  /** `destroy()` was called. */
  | "DESTROYED"
  /** The frame answered `hello` with an unexpected protocol version or origin. */
  | "HANDSHAKE_FAILED";

/** A failed request: either the frame's `{ ok: false, error }` or a client-side failure. */
export class SignerRequestError extends Error {
  readonly code: SignerErrorCode | ClientErrorCode;
  readonly retryable: boolean;
  readonly details: SignerError["details"] | undefined;
  readonly method: MethodName;
  constructor(method: MethodName, error: { code: SignerErrorCode | ClientErrorCode; message: string; retryable: boolean; details?: SignerError["details"] }) {
    super(error.message);
    this.name = "SignerRequestError";
    this.method = method;
    this.code = error.code;
    this.retryable = error.retryable;
    this.details = error.details;
  }
}

export interface KokoahSignerClientOptions {
  /** URL of the signer frame page, e.g. `https://signer.kokoah.example/`. Its origin is the only one trusted. */
  frameUrl: string;
  /** Element the iframe is appended to. Default `document.body`. */
  container?: HTMLElement;
  /** Default request timeout (ms). Default 30 000. */
  requestTimeoutMs?: number;
  /** Timeout for requests that may wait for the user in the frame (`unlock`, passkey `createAgent`). Default 300 000. */
  interactiveTimeoutMs?: number;
  /** How long `hello()` keeps trying to reach the frame (ms). Default 15 000. */
  helloTimeoutMs?: number;
  /**
   * Unhide the iframe while the frame shows a prompt (`promptChanged.visible`) and hide it again afterwards.
   * Default true. Style `iframe[data-kokoah-signer]` (size, position, modal backdrop) in the app.
   */
  autoShowOnPrompt?: boolean;
  /** Accessible title of the iframe. Default "Kokoah signer". */
  iframeTitle?: string;
  /** Client identification sent in `hello`. */
  clientInfo?: { name: string; version: string };
  /** Advanced (tests): the window to use instead of the global one. */
  window?: Window;
}

interface Pending {
  method: MethodName;
  resolve: (value: unknown) => void;
  reject: (error: SignerRequestError) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Listener<E extends EventName> = (data: EventData[E]) => void;

const INTERACTIVE_TIMEOUT_MS = 300_000;
const HELLO_ATTEMPT_MS = 1_500;

/** Client for the Kokoah signer frame. One instance per app. */
export class KokoahSignerClient {
  /** The iframe element (hidden except while the frame shows a prompt). */
  readonly iframe: HTMLIFrameElement;
  /** Origin of the frame; the only origin messages are accepted from and sent to. */
  readonly frameOrigin: string;
  private readonly win: Window;
  private readonly options: Required<Pick<KokoahSignerClientOptions, "requestTimeoutMs" | "interactiveTimeoutMs" | "helloTimeoutMs" | "autoShowOnPrompt">> &
    KokoahSignerClientOptions;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<EventName, Set<Listener<EventName>>>();
  private readonly onMessage: (ev: MessageEvent) => void;
  private helloPromise: Promise<HelloResult> | null = null;
  private helloResult: HelloResult | null = null;
  private readyWaiters: Array<() => void> = [];
  private loaded = false;
  private destroyed = false;
  private counter = 0;

  constructor(options: KokoahSignerClientOptions) {
    this.win = options.window ?? window;
    const url = new URL(options.frameUrl, this.win.location.href);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
      throw new TypeError("frameUrl must be an https URL (http is allowed for localhost only)");
    }
    this.frameOrigin = url.origin;
    this.options = {
      requestTimeoutMs: 30_000,
      interactiveTimeoutMs: INTERACTIVE_TIMEOUT_MS,
      helloTimeoutMs: 15_000,
      autoShowOnPrompt: true,
      ...options,
    };
    const doc = this.win.document;
    const iframe = doc.createElement("iframe");
    iframe.setAttribute("data-kokoah-signer", "");
    iframe.title = options.iframeTitle ?? "Kokoah signer";
    // Passkey ceremonies run inside the frame; the frame's origin must be delegated these features.
    iframe.setAttribute("allow", "publickey-credentials-get; publickey-credentials-create");
    iframe.referrerPolicy = "no-referrer";
    iframe.hidden = true;
    iframe.addEventListener("load", () => {
      this.loaded = true;
      this.wakeReadyWaiters();
    });
    this.iframe = iframe;
    this.onMessage = (ev: MessageEvent) => this.handleMessage(ev);
    this.win.addEventListener("message", this.onMessage);
    iframe.src = url.href;
    (options.container ?? doc.body).append(iframe);
  }

  // -------------------------------------------------------------------------------------------
  // Methods
  // -------------------------------------------------------------------------------------------

  /**
   * Handshake. Waits for the frame, checks the protocol version and origin, and returns the frame's network, builder
   * and capabilities. Compare `network` and `builder` with the app's own configuration and refuse to trade on a
   * mismatch. Called automatically before the first other request; calling it again returns the cached result.
   */
  hello(params: Omit<HelloParams, "protocolVersion"> = {}): Promise<HelloResult> {
    if (this.helloPromise) return this.helloPromise;
    const client = params.client ?? this.options.clientInfo;
    const p = this.handshake(client !== undefined ? { protocolVersion: PROTOCOL_VERSION, client } : { protocolVersion: PROTOCOL_VERSION });
    this.helloPromise = p;
    p.then(
      (r) => (this.helloResult = r),
      () => {
        if (this.helloPromise === p) this.helloPromise = null;
      },
    );
    return p;
  }

  /** The last `hello` result, or null before the handshake completed. */
  get connection(): HelloResult | null {
    return this.helloResult;
  }

  getStatus(): Promise<SignerStatus> {
    return this.request("getStatus", {});
  }

  /** Creates a fresh named agent key; the main wallet then signs `result.approveAgent.typedData` and the app posts it. */
  createAgent(params: CreateAgentParams): Promise<CreateAgentResult> {
    return this.request("createAgent", params, params.storageMode === "passkey" ? this.options.interactiveTimeoutMs : undefined);
  }

  /** Asks the frame to look the agent up on Hyperliquid (`extraAgents`) and mark it active. */
  confirmAgent(params: ConfirmAgentParams = {}): Promise<SignerStatus> {
    return this.request("confirmAgent", params, (params.timeoutMs ?? 0) + this.options.requestTimeoutMs);
  }

  /** Unlocks a passkey-protected key (the frame shows its prompt: keep the iframe visible while `promptChanged.visible`). */
  unlock(): Promise<SignerStatus> {
    return this.request("unlock", {}, this.options.interactiveTimeoutMs);
  }

  lock(): Promise<SignerStatus> {
    return this.request("lock", {});
  }

  /**
   * Validates, policy-checks, signs and submits a trading intent. The result is the immediate acknowledgement; final
   * order state comes from Hyperliquid's WebSocket. On `status: "unknown"` (or a client `TIMEOUT`), query
   * `orderStatus` by cloid, or call again with the **same** `requestId` (the frame replays the first result and never
   * signs twice for one id).
   */
  signAndSubmit(params: SignAndSubmitParams): Promise<SignAndSubmitResult> {
    return this.request("signAndSubmit", params, Math.max(this.options.requestTimeoutMs, 45_000));
  }

  /** Tightens the frame's limits (never loosens: `LIMIT_LOOSENING_REJECTED`). `{}` resets to the baseline. */
  setLimits(params: SetLimitsParams): Promise<SetLimitsResult> {
    return this.request("setLimits", params);
  }

  /** Wipes this device's key and returns `revokeAgent` typed data for the main wallet to sign and the app to post. */
  revoke(params: RevokeParams = {}): Promise<RevokeResult> {
    return this.request("revoke", params);
  }

  /** Sets the frame's CSS custom properties (`--ks-*`) and color scheme. */
  setTheme(params: SetThemeParams): Promise<SetThemeResult> {
    return this.request("setTheme", params);
  }

  /** Low-level typed request. Sends `hello` first if needed. */
  async request<M extends MethodName>(method: M, params: MethodParams[M], timeoutMs?: number): Promise<MethodResults[M]> {
    if (method !== "hello") await this.hello();
    return await this.send(method, params, timeoutMs ?? this.options.requestTimeoutMs);
  }

  // -------------------------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------------------------

  /** Subscribes to a frame event. Returns an unsubscribe function. */
  on<E extends EventName>(event: E, listener: Listener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<EventName>);
    return () => this.off(event, listener);
  }

  off<E extends EventName>(event: E, listener: Listener<E>): void {
    this.listeners.get(event)?.delete(listener as Listener<EventName>);
  }

  /** Shows or hides the iframe (the client does this itself on `promptChanged` unless `autoShowOnPrompt` is false). */
  setFrameVisible(visible: boolean): void {
    this.iframe.hidden = !visible;
  }

  /** Removes the iframe and listener; pending requests fail with `DESTROYED`. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.win.removeEventListener("message", this.onMessage);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new SignerRequestError(p.method, { code: "DESTROYED", message: "The signer client was destroyed.", retryable: false }));
      this.pending.delete(id);
    }
    this.listeners.clear();
    this.wakeReadyWaiters();
    this.iframe.remove();
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private async handshake(params: HelloParams): Promise<HelloResult> {
    const deadline = Date.now() + this.options.helloTimeoutMs;
    let last: SignerRequestError | null = null;
    await this.waitForFrame(this.options.helloTimeoutMs);
    while (!this.destroyed && Date.now() < deadline) {
      try {
        const r = await this.send("hello", params, Math.min(HELLO_ATTEMPT_MS, Math.max(1, deadline - Date.now())));
        if (r.protocolVersion !== PROTOCOL_VERSION) {
          throw new SignerRequestError("hello", { code: "HANDSHAKE_FAILED", message: `The frame speaks protocol version ${String(r.protocolVersion)}`, retryable: false });
        }
        if (r.frameOrigin !== this.frameOrigin) {
          throw new SignerRequestError("hello", { code: "HANDSHAKE_FAILED", message: "The frame reported a different origin than frameUrl", retryable: false });
        }
        return r;
      } catch (e) {
        if (!(e instanceof SignerRequestError) || e.code !== "TIMEOUT") throw e;
        last = e;
      }
    }
    if (this.destroyed) throw new SignerRequestError("hello", { code: "DESTROYED", message: "The signer client was destroyed.", retryable: false });
    throw last ?? new SignerRequestError("hello", { code: "TIMEOUT", message: "The signer frame did not answer hello.", retryable: true });
  }

  /** Resolves once the iframe has loaded or the frame announced `ready` (or after `timeoutMs`). */
  private waitForFrame(timeoutMs: number): Promise<void> {
    if (this.loaded || this.destroyed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.readyWaiters.push(done);
    });
  }

  private wakeReadyWaiters(): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w();
  }

  private nextId(): string {
    this.counter++;
    const rand = new Uint8Array(6);
    this.win.crypto.getRandomValues(rand);
    return `k${this.counter.toString(36)}-${Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  private send<M extends MethodName>(method: M, params: MethodParams[M], timeoutMs: number): Promise<MethodResults[M]> {
    if (this.destroyed) return Promise.reject(new SignerRequestError(method, { code: "DESTROYED", message: "The signer client was destroyed.", retryable: false }));
    const target = this.iframe.contentWindow;
    if (!target) return Promise.reject(new SignerRequestError(method, { code: "TIMEOUT", message: "The signer frame is not attached.", retryable: true }));
    const id = this.nextId();
    const msg: RequestMessage<M> = { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, kind: "request", id, method, params };
    return new Promise<MethodResults[M]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SignerRequestError(method, { code: "TIMEOUT", message: `The signer frame did not answer ${method} in time.`, retryable: true }));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        // Always the frame's exact origin, never "*": if the iframe navigated elsewhere, the browser drops it.
        target.postMessage(msg, this.frameOrigin);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new SignerRequestError(method, { code: "INVALID_REQUEST", message: e instanceof Error ? e.message : "postMessage failed", retryable: false }));
      }
    });
  }

  private handleMessage(ev: MessageEvent): void {
    if (this.destroyed || ev.origin !== this.frameOrigin || ev.source !== this.iframe.contentWindow) return;
    const data: unknown = ev.data;
    if (!isFrameToParentMessage(data)) return;
    const msg = data as FrameToParentMessage;
    if (msg.kind === "response") {
      const p = this.pending.get(msg.id);
      if (!p || p.method !== msg.method) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new SignerRequestError(p.method, msg.error));
      return;
    }
    if (msg.event === "ready") {
      this.loaded = true;
      this.wakeReadyWaiters();
    }
    if (msg.event === "promptChanged" && this.options.autoShowOnPrompt) {
      const data = msg.data as EventData["promptChanged"];
      this.iframe.hidden = !data.visible;
      if (data.kind) this.iframe.setAttribute("data-kokoah-signer-prompt", data.kind);
      else this.iframe.removeAttribute("data-kokoah-signer-prompt");
    }
    const set = this.listeners.get(msg.event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(msg.data);
      } catch {
        // A listener's error must not break the client.
      }
    }
  }
}

/**
 * The signer frame core: message handling, key lifecycle, policy, signing and submission.
 *
 * Everything environment-specific (the parent window, `fetch`, IndexedDB, Web Locks, WebAuthn, the clock) is injected,
 * so the same code runs in the browser (`main.ts`) and in tests.
 *
 * Invariants:
 * - Messages are accepted only from `window.parent` and only from an origin in the build-time allowlist; replies go
 *   to that exact origin, never `*`. Anything else is dropped silently and counted.
 * - The private key never leaves this module: it is not in any message, log line or error. Every outgoing message
 *   passes `outgoingProblem` (no binary data, no 64-hex-digit values).
 * - Nothing is signed unless the key is confirmed on HL, unlocked, not expired, and the action passes the policy,
 *   evaluated on the exact action that is signed, with prices and metadata the frame fetched itself.
 *
 * @module
 */
import {
  type AccountIntent,
  CompileError,
  compileAccountAction,
  compileAction,
  type CompiledAccountAction,
  type CompiledAction,
  isAccountIntentKind,
  safeParseAccountIntent,
} from "@kokoah/shared/actions";
import { parseExchangeResponse } from "@kokoah/shared/errors";
import { safeParseActionIntent, type ActionIntent } from "@kokoah/shared/intents";
import { deviceLinkCode } from "@kokoah/shared/link";
import { isWriteAllowed } from "@kokoah/shared/network";
import type { Policy } from "@kokoah/shared/policy";
import { builderFeeAt } from "@kokoah/shared/risk";
import { buildApproveAgent, buildRevokeAgent, parseAgentName, prepareL1Request } from "@kokoah/shared/signing";
import { SubAccountLookupError, SubAccountOwnership } from "@kokoah/shared/subaccounts";
import { HLP_LOCKUP_DAYS, HLP_VAULT_ADDRESSES, vaultDepositsSince, vaultUnitsToUsd } from "@kokoah/shared/vaults";
import { bytesToHex, hexToBytes } from "viem";
import { generatePrivateKey as viemGeneratePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  AGENT_APPROVAL_PANEL_MS,
  agentAddressCheckCode,
  EXPIRES_AFTER_MS,
  EXPIRING_SOON_MS,
  MAX_AGENT_NAME_LENGTH,
  MAX_MESSAGE_BYTES,
  MAX_VALID_FOR_DAYS,
  MIN_VALID_FOR_DAYS,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  type ConfirmAgentParams,
  type CreateAgentParams,
  type CreateAgentResult,
  type CreateLinkedAgentParams,
  type CreateLinkedAgentResult,
  type EventData,
  type EventName,
  type FrameToParentMessage,
  type Hex,
  type HelloParams,
  type HelloResult,
  type KeyState,
  type MethodName,
  type MethodParams,
  type MethodResults,
  type OutcomeUnknownError,
  type PasskeySupport,
  type RevokeParams,
  type RevokeResult,
  type SetLimitsParams,
  type SetLimitsResult,
  type SetStorageModeParams,
  type SetThemeParams,
  type SetThemeResult,
  type SignAndSubmitParams,
  type SignAndSubmitResult,
  type SignerError,
  type SignerStatus,
  type StorageMode,
  type UserLimits,
} from "../protocol/index.js";
import type { FrameConfig } from "./config.js";
import { deriveKeyFromPrf, generateDeviceKey, keyAad, randomBytes, unwrapSecret, wipe, wrapSecret } from "./crypto.js";
import { outgoingProblem, redactHex64, SignerFailure } from "./errors.js";
import { errorName, HlHttp, type FetchLike } from "./hl.js";
import { RegionGate } from "./eligibility.js";
import { silentLogger, type Logger } from "./log.js";
import { MarketData, MarketDataError, type MarketSnapshot } from "./market-data.js";
import { type FrameAccountBook, readAccountBook } from "./accountBook.js";
import { classifyMessage } from "./messages.js";
import {
  ConfirmationNeededError,
  ReferrerAlreadySignedError,
  SignerBusyError,
  SigningCoordinator,
  UNPROMPTED_DAY_MS,
  UNPROMPTED_WINDOW_MS,
  UsageLimitError,
  type LockManagerLike,
  type UsageKey,
} from "./nonces.js";
import { PasskeyError, type PasskeyProvider } from "./passkey.js";
import {
  type AccountLimits,
  actionNotionalUsd,
  BASELINE_LIMITS,
  applyUserLimits,
  CONFIRM_ORDERS_ABOVE_USD,
  CONFIRM_UNPROMPTED_ABOVE_USD,
  CONFIRM_UNPROMPTED_DAY_ABOVE_USD,
  createBaselinePolicy,
  describeOrders,
  evaluateFrameAccountPolicy,
  evaluateFramePolicy,
  hip3PinnedLegs,
  intentCoins,
  type LimitChange,
  limitChanges,
  type LimitsSet,
  MAX_ACCOUNT_LIMITS,
  orderCount,
  type OrdersDescription,
  policyForAccount,
  printable,
  separateDailyAccounts,
  storedUserLimits,
  summarizeFramePolicy,
  vaultTransfersAllowed,
} from "./policy.js";
import { applyTheme, invalidThemeVariables, PromptError, PromptUi, type ActionFailure, type PromptKind } from "./prompt.js";
import { limitsRev, limitsSlot, type SignerStore, type StoredKeyRecord, type StoredLimitsRecord } from "./storage.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** setTimeout's maximum delay. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const CLOCK_RESYNC_MS = 5 * 60 * 1000;
const CONFIRM_POLL_MS = 1_000;
const MAX_REMEMBERED_REQUESTS = 1_000;
/** Hyperliquid's app refuses a referral code after this much traded volume (USD). */
const REFERRAL_MAX_VOLUME_USD = 10_000;

/** Most attempts of one `setLimits` when other tabs keep writing the limits in between. */
const MAX_LIMITS_ATTEMPTS = 5;

/** Where the frame posts messages (`window.parent`). */
export interface ParentLike {
  postMessage(message: unknown, targetOrigin: string): void;
}

/**
 * A BroadcastChannel (same-origin tabs) used only for "the stored key / limits changed" and "this key was locked" notices
 * (with the agent's address at most), never key material.
 */
export interface BroadcastLike {
  postMessage(message: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close(): void;
}

/** What the browser (or a test) gives the frame. */
export interface FrameDeps {
  config: FrameConfig;
  frameVersion: string;
  /** `location.origin` of the frame (also the WebAuthn RP ID's host). */
  frameOrigin: string;
  /** `window.parent`, or null when the page isn't framed. */
  parent: ParentLike | null;
  /** Document and element for the in-frame UI (null: no UI, so no passkey prompts). */
  document: Document | null;
  uiRoot?: HTMLElement | null;
  fetch: FetchLike;
  crypto: Crypto;
  store: SignerStore;
  locks: LockManagerLike | undefined;
  passkeys: PasskeyProvider;
  broadcast?: BroadcastLike | null;
  now?: () => number;
  /** Test seam: key generator (default viem `generatePrivateKey`, i.e. `crypto.getRandomValues`). */
  generatePrivateKey?: () => Hex;
  /** How long a prompt waits for the user. Default 120 s. */
  promptTimeoutMs?: number;
  /** How long a prompt is shown (and seen, where the browser can tell) before it can be confirmed. Default PROMPT_ARM_MS. */
  promptArmMs?: number;
  /** How long a hold-to-confirm prompt's button must be held. Default PROMPT_HOLD_MS. */
  promptHoldMs?: number;
  /** Test seam: which input events count as the user's own (default `ev.isTrusted`; jsdom can't make trusted events). */
  promptIsTrusted?: (ev: Event) => boolean;
  /** How long the agent approval panel stays without `confirmAgent`. Default AGENT_APPROVAL_PANEL_MS. */
  agentApprovalTimeoutMs?: number;
  logger?: Logger;
}

interface KeyMeta {
  agentAddress: Hex;
  agentName: string;
  userAddress: Hex;
  validUntil: number;
  keyState: "pending" | "active";
  storageMode: StorageMode;
  createdAt: number;
}

interface LoadedKey {
  meta: KeyMeta;
  /** Null while locked. */
  account: PrivateKeyAccount | null;
  generation: number;
}

/** The user's limits (storage.ts `StoredLimitsRecord`), with the master's effective policy. */
interface LimitsState extends LimitsSet {
  /** The stored record's revision (0: none stored). */
  rev: number;
  accounts: Map<string, AccountLimits>;
  /** The baseline with the master's limits on top. */
  policy: Policy;
}

/** Compares the limits of two states, whatever their revisions. */
function limitsKey(s: LimitsSet): string {
  return stableStringify({ master: s.master, accounts: Object.fromEntries([...s.accounts].map(([a, l]) => [a, l.limits])) });
}

interface RequestEntry {
  fingerprint: string;
  promise: Promise<SignAndSubmitResult>;
  consumed: boolean;
}

/** Incoming message as the browser delivers it. */
export interface IncomingMessage {
  data: unknown;
  origin: string;
  source: unknown;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function metaFromRecord(r: StoredKeyRecord): KeyMeta {
  return {
    agentAddress: r.agentAddress,
    agentName: r.agentName,
    userAddress: r.userAddress,
    validUntil: r.validUntil,
    keyState: r.keyState,
    storageMode: r.storageMode,
    createdAt: r.createdAt,
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export class FrameCore {
  private readonly deps: FrameDeps;
  private readonly config: FrameConfig;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly hl: HlHttp;
  private readonly market: MarketData;
  private readonly coordinator: SigningCoordinator;
  private readonly baseline: Policy;
  private readonly ui: PromptUi | null;
  private readonly instanceId: string;
  /**
   * The user's limits as last read from or written to the frame's storage: what `status()` reports. Signing reads the
   * stored limits again under the agent lock, so a change made in another tab binds the next signature.
   */
  private limits: LimitsState;
  /** Orders reads and writes of the limits, so an older read that finishes late can't replace a newer state. */
  private limitsOrder = 0;
  private limitsShownOrder = 0;
  /** The master's sub-accounts, read from HL by the frame itself (never from the parent). */
  private readonly subAccounts: SubAccountOwnership;
  /** Kokoah's region check, asked before anything that adds risk is signed (eligibility.ts). */
  private readonly region: RegionGate;
  private key: LoadedKey | null = null;
  private generation = 0;
  private boundOrigin: string | null = null;
  private clockOffsetMs = 0;
  private clockSyncedAt: number | null = null;
  private clockSync: Promise<void> | null = null;
  /**
   * Run one at a time: key-management operations (`state`); the compare-and-write steps of this tab's `setLimits`
   * calls (`limits`, which every read of the limits waits for); their prompts (`limitsPrompt`).
   */
  private readonly tails: Record<"state" | "limits" | "limitsPrompt", Promise<void>> = { state: Promise.resolve(), limits: Promise.resolve(), limitsPrompt: Promise.resolve() };
  private readonly requests = new Map<string, RequestEntry>();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private notifiedExpiringFor: string | null = null;
  private notifiedExpiredFor: string | null = null;
  private passkeySupportCache: Promise<PasskeySupport> | null = null;
  /** The agent approval panel shown for a new key, and how to end it (see `showAgentApproval`). */
  private approval: { agent: Hex; end: () => void } | null = null;
  private readonly metrics = { ignoredMessages: 0, rejectedRequests: 0, policyDenials: 0, submitted: 0 };
  private destroyed = false;

  private constructor(deps: FrameDeps) {
    this.deps = deps;
    this.config = deps.config;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.logger ?? silentLogger;
    this.hl = new HlHttp({ fetch: deps.fetch, infoUrl: this.config.network.infoUrl, exchangeUrl: this.config.network.exchangeUrl });
    this.market = new MarketData({ hl: this.hl, now: this.now, network: this.config.network.name });
    this.subAccounts = new SubAccountOwnership({ now: this.now, load: async (master) => await this.hl.info({ type: "subAccounts", user: master }) });
    this.region = new RegionGate({ url: this.config.eligibilityUrl, network: this.config.network.name, fetch: deps.fetch, store: deps.store, now: this.now });
    this.coordinator = new SigningCoordinator({ store: deps.store, locks: deps.locks, lockPrefix: `kokoah-signer/v1/${this.config.network.name}` });
    this.baseline = createBaselinePolicy(this.config.builder, { spotCoins: this.market.stablecoinPairCoins, referralCode: this.config.referralCode });
    this.limits = { rev: 0, master: null, accounts: new Map(), policy: this.baseline };
    this.instanceId = bytesToHex(randomBytes(deps.crypto, 8));
    const root = deps.uiRoot ?? deps.document?.body ?? null;
    this.ui =
      deps.document && root
        ? new PromptUi(deps.document, root, (visible, kind) => this.emit("promptChanged", { visible, kind }), {
            ...(deps.promptArmMs !== undefined ? { armMs: deps.promptArmMs } : {}),
            ...(deps.promptHoldMs !== undefined ? { holdMs: deps.promptHoldMs } : {}),
            ...(deps.promptIsTrusted ? { isTrusted: deps.promptIsTrusted } : {}),
          })
        : null;
    if (deps.broadcast) deps.broadcast.onmessage = (ev) => this.onBroadcast(ev.data);
  }

  /** Creates the core and restores a stored key (device keys are unlocked, passkey keys stay locked) and the limits. */
  static async create(deps: FrameDeps): Promise<FrameCore> {
    const core = new FrameCore(deps);
    await core.restoreFromStore();
    await core.refreshLimits();
    core.refreshIdleText();
    core.log("frame.started", { network: core.config.network.name, version: deps.frameVersion });
    return core;
  }

  /** Posts the `ready` event to every allowed origin; the browser delivers it only to the actual parent's. */
  announceReady(): void {
    const parent = this.deps.parent;
    if (!parent) return;
    const msg: FrameToParentMessage = { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, kind: "event", event: "ready", data: { protocolVersion: PROTOCOL_VERSION } };
    for (const origin of this.config.allowedParentOrigins) {
      try {
        parent.postMessage(msg, origin);
      } catch {
        // A mismatching targetOrigin is dropped by the browser; nothing else can fail here.
      }
    }
  }

  /** Stops timers and listeners. */
  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.expiryTimer);
    if (this.deps.broadcast) {
      this.deps.broadcast.onmessage = null;
      this.deps.broadcast.close();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------------------------

  /** Entry point for `message` events. Resolves when the reply (if any) has been posted. */
  async handleMessage(ev: IncomingMessage): Promise<void> {
    const parent = this.deps.parent;
    if (this.destroyed || parent === null || ev.source !== parent || !this.config.allowedParentOrigins.includes(ev.origin)) {
      this.metrics.ignoredMessages++;
      return;
    }
    const origin = ev.origin;
    const c = classifyMessage(ev.data, MAX_MESSAGE_BYTES);
    if (c.kind === "ignore") {
      this.metrics.ignoredMessages++;
      return;
    }
    if (c.kind === "invalid") {
      this.replyError(origin, c.id, c.method, { code: c.code, message: c.message, retryable: false, ...(c.issues ? { details: { issues: c.issues } } : {}) });
      return;
    }
    if (c.method !== "hello" && this.boundOrigin === null) {
      this.replyError(origin, c.id, c.method, { code: "NOT_CONNECTED", message: "Send hello first.", retryable: true });
      return;
    }
    try {
      const result = await this.dispatch(c.method, c.params, origin);
      this.reply(origin, { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, kind: "response", id: c.id, method: c.method, ok: true, result } as FrameToParentMessage);
      if (c.method === "hello") this.checkExpiry();
    } catch (e) {
      this.replyError(origin, c.id, c.method, this.toSignerError(e));
    }
  }

  private async dispatch<M extends MethodName>(method: M, params: MethodParams[M], origin: string): Promise<MethodResults[M]> {
    switch (method) {
      case "hello":
        return (await this.hello(params as HelloParams, origin)) as MethodResults[M];
      case "getStatus":
        await this.refreshLimits();
        return this.status() as MethodResults[M];
      case "createAgent":
        return (await this.createAgent(params as CreateAgentParams)) as MethodResults[M];
      case "createLinkedAgent":
        return (await this.createLinkedAgent(params as CreateLinkedAgentParams)) as MethodResults[M];
      case "confirmAgent":
        return (await this.confirmAgent(params as ConfirmAgentParams)) as MethodResults[M];
      case "unlock":
        return (await this.unlock()) as MethodResults[M];
      case "lock":
        return (await this.lock()) as MethodResults[M];
      case "signAndSubmit":
        return (await this.signAndSubmit(params as SignAndSubmitParams)) as MethodResults[M];
      case "setLimits":
        return (await this.setLimits(params as SetLimitsParams)) as MethodResults[M];
      case "revoke":
        return (await this.revoke(params as RevokeParams)) as MethodResults[M];
      case "setTheme":
        return this.setTheme(params as SetThemeParams) as MethodResults[M];
      case "setStorageMode":
        return (await this.setStorageMode(params as SetStorageModeParams)) as MethodResults[M];
      default:
        throw new SignerFailure("UNKNOWN_METHOD", `Unknown method "${String(method)}"`);
    }
  }

  private reply(origin: string, msg: FrameToParentMessage): void {
    const problem = outgoingProblem(msg);
    if (problem !== null) {
      this.log("message.blocked", { reason: problem });
      if (msg.kind !== "response") return;
      msg = {
        protocol: PROTOCOL_NAME,
        version: PROTOCOL_VERSION,
        kind: "response",
        id: msg.id,
        method: msg.method,
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "The frame refused to send a message that failed its safety check.", retryable: false },
      };
    }
    if (msg.kind === "response" && !msg.ok) this.metrics.rejectedRequests++;
    this.deps.parent?.postMessage(msg, origin);
  }

  private replyError(origin: string, id: string, method: string, error: SignerError): void {
    this.reply(origin, { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, kind: "response", id, method: method as MethodName, ok: false, error });
  }

  /** Posts an event to the parent that completed `hello` (dropped before that). */
  private emit<E extends EventName>(event: E, data: EventData[E]): void {
    if (this.boundOrigin === null || this.destroyed) return;
    this.reply(this.boundOrigin, { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, kind: "event", event, data } as FrameToParentMessage);
  }

  private toSignerError(e: unknown): SignerError {
    if (e instanceof SignerFailure) return e.toJSON();
    if (e instanceof PromptError) return { code: e.code, message: e.message, retryable: true, details: { prompt: e.kind } };
    if (e instanceof SignerBusyError) return { code: "SIGNER_BUSY", message: e.message, retryable: true };
    if (e instanceof Error && e.name === "MainnetWriteBlockedError") {
      return { code: "MAINNET_WRITES_DISABLED", message: "This frame build does not allow mainnet writes.", retryable: false };
    }
    this.log("error.internal", { errorName: errorName(e) });
    return { code: "INTERNAL_ERROR", message: "Internal error in the signer frame.", retryable: false };
  }

  // -------------------------------------------------------------------------------------------
  // State helpers
  // -------------------------------------------------------------------------------------------

  /** Frame clock corrected with HL server time. */
  correctedNow(): number {
    return Math.floor(this.now() + this.clockOffsetMs);
  }

  private keyStateOf(key: LoadedKey | null, now: number = this.correctedNow()): KeyState {
    if (!key) return "none";
    if (now >= key.meta.validUntil - EXPIRES_AFTER_MS) return "expired";
    return key.meta.keyState;
  }

  /** Current status (also the `statusChanged` payload and part of the `hello` result). */
  status(): SignerStatus {
    const k = this.key;
    const now = this.correctedNow();
    const keyState = this.keyStateOf(k, now);
    const expired = keyState === "expired";
    return {
      hasKey: k !== null,
      keyState,
      agentAddress: k?.meta.agentAddress ?? null,
      agentName: k?.meta.agentName ?? null,
      userAddress: k?.meta.userAddress ?? null,
      validUntil: k?.meta.validUntil ?? null,
      expiresAt: k ? k.meta.validUntil - EXPIRES_AFTER_MS : null,
      // Same conditions as checkExpiry's keyExpiringSoon / keyExpired events.
      expiringSoon: k !== null && !expired && k.meta.validUntil - now <= EXPIRING_SOON_MS,
      expired,
      storageMode: k?.meta.storageMode ?? null,
      locked: k !== null && k.account === null,
      network: this.config.network.name,
      mainnetWritesEnabled: this.config.network.name === "mainnet" && this.config.network.allowMainnetWrites,
      clockOffsetMs: this.clockOffsetMs,
      policy: summarizeFramePolicy(this.limits.policy, this.limits.master, this.limits.accounts, this.market.tradingPairCoins),
      metrics: { ...this.metrics },
    };
  }

  private statusChanged(): void {
    this.refreshIdleText();
    this.scheduleExpiryTimer();
    this.emit("statusChanged", this.status());
  }

  private refreshIdleText(): void {
    if (!this.ui) return;
    const k = this.key;
    const state = this.keyStateOf(k);
    const keyText = k === null ? "no trading key" : `trading key ${state}${k.account === null ? ", locked" : ""}`;
    this.ui.setIdleText(`Kokoah signer · ${this.config.network.name} · ${keyText}`);
  }

  /** Serializes key-management operations. */
  private async withState<T>(fn: () => Promise<T>): Promise<T> {
    return await this.serialized("state", fn);
  }

  private async serialized<T>(queue: keyof FrameCore["tails"], fn: () => Promise<T>): Promise<T> {
    const prev = this.tails[queue];
    let release!: () => void;
    this.tails[queue] = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private setKey(key: Omit<LoadedKey, "generation"> | null): void {
    // The approval panel is about one key: another key (or none) ends it.
    if (this.approval !== null && this.approval.agent !== key?.meta.agentAddress) this.endAgentApproval();
    this.generation++;
    this.key = key === null ? null : { ...key, generation: this.generation };
    this.notifiedExpiringFor = null;
    this.notifiedExpiredFor = null;
  }

  private notifyOtherTabs(type: "keyChanged" | "limitsChanged" | "keyLocked" = "keyChanged", agent?: Hex): void {
    try {
      this.deps.broadcast?.postMessage({ type, from: this.instanceId, ...(agent !== undefined ? { agent } : {}) });
    } catch {
      // Best effort.
    }
  }

  private async restoreFromStore(): Promise<void> {
    let rec: StoredKeyRecord | undefined;
    try {
      rec = await this.deps.store.getKeyRecord();
    } catch {
      rec = undefined;
    }
    if (!rec || rec.network !== this.config.network.name) return;
    const account = rec.storageMode === "device" ? await this.unwrapDevice(rec).catch(() => null) : null;
    this.setKey({ meta: metaFromRecord(rec), account });
  }

  private onBroadcast(data: unknown): void {
    if (!isRecord(data) || data.from === this.instanceId) return;
    if (data.type === "limitsChanged") {
      void this.refreshLimits();
      return;
    }
    if (data.type === "keyLocked") {
      // The user locked this key in another tab: lock it here too (a passkey key then needs the passkey again).
      void this.withState(async () => {
        const key = this.key;
        if (!key || key.account === null || key.meta.storageMode === "session" || key.meta.agentAddress !== data.agent) return;
        key.account = null;
        this.generation++;
        key.generation = this.generation;
        this.log("key.locked", { agent: key.meta.agentAddress, storageMode: key.meta.storageMode, reason: "locked in another tab" });
        this.statusChanged();
      });
      return;
    }
    if (data.type !== "keyChanged") return;
    void this.withState(async () => {
      if (this.key?.meta.storageMode === "session") return; // A tab-local session key is independent of storage.
      let rec: StoredKeyRecord | undefined;
      try {
        rec = await this.deps.store.getKeyRecord();
      } catch {
        return;
      }
      if (!rec || rec.network !== this.config.network.name) {
        if (this.key) {
          this.setKey(null);
          this.log("key.reloaded", { reason: "removed in another tab" });
          this.statusChanged();
        }
        return;
      }
      if (this.key && this.key.meta.agentAddress === rec.agentAddress) {
        const before = stableStringify(this.key.meta);
        this.key.meta = metaFromRecord(rec);
        if (before !== stableStringify(this.key.meta)) this.statusChanged();
        return;
      }
      const account = rec.storageMode === "device" ? await this.unwrapDevice(rec).catch(() => null) : null;
      this.setKey({ meta: metaFromRecord(rec), account });
      this.log("key.reloaded", { agent: rec.agentAddress, reason: "changed in another tab" });
      this.statusChanged();
    });
  }

  private async unwrapDevice(rec: StoredKeyRecord): Promise<PrivateKeyAccount> {
    if (!rec.deviceKey) throw new Error("device record without key");
    const secret = await unwrapSecret(this.deps.crypto, rec.deviceKey, rec.wrapped, keyAad(rec.network, "device", rec.agentAddress));
    return this.accountFromSecret(secret, rec.agentAddress);
  }

  private accountFromSecret(secret: Uint8Array, expected: Hex): PrivateKeyAccount {
    try {
      const account = privateKeyToAccount(bytesToHex(secret));
      if (account.address.toLowerCase() !== expected.toLowerCase()) throw new SignerFailure("UNLOCK_FAILED", "The stored key does not match its address.");
      return account;
    } finally {
      wipe(secret);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Clock
  // -------------------------------------------------------------------------------------------

  /** Measures `server time − device time` with HL `exchangeStatus`. Failures keep the previous offset. */
  syncClock(): Promise<void> {
    if (this.clockSync) return this.clockSync;
    this.clockSync = (async () => {
      try {
        const t0 = this.now();
        const r = await this.hl.info({ type: "exchangeStatus" });
        const t1 = this.now();
        if (isRecord(r) && typeof r.time === "number" && Number.isFinite(r.time) && r.time > 0) {
          this.clockOffsetMs = Math.round(r.time - (t0 + t1) / 2);
          this.clockSyncedAt = t1;
          this.log("clock.synced", { offsetMs: this.clockOffsetMs });
        }
      } catch {
        // Keep the previous offset.
      } finally {
        this.clockSync = null;
      }
    })();
    return this.clockSync;
  }

  /** Refuses with REGION_BLOCKED when Kokoah's region check doesn't allow this visitor to add risk. */
  private async requireRegion(): Promise<void> {
    const decision = await this.region.check();
    if (decision.allowed) return;
    this.log("sign.denied", { code: "REGION_BLOCKED" });
    throw new SignerFailure("REGION_BLOCKED", "Trading isn't available in your region. You can still close positions and cancel orders.");
  }

  private async ensureClock(): Promise<void> {
    if (this.clockSyncedAt === null) await this.syncClock();
    else if (this.now() - this.clockSyncedAt > CLOCK_RESYNC_MS) void this.syncClock();
  }

  // -------------------------------------------------------------------------------------------
  // Expiry
  // -------------------------------------------------------------------------------------------

  /** Emits `keyExpiringSoon` / `keyExpired` once per key when due. Called on hello, state changes and timers. */
  checkExpiry(): void {
    const k = this.key;
    if (!k) return;
    const now = this.correctedNow();
    const addr = k.meta.agentAddress;
    const state = this.keyStateOf(k, now);
    if (state === "expired") {
      if (this.notifiedExpiredFor !== addr) {
        this.notifiedExpiredFor = addr;
        this.log("key.expired", { agent: addr });
        this.emit("keyExpired", { agentAddress: addr, validUntil: k.meta.validUntil });
        this.statusChanged();
      }
      return;
    }
    if (k.meta.validUntil - now <= EXPIRING_SOON_MS && this.notifiedExpiringFor !== addr) {
      this.notifiedExpiringFor = addr;
      this.emit("keyExpiringSoon", { agentAddress: addr, validUntil: k.meta.validUntil, msRemaining: Math.max(0, k.meta.validUntil - now) });
    }
    this.scheduleExpiryTimer();
  }

  private scheduleExpiryTimer(): void {
    clearTimeout(this.expiryTimer);
    const k = this.key;
    if (!k || this.destroyed) return;
    const now = this.correctedNow();
    const expiredAt = k.meta.validUntil - EXPIRES_AFTER_MS;
    const soonAt = k.meta.validUntil - EXPIRING_SOON_MS;
    const next = [soonAt, expiredAt].filter((t) => t > now).sort((a, b) => a - b)[0];
    if (next === undefined) return;
    this.expiryTimer = setTimeout(() => this.checkExpiry(), Math.min(MAX_TIMER_MS, next - now + 50));
  }

  // -------------------------------------------------------------------------------------------
  // hello / status
  // -------------------------------------------------------------------------------------------

  private async passkeySupport(): Promise<PasskeySupport> {
    this.passkeySupportCache ??= this.deps.passkeys.support().catch(() => ({ available: false, prf: "unknown" as const, reason: "support check failed" }));
    const s = await this.passkeySupportCache;
    if (!this.deps.store.persistent) return { available: false, prf: s.prf, reason: "IndexedDB is unavailable in the signer frame" };
    if (!this.ui) return { available: false, prf: s.prf, reason: "the frame has no user interface" };
    return s;
  }

  private async hello(params: HelloParams, origin: string): Promise<HelloResult> {
    if (params.protocolVersion !== PROTOCOL_VERSION) {
      throw new SignerFailure("UNSUPPORTED_VERSION", `This frame speaks protocol version ${PROTOCOL_VERSION}.`, { details: { supported: [PROTOCOL_VERSION] } });
    }
    this.boundOrigin = origin;
    void this.syncClock();
    await this.refreshLimits();
    const passkey = await this.passkeySupport();
    const storageModes: StorageMode[] = ["session"];
    if (this.deps.store.persistent) storageModes.unshift("device");
    if (passkey.available) storageModes.unshift("passkey");
    return {
      protocolVersion: PROTOCOL_VERSION,
      frameVersion: this.deps.frameVersion,
      frameOrigin: this.deps.frameOrigin,
      network: this.config.network.name,
      mainnetWritesEnabled: this.config.network.name === "mainnet" && this.config.network.allowMainnetWrites,
      capabilities: {
        storageModes,
        passkey,
        webLocks: this.coordinator.usesWebLocks,
        indexedDB: this.deps.store.persistent,
        broadcastChannel: Boolean(this.deps.broadcast),
        vaultTransfers: true,
        confirmsLooserLimits: true,
        confirmsLargeOrders: true,
        confirmsRecentOrders: true,
        showsAgentApproval: true,
      },
      builder: { address: this.config.builder.address, feeTenthsBps: this.config.builder.feeTenthsBps, promo: this.config.builder.promo },
      status: this.status(),
      limits: {
        maxMessageBytes: MAX_MESSAGE_BYTES,
        minValidForDays: MIN_VALID_FOR_DAYS,
        maxValidForDays: MAX_VALID_FOR_DAYS,
        expiresAfterMs: EXPIRES_AFTER_MS,
        maxAgentNameLength: MAX_AGENT_NAME_LENGTH,
        confirmOrdersAboveUsd: CONFIRM_ORDERS_ABOVE_USD,
        confirmRecentOrdersAboveUsd: CONFIRM_UNPROMPTED_ABOVE_USD,
        recentOrdersWindowMs: UNPROMPTED_WINDOW_MS,
        confirmDailyOrdersAboveUsd: CONFIRM_UNPROMPTED_DAY_ABOVE_USD,
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // createAgent
  // -------------------------------------------------------------------------------------------

  private async createAgent(p: CreateAgentParams): Promise<CreateAgentResult> {
    const created = await this.createKey({ ...p, agentName: p.agentName ?? this.config.defaultAgentName }, "local", (meta) => ({
      approveAgent: buildApproveAgent({
        agentAddress: meta.agentAddress,
        agentName: meta.agentName,
        validUntil: meta.validUntil,
        nonce: meta.createdAt,
        now: meta.createdAt,
        network: this.config.network,
        ...(p.signatureChainId !== undefined ? { signatureChainId: p.signatureChainId } : {}),
      }),
    }));
    // The main wallet signs `approveAgent` next: the user compares its `agentAddress` with the frame's own panel.
    if (this.key?.meta.agentAddress === created.agentAddress) this.showAgentApproval(created.agentAddress);
    return created;
  }

  /**
   * The frame's own panel while the main wallet approves a new key (`promptChanged` kind `agent-approval`, fixed look,
   * no action): the key's full address and its check code (protocol `agentAddressCheckCode`), so the user can tell the
   * wallet's request for this key from one for an address the page chose. Ends with `confirmAgent`, the user's Hide,
   * another key, or `agentApprovalTimeoutMs`.
   */
  private showAgentApproval(agent: Hex): void {
    if (!this.ui) return;
    this.endAgentApproval();
    const end = this.ui.showNotice({
      kind: "agent-approval",
      title: "Check the new trading key in your wallet",
      body: "Your wallet will ask you to approve a trading key for this device. Approve it only if your wallet shows this address:",
      lines: [agent, `Check: ${agentAddressCheckCode(agent)}`],
      closeLabel: "Hide",
      timeoutMs: this.deps.agentApprovalTimeoutMs ?? AGENT_APPROVAL_PANEL_MS,
    });
    this.approval = { agent, end };
  }

  /** Ends the agent approval panel, if one is open (for `agent` only, when given). */
  private endAgentApproval(agent?: Hex): void {
    const a = this.approval;
    if (a === null || (agent !== undefined && a.agent !== agent)) return;
    this.approval = null;
    a.end();
  }

  /**
   * "Link phone": the same fresh, stored, pending key as `createAgent`, for an account whose main wallet is on another
   * device. No `approveAgent` typed data is returned (the computer builds and signs its own for this address, name and
   * expiry); instead the frame returns the matching code bound to the key it holds. The link secret is used for the
   * code only and never stored or logged.
   */
  private async createLinkedAgent(p: CreateLinkedAgentParams): Promise<CreateLinkedAgentResult> {
    return await this.createKey(p, "linked", (meta) => ({
      pairingId: p.link.pairingId,
      matchCode: deviceLinkCode({
        secret: p.link.secret,
        pairingId: p.link.pairingId,
        userAddress: meta.userAddress,
        agentAddress: meta.agentAddress,
        agentName: meta.agentName,
        validUntil: meta.validUntil,
      }),
    }));
  }

  /**
   * Generates a fresh agent key (never reused), stores it pending under the requested mode (with the passkey and
   * IndexedDB fallbacks) and makes it the current key. `describe` adds the caller's result fields; it runs before the
   * key is stored, so a failure there leaves the previous key in place.
   */
  private async createKey<X extends object>(
    p: { userAddress: Hex; agentName: string; validForDays: number; storageMode: StorageMode; replaceExisting?: boolean | undefined },
    kind: "local" | "linked",
    describe: (meta: KeyMeta) => X,
  ): Promise<X & Omit<CreateAgentResult, "approveAgent">> {
    return await this.withState(async () => {
      if (!isWriteAllowed(this.config.network)) throw new SignerFailure("MAINNET_WRITES_DISABLED", "This frame build does not allow mainnet writes.");
      const existing = this.key;
      if (existing && this.keyStateOf(existing) !== "expired" && p.replaceExisting !== true) {
        throw new SignerFailure("KEY_EXISTS", "A trading key already exists on this device; pass replaceExisting: true to replace it.", {
          details: { agentAddress: existing.meta.agentAddress, keyState: this.keyStateOf(existing) },
        });
      }
      const agentName = p.agentName;
      let mode: StorageMode = p.storageMode;
      let fallbackReason: string | undefined;
      if (mode === "passkey") {
        const support = await this.passkeySupport();
        if (!support.available) {
          mode = "device";
          fallbackReason = `passkey unavailable: ${support.reason ?? "not supported"}`;
        }
      }
      if (mode !== "session" && !this.deps.store.persistent) {
        fallbackReason = `${mode} storage unavailable: IndexedDB is not available in the signer frame`;
        mode = "session";
      }

      // Keep the previous passkey credential (if any) so a renewal needs no new passkey.
      let previousRecord: StoredKeyRecord | undefined;
      try {
        previousRecord = await this.deps.store.getKeyRecord();
      } catch {
        previousRecord = undefined;
      }
      // A new key that unlocks without the passkey must not silently take the place of one protected by it.
      const protectedKey = existing?.meta.storageMode === "passkey" || (previousRecord?.network === this.config.network.name && previousRecord.storageMode === "passkey");
      if (protectedKey && mode !== "passkey") await this.confirmKeyRemoval("replace");

      // Fresh key, never reused.
      const generate = this.deps.generatePrivateKey ?? viemGeneratePrivateKey;
      let pkHex: Hex | undefined;
      let account: PrivateKeyAccount | undefined;
      for (let attempt = 0; attempt < 3 && account === undefined; attempt++) {
        pkHex = generate();
        const candidate = privateKeyToAccount(pkHex);
        if (await this.deps.store.claimAgentAddress(candidate.address, this.now())) account = candidate;
      }
      if (account === undefined || pkHex === undefined) throw new SignerFailure("INTERNAL_ERROR", "Could not generate a fresh agent key.");
      const agentAddress = account.address.toLowerCase() as Hex;
      const secret = hexToBytes(pkHex);
      pkHex = undefined;

      const now = this.correctedNow();
      const validUntil = now + p.validForDays * DAY_MS;
      const meta: KeyMeta = { agentAddress, agentName, userAddress: p.userAddress, validUntil, keyState: "pending", storageMode: mode, createdAt: now };
      let extra: X;
      try {
        extra = describe({ ...meta });
      } catch (e) {
        wipe(secret);
        throw e;
      }

      try {
        if (mode === "passkey") {
          const outcome = await this.storePasskeyRecord(meta, secret, previousRecord);
          if (outcome === "unsupported") {
            mode = "device";
            meta.storageMode = "device";
            fallbackReason = "passkey unavailable: the authenticator does not support the PRF extension";
          }
        }
        if (mode === "device") await this.storeDeviceRecord(meta, secret);
        if (mode === "session") {
          // Replacing a stored key with a session key: the stored one must not come back on reload.
          if (existing && existing.meta.storageMode !== "session") await this.deps.store.deleteKeyRecord();
        }
      } catch (e) {
        if (e instanceof SignerFailure || e instanceof PromptError) throw e;
        throw new SignerFailure("STORAGE_FAILED", "The trading key could not be stored on this device.", { retryable: true });
      } finally {
        wipe(secret);
      }

      this.setKey({ meta, account });
      this.log("key.created", { agent: agentAddress, storageMode: mode, ...(fallbackReason ? { fallback: "yes" } : {}), ...(kind === "linked" ? { reason: "linked" } : {}) });
      this.notifyOtherTabs();
      this.statusChanged();
      return {
        ...extra,
        agentAddress,
        agentName,
        validUntil,
        storageMode: mode,
        requestedStorageMode: p.storageMode,
        ...(fallbackReason !== undefined ? { storageFallbackReason: fallbackReason } : {}),
        keyState: "pending" as const,
      };
    });
  }

  private async storeDeviceRecord(meta: KeyMeta, secret: Uint8Array, confirmedAt?: number): Promise<void> {
    const deviceKey = await generateDeviceKey(this.deps.crypto);
    const wrapped = await wrapSecret(this.deps.crypto, deviceKey, secret, keyAad(this.config.network.name, "device", meta.agentAddress));
    await this.deps.store.putKeyRecord({
      slot: "current",
      v: 1,
      network: this.config.network.name,
      ...meta,
      storageMode: "device",
      keyState: meta.keyState,
      wrapped,
      deviceKey,
      ...(confirmedAt !== undefined ? { confirmedAt } : {}),
    });
  }

  private promptFailure(e: unknown): ActionFailure {
    if (e instanceof PasskeyError) {
      if (e.code === "unsupported") return { retry: false };
      return { retry: true, message: e.code === "cancelled" ? "The passkey request was cancelled. Try again, or choose Cancel." : "The passkey request failed. Try again, or choose Cancel." };
    }
    return { retry: false };
  }

  private requirePromptUi(): PromptUi {
    if (!this.ui) throw new SignerFailure("PASSKEY_UNAVAILABLE", "The frame has no user interface for passkey prompts.");
    return this.ui;
  }

  private async prompt<T>(kind: PromptKind, texts: { title: string; body: string; actionLabel: string; fixedStyle?: boolean; hold?: boolean }, action: () => Promise<T>): Promise<T> {
    const ui = this.requirePromptUi();
    return await ui.run({ kind, ...texts, cancelLabel: "Cancel", timeoutMs: this.deps.promptTimeoutMs ?? 120_000 }, action, (e) => this.promptFailure(e));
  }

  /**
   * Wraps the secret with a passkey PRF secret. Returns "unsupported" when the authenticator can't do PRF (the caller
   * falls back to device storage); throws on cancel/timeout.
   */
  private async storePasskeyRecord(meta: KeyMeta, secret: Uint8Array, previous: StoredKeyRecord | undefined, confirmedAt?: number): Promise<"stored" | "unsupported"> {
    const crypto = this.deps.crypto;
    const rpId = new URL(this.deps.frameOrigin).hostname;
    const prfSalt = randomBytes(crypto, 32);
    const hkdfSalt = randomBytes(crypto, 32);
    let credentialId: Uint8Array;
    let prfFirst: Uint8Array | undefined;
    try {
      const reuse = previous?.storageMode === "passkey" && previous.passkey && previous.passkey.rpId === rpId ? previous.passkey : undefined;
      if (reuse) {
        credentialId = reuse.credentialId;
        const r = await this.prompt(
          "passkey-create",
          { title: "Protect your new trading key", body: "Use your Kokoah passkey to protect the renewed trading key on this device. It can trade but can never withdraw.", actionLabel: "Use passkey" },
          () => this.deps.passkeys.get({ rpId, credentialId: reuse.credentialId, prfSalt, timeoutMs: 60_000 }),
        );
        prfFirst = r.prfFirst;
      } else {
        const created = await this.prompt(
          "passkey-create",
          {
            title: "Protect your trading key",
            body: "Create a passkey for Kokoah's trading key on this device. You will use it to unlock trading after the page reloads. The key can place and cancel orders but can never withdraw.",
            actionLabel: "Create passkey",
          },
          async () => {
            const r = await this.deps.passkeys.create({
              rpId,
              rpName: "Kokoah signer",
              userId: randomBytes(crypto, 16),
              userName: `kokoah-trading-key-${meta.agentAddress.slice(2, 10)}`,
              userDisplayName: "Kokoah trading key",
              prfSalt,
              timeoutMs: 60_000,
            });
            if (r.prfEnabled === false) throw new PasskeyError("unsupported", "The passkey does not support the PRF extension.");
            return r;
          },
        );
        credentialId = created.credentialId;
        prfFirst = created.prfFirst;
        if (prfFirst === undefined) {
          // The PRF output needs an assertion; WebAuthn wants a fresh click for it.
          const r = await this.prompt(
            "passkey-create",
            { title: "Confirm your passkey", body: "One more step: confirm the passkey you just created so it can protect the trading key.", actionLabel: "Confirm passkey" },
            () => this.deps.passkeys.get({ rpId, credentialId, prfSalt, timeoutMs: 60_000 }),
          );
          prfFirst = r.prfFirst;
        }
      }
    } catch (e) {
      if (e instanceof PasskeyError && e.code === "unsupported") return "unsupported";
      if (e instanceof PasskeyError) throw new SignerFailure("PASSKEY_FAILED", e.message, { retryable: true });
      throw e;
    }
    try {
      const wrapKey = await deriveKeyFromPrf(crypto, prfFirst, hkdfSalt);
      const wrapped = await wrapSecret(crypto, wrapKey, secret, keyAad(this.config.network.name, "passkey", meta.agentAddress));
      await this.deps.store.putKeyRecord({
        slot: "current",
        v: 1,
        network: this.config.network.name,
        ...meta,
        storageMode: "passkey",
        keyState: meta.keyState,
        wrapped,
        passkey: { credentialId: new Uint8Array(credentialId), prfSalt, hkdfSalt, rpId },
        ...(confirmedAt !== undefined ? { confirmedAt } : {}),
      });
    } finally {
      wipe(prfFirst);
    }
    return "stored";
  }

  // -------------------------------------------------------------------------------------------
  // confirmAgent
  // -------------------------------------------------------------------------------------------

  private async confirmAgent(p: ConfirmAgentParams): Promise<SignerStatus> {
    // Whatever the answer, the wallet step it waited for is over: the approval panel ends with it.
    const agent = this.key?.meta.agentAddress;
    try {
      return await this.checkAgent(p);
    } finally {
      if (agent !== undefined) this.endAgentApproval(agent);
    }
  }

  private async checkAgent(p: ConfirmAgentParams): Promise<SignerStatus> {
    const key = this.key;
    if (!key) throw new SignerFailure("NO_KEY", "There is no trading key on this device; call createAgent first.");
    const state = this.keyStateOf(key);
    if (state === "expired") throw new SignerFailure("KEY_EXPIRED", "The trading key has expired; create a new one.");
    if (state === "active") return this.status();
    const deadline = this.now() + (p.timeoutMs ?? 0);
    let lastError: "not_found" | "hl" | "mismatch" = "not_found";
    for (;;) {
      try {
        const agents = await this.hl.info({ type: "extraAgents", user: key.meta.userAddress });
        if (!Array.isArray(agents)) throw new Error("malformed extraAgents");
        const entry = agents.find((a): a is Record<string, unknown> => isRecord(a) && typeof a.address === "string" && a.address.toLowerCase() === key.meta.agentAddress);
        if (entry) {
          const name = typeof entry.name === "string" ? parseAgentName(entry.name).name : "";
          if (name !== key.meta.agentName) {
            lastError = "mismatch";
          } else {
            const hlValidUntil = typeof entry.validUntil === "number" && entry.validUntil > 0 ? entry.validUntil : undefined;
            return await this.markActive(key, hlValidUntil);
          }
        } else lastError = "not_found";
      } catch {
        lastError = "hl";
      }
      if (this.now() + CONFIRM_POLL_MS > deadline) break;
      await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
      if (this.key?.generation !== key.generation) throw new SignerFailure("KEY_CHANGED", "The trading key changed while confirming it.", { retryable: true });
    }
    if (lastError === "hl") throw new SignerFailure("HL_UNAVAILABLE", "Hyperliquid could not be reached to confirm the trading key.", { retryable: true });
    if (lastError === "mismatch") {
      throw new SignerFailure("AGENT_MISMATCH", `Hyperliquid lists this key under a different name than "${key.meta.agentName}".`, { details: { agentAddress: key.meta.agentAddress } });
    }
    throw new SignerFailure("AGENT_NOT_FOUND", "Hyperliquid does not list this trading key for the account yet. Post the signed approveAgent, then try again.", {
      retryable: true,
      details: { agentAddress: key.meta.agentAddress, userAddress: key.meta.userAddress },
    });
  }

  private async markActive(key: LoadedKey, hlValidUntil: number | undefined): Promise<SignerStatus> {
    return await this.withState(async () => {
      if (this.key?.generation !== key.generation) throw new SignerFailure("KEY_CHANGED", "The trading key changed while confirming it.", { retryable: true });
      const meta: KeyMeta = {
        ...key.meta,
        keyState: "active",
        // The frame never signs past the expiry it asked for, even if HL reports a later one.
        validUntil: hlValidUntil !== undefined ? Math.min(key.meta.validUntil, hlValidUntil) : key.meta.validUntil,
      };
      if (meta.storageMode !== "session") {
        const rec = await this.deps.store.getKeyRecord();
        if (!rec || rec.agentAddress !== meta.agentAddress) throw new SignerFailure("KEY_CHANGED", "The stored trading key changed while confirming it.", { retryable: true });
        await this.deps.store.putKeyRecord({ ...rec, keyState: "active", validUntil: meta.validUntil, confirmedAt: this.now() });
      }
      key.meta = meta;
      this.log("key.confirmed", { agent: meta.agentAddress });
      this.notifyOtherTabs();
      this.statusChanged();
      this.checkExpiry();
      return this.status();
    });
  }

  // -------------------------------------------------------------------------------------------
  // unlock / lock
  // -------------------------------------------------------------------------------------------

  private async unlock(): Promise<SignerStatus> {
    return await this.withState(async () => {
      const key = this.key;
      if (!key) throw new SignerFailure("NO_KEY", "There is no trading key on this device.");
      if (key.account) return this.status();
      let rec: StoredKeyRecord | undefined;
      try {
        rec = await this.deps.store.getKeyRecord();
      } catch {
        rec = undefined;
      }
      if (!rec || rec.agentAddress !== key.meta.agentAddress) throw new SignerFailure("NO_KEY", "The stored trading key is gone; create a new one.");
      if (rec.storageMode === "device") {
        try {
          key.account = await this.unwrapDevice(rec);
        } catch {
          this.log("key.unlock_failed", { storageMode: "device" });
          throw new SignerFailure("UNLOCK_FAILED", "The stored trading key could not be decrypted; revoke it and create a new one.");
        }
      } else {
        const pk = rec.passkey;
        if (!pk) throw new SignerFailure("UNLOCK_FAILED", "The stored passkey record is incomplete; revoke it and create a new one.");
        const aad = keyAad(rec.network, "passkey", rec.agentAddress);
        let account: PrivateKeyAccount;
        try {
          account = await this.prompt(
            "passkey-unlock",
            { title: "Unlock trading", body: "Use your passkey to unlock Kokoah's trading key on this device.", actionLabel: "Unlock with passkey" },
            async () => {
              const { prfFirst } = await this.deps.passkeys.get({ rpId: pk.rpId, credentialId: pk.credentialId, prfSalt: pk.prfSalt, timeoutMs: 60_000 });
              try {
                const wrapKey = await deriveKeyFromPrf(this.deps.crypto, prfFirst, pk.hkdfSalt);
                let secret: Uint8Array;
                try {
                  secret = await unwrapSecret(this.deps.crypto, wrapKey, rec.wrapped, aad);
                } catch {
                  throw new SignerFailure("UNLOCK_FAILED", "This passkey could not unlock the trading key.");
                }
                return this.accountFromSecret(secret, rec.agentAddress);
              } finally {
                wipe(prfFirst);
              }
            },
          );
        } catch (e) {
          if (e instanceof PasskeyError) {
            this.log("key.unlock_failed", { storageMode: "passkey", code: e.code });
            throw new SignerFailure(e.code === "unsupported" ? "PASSKEY_UNAVAILABLE" : "PASSKEY_FAILED", e.message, { retryable: e.code !== "unsupported" });
          }
          if (e instanceof SignerFailure) this.log("key.unlock_failed", { storageMode: "passkey", code: e.code });
          throw e;
        }
        if (this.key !== key) throw new SignerFailure("KEY_CHANGED", "The trading key changed while unlocking it.", { retryable: true });
        key.account = account;
      }
      this.log("key.unlocked", { agent: key.meta.agentAddress, storageMode: key.meta.storageMode });
      this.statusChanged();
      this.checkExpiry();
      return this.status();
    });
  }

  private async lock(): Promise<SignerStatus> {
    return await this.withState(async () => {
      const key = this.key;
      if (!key) return this.status();
      if (key.meta.storageMode === "session") {
        // A session key can't be unlocked again: locking discards it.
        this.setKey(null);
      } else {
        key.account = null;
        this.generation++;
        key.generation = this.generation;
        // The same key in this browser's other tabs is locked too (their frames get the notice, not their pages).
        this.notifyOtherTabs("keyLocked", key.meta.agentAddress);
      }
      this.log("key.locked", { agent: key.meta.agentAddress, storageMode: key.meta.storageMode });
      this.statusChanged();
      return this.status();
    });
  }

  // -------------------------------------------------------------------------------------------
  // setStorageMode
  // -------------------------------------------------------------------------------------------

  /**
   * Re-wraps the stored key under another mode with no new `approveAgent`: `device` → `passkey` adds passkey
   * protection (one passkey prompt), `passkey` → `device` removes it (one passkey prompt to decrypt). The secret is
   * read from the stored ciphertext (never from memory), re-encrypted and written in place of the old record. A key
   * that is unlocked in this tab stays unlocked.
   */
  private async setStorageMode(p: SetStorageModeParams): Promise<SignerStatus> {
    return await this.withState(async () => {
      const key = this.key;
      if (!key) throw new SignerFailure("NO_KEY", "There is no trading key on this device.");
      if (key.meta.storageMode === p.to) return this.status();
      if (key.meta.storageMode === "session" || !this.deps.store.persistent) {
        throw new SignerFailure("STORAGE_FAILED", "This trading key is kept for this session only; create a new key to store it.");
      }
      let rec: StoredKeyRecord | undefined;
      try {
        rec = await this.deps.store.getKeyRecord();
      } catch {
        rec = undefined;
      }
      if (!rec || rec.agentAddress !== key.meta.agentAddress || rec.network !== this.config.network.name) {
        throw new SignerFailure("NO_KEY", "The stored trading key is gone; create a new one.");
      }
      const meta: KeyMeta = { ...metaFromRecord(rec), keyState: key.meta.keyState, validUntil: key.meta.validUntil, storageMode: p.to };
      if (p.to === "passkey") {
        const support = await this.passkeySupport();
        if (!support.available) throw new SignerFailure("PASSKEY_UNAVAILABLE", `Passkeys are not available here: ${support.reason ?? "not supported"}.`);
        let secret: Uint8Array;
        try {
          if (!rec.deviceKey) throw new Error("device record without key");
          secret = await unwrapSecret(this.deps.crypto, rec.deviceKey, rec.wrapped, keyAad(rec.network, "device", rec.agentAddress));
        } catch {
          throw new SignerFailure("UNLOCK_FAILED", "The stored trading key could not be decrypted; revoke it and create a new one.");
        }
        try {
          const outcome = await this.storePasskeyRecord(meta, secret, undefined, rec.confirmedAt);
          if (outcome === "unsupported") throw new SignerFailure("PASSKEY_UNAVAILABLE", "This passkey does not support the PRF extension, so it can't protect the key.");
        } finally {
          wipe(secret);
        }
      } else {
        const pk = rec.passkey;
        if (!pk) throw new SignerFailure("UNLOCK_FAILED", "The stored passkey record is incomplete; revoke it and create a new one.");
        const aad = keyAad(rec.network, "passkey", rec.agentAddress);
        const wrapped = rec.wrapped;
        let secret: Uint8Array;
        try {
          secret = await this.prompt(
            "passkey-unlock",
            {
              title: "Remove passkey protection?",
              body: "After this, the trading key on this device unlocks without your passkey. Continue only if you asked for this.",
              actionLabel: "Remove protection",
              fixedStyle: true,
            },
            async () => {
              const { prfFirst } = await this.deps.passkeys.get({ rpId: pk.rpId, credentialId: pk.credentialId, prfSalt: pk.prfSalt, timeoutMs: 60_000 });
              try {
                const wrapKey = await deriveKeyFromPrf(this.deps.crypto, prfFirst, pk.hkdfSalt);
                try {
                  return await unwrapSecret(this.deps.crypto, wrapKey, wrapped, aad);
                } catch {
                  throw new SignerFailure("UNLOCK_FAILED", "This passkey could not unlock the trading key.");
                }
              } finally {
                wipe(prfFirst);
              }
            },
          );
        } catch (e) {
          if (e instanceof PasskeyError) throw new SignerFailure(e.code === "unsupported" ? "PASSKEY_UNAVAILABLE" : "PASSKEY_FAILED", e.message, { retryable: e.code !== "unsupported" });
          throw e;
        }
        try {
          this.accountFromSecret(new Uint8Array(secret), rec.agentAddress);
          await this.storeDeviceRecord(meta, secret, rec.confirmedAt);
        } catch (e) {
          if (e instanceof SignerFailure) throw e;
          throw new SignerFailure("STORAGE_FAILED", "The trading key could not be stored on this device.", { retryable: true });
        } finally {
          wipe(secret);
        }
      }
      if (this.key !== key) throw new SignerFailure("KEY_CHANGED", "The trading key changed while changing its protection.", { retryable: true });
      key.meta = { ...key.meta, storageMode: p.to };
      this.log("key.storage_changed", { agent: key.meta.agentAddress, storageMode: p.to });
      this.notifyOtherTabs();
      this.statusChanged();
      return this.status();
    });
  }

  // -------------------------------------------------------------------------------------------
  // revoke
  // -------------------------------------------------------------------------------------------

  private async revoke(p: RevokeParams): Promise<RevokeResult> {
    return await this.withState(async () => {
      const key = this.key;
      const agentName = p.agentName ?? key?.meta.agentName ?? this.config.defaultAgentName;
      const inMemory = key !== null && key.meta.agentName === agentName ? key : null;
      // The stored copy with this name: normally the in-memory key's, or one an earlier revoke could not delete.
      let stored: StoredKeyRecord | undefined;
      try {
        const rec = await this.deps.store.getKeyRecord();
        if (rec && rec.network === this.config.network.name && rec.agentName === agentName) stored = rec;
      } catch {
        stored = undefined;
      }
      const agentAddress: Hex | null = inMemory?.meta.agentAddress ?? stored?.agentAddress ?? null;
      // A key protected with a passkey is deleted only after the user confirms it in the frame.
      if (inMemory?.meta.storageMode === "passkey" || stored?.storageMode === "passkey") await this.confirmKeyRemoval("revoke");
      let wiped = false;
      let wipeError: string | undefined;
      if (inMemory || stored) {
        // Out of memory first: this tab stops signing with it whatever happens to storage.
        if (inMemory) this.setKey(null);
        let deleted = true;
        if (stored || inMemory?.meta.storageMode !== "session") {
          try {
            await this.deps.store.deleteKeyRecord();
          } catch {
            deleted = false;
          }
        }
        if (deleted) {
          wiped = true;
          this.log("key.revoked", { agent: agentAddress ?? "none" });
          this.notifyOtherTabs();
        } else {
          // Not wiped: the stored copy would come back (as it was) after a reload.
          wipeError =
            "The trading key was removed from memory, but its stored copy could not be deleted from this device and would come back after a reload. Post revokeAgent anyway, then call revoke again.";
          this.log("key.revoke_failed", { agent: agentAddress ?? "none" });
        }
      }
      const revokeAgent = buildRevokeAgent({
        agentName,
        nonce: this.correctedNow(),
        network: this.config.network,
        ...(p.signatureChainId !== undefined ? { signatureChainId: p.signatureChainId } : {}),
      });
      if (inMemory || wiped) this.statusChanged();
      return { wiped, agentAddress, agentName, revokeAgent, ...(wipeError !== undefined ? { wipeError } : {}), status: this.status() };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Limits
  // -------------------------------------------------------------------------------------------

  /**
   * The state for a stored record. Each account's limits are checked again against this build's baseline; a field that
   * no longer fits is dropped, so the baseline's own, stricter value applies.
   */
  private limitsState(rec: StoredLimitsRecord | undefined): LimitsState {
    const rev = limitsRev(rec);
    const valid = isRecord(rec) && rec.network === this.config.network.name;
    const accounts = new Map<string, AccountLimits>();
    if (valid && isRecord(rec.accounts)) {
      for (const [address, raw] of Object.entries(rec.accounts)) {
        const limits = /^0x[0-9a-f]{40}$/.test(address) ? storedUserLimits(this.baseline, raw) : null;
        if (limits !== null && accounts.size < MAX_ACCOUNT_LIMITS) accounts.set(address, { limits });
      }
    }
    return this.withPolicy(rev, valid ? storedUserLimits(this.baseline, rec.master) : null, accounts);
  }

  private withPolicy(rev: number, master: UserLimits | null, accounts: Map<string, AccountLimits>): LimitsState {
    const r = applyUserLimits(this.baseline, master ?? {}, { tradingCoins: this.market.tradingPairCoins });
    // Never: stored limits are checked against the baseline when they are read and before they are written.
    if (!r.ok) throw new Error("limits outside the baseline");
    return { rev, master, accounts, policy: r.policy };
  }

  /**
   * Reads the user's limits from storage (another tab may have changed them) and reports them in `status()`, once this
   * tab's `setLimits` calls received so far have compared and written theirs (a prompt waiting for the user doesn't
   * hold them up), so a request sent after a tightening sees it. A read that fails throws STORAGE_FAILED: the frame
   * signs nothing on limits it can't read.
   */
  private async readLimits(): Promise<LimitsState> {
    await this.tails.limits;
    return await this.readStoredLimits();
  }

  /** `readLimits` without waiting for this tab's `setLimits` calls (used inside them). */
  private async readStoredLimits(): Promise<LimitsState> {
    const order = ++this.limitsOrder;
    let rec: StoredLimitsRecord | undefined;
    try {
      rec = await this.deps.store.getLimits(this.config.network.name);
    } catch {
      throw new SignerFailure("STORAGE_FAILED", "Your limits could not be read on this device; nothing was changed or signed.", { retryable: true });
    }
    const state = this.limitsState(rec);
    this.showLimits(state, order);
    return state;
  }

  /** `readLimits` for `status()` only: when the read fails, the status keeps the limits last read. */
  private async refreshLimits(): Promise<void> {
    try {
      await this.readLimits();
    } catch {
      // Signing reads them again and fails closed.
    }
  }

  /** Makes `state` what `status()` reports, unless a newer read or write already did; emits statusChanged on a change. */
  private showLimits(state: LimitsState, order: number): void {
    if (order <= this.limitsShownOrder) return;
    this.limitsShownOrder = order;
    const changed = limitsKey(state) !== limitsKey(this.limits);
    this.limits = state;
    if (changed) this.emit("statusChanged", this.status());
  }

  /**
   * Sets the master's or a sub-account's limits. They are stored on the signer origin, per network: they hold across
   * reloads and in every tab, with or without a key. Each value is checked against the baseline first; then the
   * change is compared with the limits stored now ({@link limitChanges}):
   * - identical limits change nothing (the app sends them again at every handshake);
   * - a change that only tightens is applied at once;
   * - anything that loosens is applied only after the user's click on the frame's own prompt, which lists every change.
   *   Cancel or timeout: USER_CANCELLED / USER_TIMEOUT, and nothing changes. A second loosening in this tab waits for
   *   the first prompt to close, then compares again and shows its own.
   * The write is a compare-and-set on the stored revision. If another tab changed the limits meanwhile, the change is
   * compared again with the new limits; a loosening the user confirmed against older limits is refused (SIGNER_BUSY,
   * retryable) rather than applied to limits the prompt didn't show.
   */
  private async setLimits(p: SetLimitsParams): Promise<SetLimitsResult> {
    const { account, ...limits } = p;
    // Sub-account limits belong to a key's user: without a key there is no master to tell a sub-account from (limits
    // meant for the master would be stored as a sub-account's, and the master would trade on the baseline).
    if (account !== undefined && !this.key) throw new SignerFailure("NO_KEY", "Create or unlock a trading key before setting an account's limits.");
    const r = applyUserLimits(this.baseline, limits, { tradingCoins: this.market.tradingPairCoins });
    if (!r.ok) throw new SignerFailure("LIMIT_LOOSENING_REJECTED", r.message, { details: { fields: r.fields } });
    const lower = account?.toLowerCase();
    const sub = lower === undefined || lower === this.key?.meta.userAddress.toLowerCase() ? undefined : lower;
    const whose = sub === undefined ? "your limits" : `the limits of sub-account ${sub.slice(0, 6)}…${sub.slice(-4)}`;
    let confirmedRev: number | undefined;
    for (let attempt = 0; attempt < MAX_LIMITS_ATTEMPTS; attempt++) {
      let step = await this.serialized("limits", () => this.limitsStep(sub, r.limits, confirmedRev));
      if (step.kind === "confirm") {
        const { before, changes } = step;
        // One limits prompt at a time in this tab, written before the next one compares; the limits may have changed
        // while this one waited for its turn.
        step = await this.serialized("limitsPrompt", async () => {
          if ((await this.readLimits()).rev !== before.rev) return { kind: "retry" as const };
          await this.prompt(
            "limits",
            {
              title: "Loosen your trading limits?",
              body: `The Kokoah app asks to change ${whose} on this device. Confirm only if you asked for this.\n\n${changes.map((c) => c.text).join("\n")}`,
              actionLabel: "Loosen limits",
              fixedStyle: true,
              hold: true,
            },
            async () => undefined,
          );
          confirmedRev = before.rev;
          return await this.serialized("limits", () => this.limitsStep(sub, r.limits, confirmedRev));
        });
      }
      if (step.kind === "done") return { policy: summarizeFramePolicy(this.limits.policy, this.limits.master, this.limits.accounts, this.market.tradingPairCoins) };
      // Otherwise another tab wrote first, or changed the limits while this prompt waited: compare again.
    }
    throw new SignerFailure("SIGNER_BUSY", "Your limits kept changing in another tab; nothing was changed. Try again.", { retryable: true });
  }

  /**
   * One attempt of `setLimits`, in this tab's limits queue: compares the new limits of the account with the stored
   * ones, then writes them (identical: nothing to write) or asks for the user's confirmation (`confirm`). `confirmedRev`:
   * the revision the user confirmed a loosening against, if any. `retry`: another tab wrote first.
   */
  private async limitsStep(
    sub: string | undefined,
    limits: UserLimits | null,
    confirmedRev: number | undefined,
  ): Promise<{ kind: "done" | "retry" } | { kind: "confirm"; before: LimitsState; changes: LimitChange[] }> {
    const before = await this.readStoredLimits();
    const accounts = new Map(before.accounts);
    if (sub !== undefined) {
      if (limits === null) {
        // `{ account }` alone: the sub-account uses the master's limits again.
        accounts.delete(sub);
      } else {
        if (!accounts.has(sub) && accounts.size >= MAX_ACCOUNT_LIMITS) {
          throw new SignerFailure("INVALID_REQUEST", `At most ${MAX_ACCOUNT_LIMITS} sub-accounts can have their own limits.`);
        }
        // Checked against the baseline; at signing they apply on top of the master's limits of that moment.
        accounts.set(sub, { limits });
      }
    }
    const after = this.withPolicy(before.rev + 1, sub === undefined ? limits : before.master, accounts);
    if (limitsKey(after) === limitsKey(before)) return { kind: "done" };
    const changes = limitChanges(this.baseline, before, after, sub);
    const looser = changes.filter((c) => c.looser);
    if (looser.length > 0 && confirmedRev !== before.rev) {
      if (confirmedRev !== undefined) {
        throw new SignerFailure("SIGNER_BUSY", "Your limits changed in another tab while you were confirming; nothing was changed. Try again.", { retryable: true });
      }
      if (!this.ui) {
        throw new SignerFailure("LIMIT_LOOSENING_REJECTED", "Loosening your limits needs a click in the signer frame, which has no user interface here.", {
          details: { fields: looser.map((c) => c.field) },
        });
      }
      return { kind: "confirm", before, changes };
    }
    const network = this.config.network.name;
    const record: StoredLimitsRecord = {
      slot: limitsSlot(network),
      v: 1,
      network,
      rev: after.rev,
      master: after.master,
      accounts: Object.fromEntries([...after.accounts].map(([a, l]) => [a, l.limits])),
      updatedAt: this.now(),
    };
    let written: boolean;
    try {
      written = await this.deps.store.replaceLimits(record, before.rev);
    } catch {
      throw new SignerFailure("STORAGE_FAILED", "Your limits could not be stored on this device; nothing was changed.", { retryable: true });
    }
    if (!written) return { kind: "retry" };
    this.showLimits(after, ++this.limitsOrder);
    this.log("limits.changed", { reason: looser.length > 0 ? "confirmed" : "tightened", count: changes.length });
    this.notifyOtherTabs("limitsChanged");
    return { kind: "done" };
  }

  // -------------------------------------------------------------------------------------------
  // setTheme
  // -------------------------------------------------------------------------------------------

  private setTheme(p: SetThemeParams): SetThemeResult {
    const bad = invalidThemeVariables(p);
    if (bad.length > 0) throw new SignerFailure("INVALID_REQUEST", `Invalid theme values: ${bad.join(", ")}`, { details: { fields: bad } });
    if (!this.deps.document) return { applied: [] };
    return { applied: applyTheme(this.deps.document, p) };
  }

  // -------------------------------------------------------------------------------------------
  // signAndSubmit
  // -------------------------------------------------------------------------------------------

  private async signAndSubmit(p: SignAndSubmitParams): Promise<SignAndSubmitResult> {
    const fingerprint = stableStringify(p.intent);
    const existing = this.requests.get(p.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new SignerFailure("REQUEST_ID_REUSED", "This requestId was already used for a different intent.", { details: { requestId: p.requestId } });
      }
      const first = await existing.promise;
      return { ...first, replayed: true };
    }
    const entry: RequestEntry = { fingerprint, consumed: false, promise: Promise.resolve(null as unknown as SignAndSubmitResult) };
    entry.promise = this.runSignAndSubmit(p, () => {
      entry.consumed = true;
    });
    this.requests.set(p.requestId, entry);
    this.trimRequests();
    try {
      return await entry.promise;
    } catch (e) {
      // Nothing was sent: the requestId may be used again.
      if (!entry.consumed && this.requests.get(p.requestId) === entry) this.requests.delete(p.requestId);
      throw e;
    }
  }

  private trimRequests(): void {
    if (this.requests.size <= MAX_REMEMBERED_REQUESTS) return;
    for (const id of this.requests.keys()) {
      if (this.requests.size <= MAX_REMEMBERED_REQUESTS) break;
      this.requests.delete(id);
    }
  }

  private requireSigningKey(): LoadedKey & { account: PrivateKeyAccount } {
    const key = this.key;
    if (!key) throw new SignerFailure("NO_KEY", "There is no trading key on this device; enable trading first.");
    const state = this.keyStateOf(key);
    if (state === "expired") {
      this.checkExpiry();
      throw new SignerFailure("KEY_EXPIRED", "The trading key has expired; renew it to keep trading.");
    }
    if (state === "pending") throw new SignerFailure("KEY_PENDING", "The trading key is not confirmed yet; approve it with the main wallet and call confirmAgent.");
    if (!key.account) throw new SignerFailure("LOCKED", "The trading key is locked; call unlock.", { retryable: true });
    return key as LoadedKey & { account: PrivateKeyAccount };
  }

  /**
   * Where a key's usage (nonce, counters, recent HLP deposits and unconfirmed orders) is kept: its master account's
   * record, so a new key the parent has the frame create for the same account keeps the counters. The agent's own
   * record from before stands in until the account's exists.
   */
  private usageKey(key: LoadedKey): UsageKey {
    return { key: `account/${this.config.network.name}/${key.meta.userAddress.toLowerCase()}`, legacy: key.meta.agentAddress };
  }

  private async runSignAndSubmit(p: SignAndSubmitParams, markConsumed: () => void): Promise<SignAndSubmitResult> {
    if (!isWriteAllowed(this.config.network)) throw new SignerFailure("MAINNET_WRITES_DISABLED", "This frame build does not allow mainnet writes.");
    const key = this.requireSigningKey();
    if (isAccountIntentKind(p.intent)) return await this.runAccountAction(p, key, markConsumed);

    // 1. Validate the intent (strict: unknown keys, prices from the parent, builder fields… are all rejected).
    const parsed = safeParseActionIntent(p.intent);
    if (!parsed.success) throw new SignerFailure("INVALID_INTENT", "The intent is not valid.", { details: { issues: parsed.issues.slice(0, 20) } });
    const intent: ActionIntent = parsed.intent;
    if (addsRisk(intent)) await this.requireRegion();

    // 1b. Acting for a sub-account: the frame checks on HL itself that it belongs to this key's master (cached
    // briefly). Anything else (a vault the master leads, another user's account) is denied by the policy below.
    const master = key.meta.userAddress.toLowerCase() as `0x${string}`;
    const vault = intent.vaultAddress?.toLowerCase() as `0x${string}` | undefined;
    let ownedSubAccount: `0x${string}` | undefined;
    if (vault !== undefined) {
      try {
        if (await this.subAccounts.isOwned(master, vault)) ownedSubAccount = vault;
      } catch (e) {
        if (e instanceof SubAccountLookupError) {
          throw new SignerFailure("MARKET_DATA_UNAVAILABLE", "Could not read your sub-accounts from Hyperliquid; nothing was signed. Try again shortly.", { retryable: true });
        }
        throw e;
      }
    }
    const account = vault ?? master;
    // The user's limits as stored now; read again under the agent lock below.
    const stored = await this.readLimits();

    // 2. The frame's own clock, market metadata and prices.
    await this.ensureClock();
    const coins = intentCoins({ intent });
    let snapshot = await this.marketSnapshot(coins);

    // 3. Compile with the configured builder and the frame's own mid prices.
    let compiled: CompiledAction;
    try {
      compiled = compileAction(intent, {
        registry: snapshot.registry,
        builder: { address: this.config.builder.address, feeTenthsBps: builderFeeAt(this.config.builder, this.correctedNow()) },
        getMidPrice: (coin) => snapshot.midPrices[coin],
        now: this.correctedNow(),
      });
    } catch (e) {
      if (e instanceof CompileError) {
        if (e.code === "LEVERAGE_ABOVE_MAX") {
          this.metrics.policyDenials++;
          throw new SignerFailure("POLICY_DENIED", "The action is not allowed by the signer policy.", { details: { violations: [{ code: "LEVERAGE_EXCEEDED", message: e.message }] } });
        }
        if (e.code === "MISSING_MID_PRICE") throw new SignerFailure("MARKET_DATA_UNAVAILABLE", e.message, { retryable: true });
        throw new SignerFailure(e.code === "INVALID_INTENT" ? "INVALID_INTENT" : "COMPILE_FAILED", e.message, { details: { compileCode: e.code } });
      }
      throw e;
    }

    // 3b. Mainnet: on a HIP-3 dex that isn't pinned or has a new deployer (shared perpDexs.ts; the deployer sets the
    // mark the price band trusts), only cancels and reduce-only orders, so the user can always leave such a dex.
    const requirePinnedDexes = () => {
      for (const leg of hip3PinnedLegs(compiled.action as unknown as Record<string, unknown>, snapshot.registry)) {
        const problem = snapshot.dexProblems[leg.dex];
        if (problem !== undefined) throw new SignerFailure("UNSUPPORTED_MARKET", problem);
      }
    };
    requirePinnedDexes();

    // 4. The account's current leverage, only needed when the cap (the baseline's or the user's) is below a market's own
    // maximum: Hyperliquid itself keeps leverage within that.
    const opensExposure = (intent.kind === "order" && !intent.reduceOnly) || (intent.kind === "modify" && !intent.order.reduceOnly);
    const needsLeverage = (limits: LimitsState) => {
      const cap = policyForAccount(limits.policy, limits.accounts, vault, this.market.tradingPairCoins).maxLeverage;
      return opensExposure && coins.some((coin) => (snapshot.registry.get(coin)?.maxLeverage ?? 0) > cap);
    };
    let leverageByCoin = needsLeverage(stored) ? await this.accountLeverage(account, coins, snapshot) : undefined;

    // 4a. Where the account's limits require a stop-loss: its positions and resting orders, read from HL by the frame
    // itself right before each check, so a cancel or modify can't take a stop-loss away from a position and an entry
    // can't leave the position it adds to partly covered (shared stopCoverage.ts).
    const touchesStops =
      intent.kind === "cancel" || intent.kind === "modify" || (intent.kind === "order" && !intent.reduceOnly && snapshot.registry.get(intent.coin)?.kind !== "spot");
    const bookFor = async (accountPolicy: Policy) => (touchesStops && accountPolicy.requireStopLossForNewEntries ? await this.accountBook(account, intent) : undefined);

    const agent = key.meta.agentAddress;
    const usageKey = this.usageKey(key);
    const generation = key.generation;
    const action = compiled.action as unknown as Record<string, unknown>;

    // The policy on the exact action, with `limits` and this agent's usage at `now`.
    const evaluate = async (limits: LimitsState, now: number) => {
      const accountPolicy = policyForAccount(limits.policy, limits.accounts, vault, this.market.tradingPairCoins);
      const expiresAfter = now + EXPIRES_AFTER_MS;
      // Sub-accounts without a daily limit of their own share the master's daily limit and counter.
      const usageAccount = { account, master, separate: separateDailyAccounts(limits.accounts) };
      const usage = await this.coordinator.usage(usageKey, now, usageAccount);
      const accountBook = await bookFor(accountPolicy);
      const decision = evaluateFramePolicy({
        compiled,
        expiresAfter,
        now,
        policy: accountPolicy,
        registry: snapshot.registry,
        markPrices: snapshot.markPrices,
        midPrices: snapshot.midPrices,
        ordersInLastMinute: usage.ordersInLastMinute,
        dailyNotionalUsedUsd: usage.accountDailyNotionalUsd,
        agentDailyNotionalUsedUsd: usage.dailyNotionalUsedUsd,
        ...(leverageByCoin !== undefined ? { leverageByCoin } : {}),
        ...(ownedSubAccount !== undefined ? { ownedSubAccount } : {}),
        network: this.config.network.name,
        verifiedSpotCoins: snapshot.verifiedSpotCoins,
        spotDayVolumes: snapshot.spotDayVolumes,
        ...(accountBook !== undefined ? { accountBook } : {}),
      });
      if (!decision.allowed) {
        this.metrics.policyDenials++;
        this.log("sign.denied", { actionType: decision.actionType, codes: decision.violations.map((v) => v.code).join(",") });
        throw new SignerFailure("POLICY_DENIED", "The action is not allowed by the signer policy.", { details: { violations: decision.violations } });
      }
      return { decision, accountPolicy, usageAccount, expiresAfter };
    };

    // 4b. Orders above CONFIRM_ORDERS_ABOVE_USD in all (reduce-only ones included), or that would take what this account
    // signed without a prompt above CONFIRM_UNPROMPTED_ABOVE_USD in the last 10 minutes or
    // CONFIRM_UNPROMPTED_DAY_ABOVE_USD in the last 24 hours, wait for the user's confirmation of the frame's own
    // description of them; so does taking margin out of an isolated position. Checked first, so the user is never asked
    // to confirm something the rules refuse; after the prompt (up to two minutes) the prices, dexes and leverage are read
    // again for the check under the lock.
    const orders = describeOrders(action, snapshot.registry, snapshot.markPrices, compiled.marketOrder !== undefined);
    const recent = orders.totalUsd > 0 ? await this.coordinator.usage(usageKey, this.correctedNow()) : undefined;
    const large = orders.totalUsd > CONFIRM_ORDERS_ABOVE_USD;
    // The total the prompt shows: the 10 minutes' when they pass their limit, else the day's when it does.
    const addsUp =
      recent === undefined
        ? undefined
        : recent.unpromptedUsd + orders.totalUsd > CONFIRM_UNPROMPTED_ABOVE_USD
          ? { usd: recent.unpromptedUsd, windowMs: UNPROMPTED_WINDOW_MS }
          : recent.unpromptedDayUsd + orders.totalUsd > CONFIRM_UNPROMPTED_DAY_ABOVE_USD
            ? { usd: recent.unpromptedDayUsd, windowMs: UNPROMPTED_DAY_MS }
            : undefined;
    const marginOut = intent.kind === "updateIsolatedMargin" && Number(intent.amountUsd) < 0 ? { coin: intent.coin, usd: -Number(intent.amountUsd) } : undefined;
    let confirmed = false;
    if (large || addsUp || marginOut) {
      await evaluate(stored, this.correctedNow());
      if (marginOut) await this.confirmMarginRemoval(marginOut, snapshot, compiled.vaultAddress);
      else await this.confirmOrders(orders, compiled.vaultAddress, addsUp);
      confirmed = true;
      snapshot = await this.marketSnapshot(coins);
      requirePinnedDexes();
      leverageByCoin = undefined;
    }

    // 5. Serialize per agent across tabs; policy, nonce, sign and submit under the lock.
    return await this.coordinator.withAgentLock(agent, async () => {
      const current = this.key;
      if (!current || current.generation !== generation || !current.account) {
        throw new SignerFailure("KEY_CHANGED", "The trading key changed or was locked before signing.", { retryable: true });
      }
      // The user's limits again, under the lock: a change made in another tab since binds this signature.
      const limits = await this.readLimits();
      if (leverageByCoin === undefined && needsLeverage(limits)) leverageByCoin = await this.accountLeverage(account, coins, snapshot);
      const now = this.correctedNow();
      if (this.keyStateOf(current, now) !== "active") throw new SignerFailure("KEY_EXPIRED", "The trading key has expired; renew it to keep trading.");
      const { decision, accountPolicy, usageAccount, expiresAfter } = await evaluate(limits, now);

      let nonce: number;
      try {
        nonce = await this.coordinator.reserve(usageKey, {
          now,
          orders: orderCount(action),
          notionalUsd: actionNotionalUsd(action, snapshot.registry, snapshot.markPrices),
          account: usageAccount,
          limits: {
            maxOrdersPerMinute: accountPolicy.maxOrdersPerMinute,
            maxActionsPerMinute: BASELINE_LIMITS.maxActionsPerMinute,
            maxDailyNotionalUsd: accountPolicy.maxDailyNotionalUsd,
            maxAgentDailyNotionalUsd: BASELINE_LIMITS.maxDailyNotionalUsd,
          },
          // Checked again in the record's own transaction: another tab may have signed orders since the check above. A
          // confirmation whose prompt showed the unconfirmed total of a window starts that window again (the orders in
          // it); one that didn't leaves it, and older orders stay counted in the 24 hours.
          unprompted: {
            usd: orders.totalUsd,
            confirmed,
            clears: confirmed && addsUp !== undefined ? addsUp.windowMs : false,
            maxUsd: CONFIRM_UNPROMPTED_ABOVE_USD,
            maxDayUsd: CONFIRM_UNPROMPTED_DAY_ABOVE_USD,
          },
        });
      } catch (e) {
        if (e instanceof UsageLimitError) {
          this.metrics.policyDenials++;
          throw new SignerFailure("POLICY_DENIED", "The action is not allowed by the signer policy.", { details: { violations: [{ code: e.code, message: e.message }] } });
        }
        if (e instanceof ConfirmationNeededError) throw new SignerFailure("SIGNER_BUSY", e.message, { retryable: true });
        if (e instanceof RangeError) throw new SignerFailure("INTERNAL_ERROR", "Could not produce a valid nonce; check the device clock.");
        throw new SignerFailure("STORAGE_FAILED", "Could not reserve a nonce on this device.", { retryable: true });
      }

      // Signs exactly `compiled.action` (the object the policy evaluated), for the master or the verified sub-account.
      const signFor = ownedSubAccount !== undefined && compiled.vaultAddress?.toLowerCase() === ownedSubAccount ? { vaultAddress: ownedSubAccount } : {};
      const body = await prepareL1Request({ wallet: current.account, network: this.config.network, compiled: { action: compiled.action, ...signFor }, nonce, expiresAfter });

      markConsumed();
      this.metrics.submitted++;
      this.log("sign.submitted", { actionType: decision.actionType, agent });
      const transport = await this.hl.exchange(body);
      const result = this.buildResult(p.requestId, decision.actionType, nonce, expiresAfter, compiled, transport, orderCount(action));
      this.log("sign.result", { status: result.status, actionType: result.actionType, ...(result.error ? { code: result.error.code } : {}) });
      if (result.error && (result.error.code === "INVALID_NONCE" || result.error.code === "ACTION_EXPIRED")) void this.syncClock();
      return result;
    });
  }

  /**
   * `setReferrer` and `startFeeTrial` for the key's master account. The referral code is the frame's own
   * (`VITE_HL_REFERRAL_CODE`); for `setReferrer` the frame also reads HL `referral` itself and signs only while no
   * referrer is set, and at most once per key (recorded with the nonce, in the same IndexedDB transaction). For
   * `startFeeTrial` the frame reads HL `userFees` itself: the tier's rates come from that fee schedule, and nothing is
   * signed while a trial runs or before `nextTrialAvailableTimestamp`.
   */
  private async runAccountAction(p: SignAndSubmitParams, key: LoadedKey & { account: PrivateKeyAccount }, markConsumed: () => void): Promise<SignAndSubmitResult> {
    const parsed = safeParseAccountIntent(p.intent);
    if (!parsed.success) throw new SignerFailure("INVALID_INTENT", "The intent is not valid.", { details: { issues: parsed.issues.slice(0, 20) } });
    const intent: AccountIntent = parsed.intent;
    // Taking money out of a vault only lowers risk; everything else here (a deposit, the referrer, a fee trial) waits for
    // the region check.
    if (intent.kind !== "vaultWithdraw") await this.requireRegion();
    if (intent.kind === "hlpDeposit" || intent.kind === "vaultWithdraw") return await this.runVaultTransfer(p, key, intent, markConsumed);
    const master = key.meta.userAddress.toLowerCase() as `0x${string}`;
    const deny = (message: string): never => {
      this.metrics.policyDenials++;
      this.log("sign.denied", { actionType: intent.kind, codes: "REFERRER_ACTION_DENIED" });
      throw new SignerFailure("POLICY_DENIED", "The action is not allowed by the signer policy.", { details: { violations: [{ code: "REFERRER_ACTION_DENIED", message }] } });
    };
    await this.ensureClock();

    // The fee schedule and trial state, read by the frame itself (never from the parent).
    let feeTiers: Array<{ cross: string; add: string }> | undefined;
    if (intent.kind === "startFeeTrial") {
      const fees = await this.readInfo({ type: "userFees", user: master }, "Could not read your fee tier from Hyperliquid; nothing was signed. Try again shortly.");
      const vip = isRecord(fees) && isRecord(fees.feeSchedule) && isRecord(fees.feeSchedule.tiers) ? fees.feeSchedule.tiers.vip : undefined;
      if (!isRecord(fees) || !("trial" in fees) || !Array.isArray(vip) || !vip.every((t) => isRecord(t) && typeof t.cross === "string" && typeof t.add === "string")) {
        throw new SignerFailure("MARKET_DATA_UNAVAILABLE", "Hyperliquid's fee schedule was unreadable; nothing was signed. Try again shortly.", { retryable: true });
      }
      const next = fees.nextTrialAvailableTimestamp;
      const unavailable =
        fees.trial !== null
          ? "A fee trial is already running on this account."
          : typeof next === "number" && next > this.correctedNow()
            ? "The next fee trial is not available yet (one every 90 days)."
            : next !== null && next !== undefined && typeof next !== "number"
              ? "Hyperliquid's fee trial state was unreadable."
              : null;
      if (unavailable) {
        this.metrics.policyDenials++;
        this.log("sign.denied", { actionType: intent.kind, codes: "FEE_TRIAL_UNAVAILABLE" });
        throw new SignerFailure("POLICY_DENIED", "The action is not allowed by the signer policy.", { details: { violations: [{ code: "FEE_TRIAL_UNAVAILABLE", message: unavailable }] } });
      }
      feeTiers = vip as Array<{ cross: string; add: string }>;
    }

    let compiled: CompiledAccountAction;
    try {
      compiled = compileAccountAction(intent, { referralCode: this.config.referralCode, ...(feeTiers ? { feeTiers } : {}) });
    } catch (e) {
      if (e instanceof CompileError && intent.kind === "setReferrer") deny("This signer has no Kokoah referral code configured.");
      if (e instanceof CompileError) throw new SignerFailure("COMPILE_FAILED", e.message, { details: { compileCode: e.code } });
      throw e;
    }

    // The account's referrer, read by the frame itself (never from the parent). Unreadable: nothing is signed.
    let alreadyReferred = false;
    if (intent.kind === "setReferrer") {
      const r = await this.readInfo({ type: "referral", user: master }, "Could not read the account's referrer from Hyperliquid; nothing was signed. Try again shortly.");
      if (!isRecord(r) || !("referredBy" in r)) {
        throw new SignerFailure("MARKET_DATA_UNAVAILABLE", "Could not read the account's referrer from Hyperliquid; nothing was signed. Try again shortly.", { retryable: true });
      }
      alreadyReferred = r.referredBy !== null;
      // Hyperliquid takes a referral code only in an account's first $10,000 of volume (its app's rule).
      if (!alreadyReferred && Number(r.cumVlm) > REFERRAL_MAX_VOLUME_USD) deny("Hyperliquid accepts a referral code only in an account's first $10,000 of volume.");
    }

    const agent = key.meta.agentAddress;
    const usageKey = this.usageKey(key);
    const generation = key.generation;
    return await this.coordinator.withAgentLock(agent, async () => {
      const current = this.key;
      if (!current || current.generation !== generation || !current.account) {
        throw new SignerFailure("KEY_CHANGED", "The trading key changed or was locked before signing.", { retryable: true });
      }
      const now = this.correctedNow();
      if (this.keyStateOf(current, now) !== "active") throw new SignerFailure("KEY_EXPIRED", "The trading key has expired; renew it to keep trading.");
      const expiresAfter = now + EXPIRES_AFTER_MS;
      const referrer = intent.kind === "setReferrer" ? { alreadyReferred, signedBefore: await this.coordinator.referrerSigned(usageKey) } : undefined;
      // The master's limits as stored now (another tab may have changed them).
      const { policy } = await this.readLimits();
      const decision = evaluateFrameAccountPolicy({ compiled, expiresAfter, now, policy, ...(referrer ? { referrer } : {}) });
      if (!decision.allowed) {
        this.metrics.policyDenials++;
        this.log("sign.denied", { actionType: decision.actionType, codes: decision.violations.map((v) => v.code).join(",") });
        throw new SignerFailure("POLICY_DENIED", "The action is not allowed by the signer policy.", { details: { violations: decision.violations } });
      }

      let nonce: number;
      try {
        nonce = await this.coordinator.reserve(usageKey, {
          now,
          orders: 0,
          notionalUsd: 0,
          account: { account: master, master },
          referrer: intent.kind === "setReferrer",
          limits: { maxOrdersPerMinute: Infinity, maxActionsPerMinute: BASELINE_LIMITS.maxActionsPerMinute, maxDailyNotionalUsd: Infinity, maxAgentDailyNotionalUsd: Infinity },
        });
      } catch (e) {
        if (e instanceof UsageLimitError) deny(e.message);
        // Another tab signed it between the check and the reservation.
        if (e instanceof ReferrerAlreadySignedError) deny(e.message);
        if (e instanceof RangeError) throw new SignerFailure("INTERNAL_ERROR", "Could not produce a valid nonce; check the device clock.");
        throw new SignerFailure("STORAGE_FAILED", "Could not reserve a nonce on this device.", { retryable: true });
      }

      // Signs exactly `compiled.action` (the object the policy evaluated), for the master account.
      const body = await prepareL1Request({ wallet: current.account, network: this.config.network, compiled: { action: compiled.action }, nonce, expiresAfter });
      markConsumed();
      this.metrics.submitted++;
      this.log("sign.submitted", { actionType: decision.actionType, agent });
      const transport = await this.hl.exchange(body);
      const result = this.buildResult(p.requestId, decision.actionType, nonce, expiresAfter, { cloids: [] }, transport, 0);
      this.log("sign.result", { status: result.status, actionType: result.actionType, ...(result.error ? { code: result.error.code } : {}) });
      if (result.error && (result.error.code === "INVALID_NONCE" || result.error.code === "ACTION_EXPIRED")) void this.syncClock();
      return result;
    });
  }

  /**
   * A vault transfer, the one fund movement a trading key may make (shared `vaults/hlp.ts`; product owner,
   * 2026-10-05). A deposit goes into HLP only (the frame's own address for its network, never one from the parent),
   * within 10,000 USDC per deposit and 25,000 per 24 hours counted from Hyperliquid's own ledger, and only after the
   * user confirms the frame's own description of it (amount and 4-day lock-up) with a click in the frame. A withdrawal
   * comes from a vault the frame reads on Hyperliquid that the account holds, up to its equity there, back into the
   * account. Facts Hyperliquid can't give sign nothing.
   */
  private async runVaultTransfer(
    p: SignAndSubmitParams,
    key: LoadedKey & { account: PrivateKeyAccount },
    intent: Extract<AccountIntent, { kind: "hlpDeposit" | "vaultWithdraw" }>,
    markConsumed: () => void,
  ): Promise<SignAndSubmitResult> {
    const master = key.meta.userAddress.toLowerCase() as `0x${string}`;
    const network = this.config.network.name;
    const hlp = HLP_VAULT_ADDRESSES[network];
    await this.ensureClock();

    let compiled: CompiledAccountAction;
    try {
      compiled = compileAccountAction(intent, { hlpVaultAddress: hlp });
    } catch (e) {
      if (e instanceof CompileError) throw new SignerFailure(e.code === "INVALID_INTENT" ? "INVALID_INTENT" : "COMPILE_FAILED", e.message, { details: { compileCode: e.code } });
      throw e;
    }
    const action = compiled.action as { type: "vaultTransfer"; vaultAddress: `0x${string}`; isDeposit: boolean; usd: number };
    const usdText = vaultUnitsToUsd(action.usd);
    const agent = key.meta.agentAddress;
    const usageKey = this.usageKey(key);
    // HLP deposits this browser signed in the last few minutes, every tab's (the usage record): the ledger can lag.
    let recentDepositsUsd = 0;

    // What the rules need, read by the frame itself for the master (never from the parent).
    const facts = async (now: number): Promise<{ network: typeof network; hlpDepositedLast24hUsd?: number; heldEquityUsd?: number }> => {
      if (action.isDeposit) {
        const since = now - 24 * 60 * 60 * 1000;
        const ledger = await this.readInfo({ type: "userNonFundingLedgerUpdates", user: master, startTime: since }, "Could not read today's HLP deposits from Hyperliquid; nothing was signed. Try again shortly.");
        let fromLedger: number;
        try {
          fromLedger = vaultDepositsSince(ledger, hlp, since);
        } catch {
          throw new SignerFailure("MARKET_DATA_UNAVAILABLE", "Hyperliquid's ledger was unreadable; nothing was signed. Try again shortly.", { retryable: true });
        }
        try {
          recentDepositsUsd = await this.coordinator.recentHlpDepositsUsd(usageKey, master, now);
        } catch {
          throw new SignerFailure("STORAGE_FAILED", "Could not read this browser's recent HLP deposits; nothing was signed.", { retryable: true });
        }
        return { network, hlpDepositedLast24hUsd: fromLedger + recentDepositsUsd };
      }
      const equities = await this.readInfo({ type: "userVaultEquities", user: master }, "Could not read your vaults from Hyperliquid; nothing was signed. Try again shortly.");
      if (!Array.isArray(equities)) throw new SignerFailure("MARKET_DATA_UNAVAILABLE", "Hyperliquid's vault list was unreadable; nothing was signed. Try again shortly.", { retryable: true });
      const held = equities.find((v) => isRecord(v) && typeof v.vaultAddress === "string" && v.vaultAddress.toLowerCase() === action.vaultAddress);
      const equity = isRecord(held) ? Number(held.equity) : undefined;
      return { network, ...(equity !== undefined && Number.isFinite(equity) ? { heldEquityUsd: equity } : {}) };
    };
    // The master's limits decide whether vault transfers are on at all (`vaultTransfer` in `allowedActionTypes`).
    const decide = (now: number, vault: Awaited<ReturnType<typeof facts>>, limits: LimitsState) => {
      const expiresAfter = now + EXPIRES_AFTER_MS;
      const decision = evaluateFrameAccountPolicy({ compiled, expiresAfter, now, policy: limits.policy, vault, vaultTransfersAllowed: vaultTransfersAllowed(limits.master) });
      if (!decision.allowed) {
        this.metrics.policyDenials++;
        this.log("sign.denied", { actionType: decision.actionType, codes: decision.violations.map((v) => v.code).join(",") });
        throw new SignerFailure("POLICY_DENIED", "The action is not allowed by the signer policy.", { details: { violations: decision.violations } });
      }
      return { decision, expiresAfter };
    };

    // Checked before asking, so the user is never asked to confirm something the rules refuse.
    decide(this.correctedNow(), await facts(this.correctedNow()), await this.readLimits());
    if (action.isDeposit) {
      await this.prompt(
        "vault-deposit",
        {
          title: "Deposit into HLP",
          body:
            `Move ${usdText} USDC from your Hyperliquid account into HLP, Hyperliquid's own vault. ` +
            `You can withdraw it ${HLP_LOCKUP_DAYS} days after this deposit. HLP can lose money.`,
          actionLabel: `Deposit ${usdText} USDC`,
          fixedStyle: true,
          hold: true,
        },
        async () => undefined,
      );
    } else {
      const vault = action.vaultAddress;
      await this.prompt(
        "vault-withdraw",
        {
          title: "Withdraw from a vault",
          body: `Move ${usdText} USDC from vault ${vault.slice(0, 6)}…${vault.slice(-4)} back into your Hyperliquid account. Confirm only if you asked for this.`,
          actionLabel: `Withdraw ${usdText} USDC`,
          fixedStyle: true,
          hold: true,
        },
        async () => undefined,
      );
    }

    const generation = key.generation;
    return await this.coordinator.withAgentLock(agent, async () => {
      const current = this.key;
      if (!current || current.generation !== generation || !current.account) {
        throw new SignerFailure("KEY_CHANGED", "The trading key changed or was locked before signing.", { retryable: true });
      }
      const now = this.correctedNow();
      if (this.keyStateOf(current, now) !== "active") throw new SignerFailure("KEY_EXPIRED", "The trading key has expired; renew it to keep trading.");
      // Read again under the lock: another tab or device may have deposited, or changed the limits, while the prompt was open.
      const { decision, expiresAfter } = decide(now, await facts(now), await this.readLimits());

      let nonce: number;
      try {
        nonce = await this.coordinator.reserve(usageKey, {
          now,
          orders: 0,
          notionalUsd: 0,
          account: { account: master, master },
          limits: { maxOrdersPerMinute: Infinity, maxActionsPerMinute: BASELINE_LIMITS.maxActionsPerMinute, maxDailyNotionalUsd: Infinity, maxAgentDailyNotionalUsd: Infinity },
          // Recorded with the nonce, for every tab's next cap check.
          ...(action.isDeposit ? { hlpDeposit: { master, usd: action.usd / 1e6, countedUsd: recentDepositsUsd } } : {}),
        });
      } catch (e) {
        if (e instanceof UsageLimitError) {
          this.metrics.policyDenials++;
          throw new SignerFailure("POLICY_DENIED", "The action is not allowed by the signer policy.", { details: { violations: [{ code: e.code, message: e.message }] } });
        }
        if (e instanceof RangeError) throw new SignerFailure("INTERNAL_ERROR", "Could not produce a valid nonce; check the device clock.");
        throw new SignerFailure("STORAGE_FAILED", "Could not reserve a nonce on this device.", { retryable: true });
      }

      // Signs exactly `compiled.action` (the object the rules checked), for the master account.
      const body = await prepareL1Request({ wallet: current.account, network: this.config.network, compiled: { action: compiled.action }, nonce, expiresAfter });
      markConsumed();
      this.metrics.submitted++;
      this.log("sign.submitted", { actionType: decision.actionType, agent });
      const transport = await this.hl.exchange(body);
      const result = this.buildResult(p.requestId, decision.actionType, nonce, expiresAfter, { cloids: [] }, transport, 0);
      this.log("sign.result", { status: result.status, actionType: result.actionType, ...(result.error ? { code: result.error.code } : {}) });
      if (result.error && (result.error.code === "INVALID_NONCE" || result.error.code === "ACTION_EXPIRED")) void this.syncClock();
      return result;
    });
  }

  /** The frame's own market data for `coins` (HL's metadata and prices); HL's failures map to the frame's errors. */
  private async marketSnapshot(coins: readonly string[]): Promise<MarketSnapshot> {
    try {
      return await this.market.snapshotFor(coins);
    } catch (e) {
      if (e instanceof MarketDataError) {
        if (e.code === "UNSUPPORTED_MARKET") throw new SignerFailure("UNSUPPORTED_MARKET", e.message);
        if (e.code === "UNKNOWN_DEX") throw new SignerFailure("COMPILE_FAILED", e.message, { details: { compileCode: "UNKNOWN_MARKET" } });
        throw new SignerFailure("MARKET_DATA_UNAVAILABLE", "Market data from Hyperliquid is unavailable; try again shortly.", { retryable: true });
      }
      throw e;
    }
  }

  /**
   * The frame's own prompt for orders above CONFIRM_ORDERS_ABOVE_USD, or past the rolling total of orders signed
   * without a prompt (`recent`: that total's notional and window, 10 minutes or 24 hours) (`promptChanged` kind
   * `order`, fixed styling): one line per order as the frame will sign it, and the total; confirmed by pressing and
   * holding. Cancel or timeout: USER_CANCELLED / USER_TIMEOUT, and nothing is signed. A frame without a UI can't ask,
   * so it refuses them.
   */
  private async confirmOrders(orders: OrdersDescription, subAccount: string | undefined, recent?: { usd: number; windowMs: number }): Promise<void> {
    const dollars = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
    const total = dollars(orders.totalUsd);
    const day = recent !== undefined && recent.windowMs >= UNPROMPTED_DAY_MS;
    const window = day ? "24 hours" : `${Math.round(UNPROMPTED_WINDOW_MS / 60_000)} minutes`;
    const limit = day ? CONFIRM_UNPROMPTED_DAY_ABOVE_USD : CONFIRM_UNPROMPTED_ABOVE_USD;
    if (!this.ui) {
      this.metrics.policyDenials++;
      const message =
        recent === undefined
          ? `Orders of more than $${CONFIRM_ORDERS_ABOVE_USD.toLocaleString("en-US")} (${total} here) need your confirmation in the signer frame, which has no user interface here.`
          : `Orders past $${limit.toLocaleString("en-US")} in ${window} without a confirmation (${dollars(recent.usd)} so far, ${total} here) need your confirmation in the signer frame, which has no user interface here.`;
      throw new SignerFailure("POLICY_DENIED", "The action is not allowed by the signer policy.", { details: { violations: [{ code: "ORDER_NOTIONAL_EXCEEDED", message }] } });
    }
    const one = orders.lines.length === 1;
    const sub = subAccount?.toLowerCase();
    const whose = sub === undefined ? "" : ` for sub-account ${sub.slice(0, 6)}…${sub.slice(-4)}`;
    const why = recent === undefined ? "" : ` Orders of about ${dollars(recent.usd)} went out without a confirmation in the last ${window}, so ${one ? "this one needs" : "these need"} yours.`;
    await this.prompt(
      "order",
      {
        title: one ? "Confirm this order" : `Confirm these ${orders.lines.length} orders`,
        body: `The Kokoah app asks to send ${one ? "this order" : "these orders"}${whose} to Hyperliquid, about ${total} in all.${why} Confirm only if you placed ${one ? "it" : "them"}.\n\n${orders.lines.join("\n")}`,
        actionLabel: one ? "Send order" : `Send ${orders.lines.length} orders`,
        fixedStyle: true,
        hold: true,
      },
      async () => undefined,
    );
  }

  /**
   * The frame's own prompt before margin is taken out of an isolated position (`promptChanged` kind `margin`, fixed
   * styling, press and hold): it moves the position toward liquidation, which no notional cap covers. Cancel or
   * timeout: USER_CANCELLED / USER_TIMEOUT, and nothing is signed. A frame without a UI can't ask, so it refuses it.
   */
  private async confirmMarginRemoval(margin: { coin: string; usd: number }, snapshot: MarketSnapshot, subAccount: string | undefined): Promise<void> {
    const amount = `$${margin.usd.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
    const market = snapshot.registry.get(margin.coin);
    const name = printable(market?.displayName ?? market?.coin ?? margin.coin);
    if (!this.ui) {
      this.metrics.policyDenials++;
      const message = "Taking margin out of an isolated position needs your confirmation in the signer frame, which has no user interface here.";
      throw new SignerFailure("POLICY_DENIED", "The action is not allowed by the signer policy.", { details: { violations: [{ code: "ACTION_TYPE_NOT_ALLOWED", message }] } });
    }
    const sub = subAccount?.toLowerCase();
    const whose = sub === undefined ? "" : ` of sub-account ${sub.slice(0, 6)}…${sub.slice(-4)}`;
    await this.prompt(
      "margin",
      {
        title: "Take margin out of this position?",
        body: `The Kokoah app asks to take ${amount} of margin out of the isolated ${name} position${whose}. This moves the position closer to liquidation. Confirm only if you asked for this.`,
        actionLabel: `Remove ${amount}`,
        fixedStyle: true,
        hold: true,
      },
      async () => undefined,
    );
  }

  /**
   * The frame's own prompt before a key protected with a passkey is deleted (`revoke`) or replaced by one that unlocks
   * without it (`createAgent` / `createLinkedAgent` with `replaceExisting` and another storage mode): `promptChanged`
   * kind `key-remove`, fixed styling, press and hold. Cancel or timeout: USER_CANCELLED / USER_TIMEOUT, and the key
   * stays.
   */
  private async confirmKeyRemoval(why: "revoke" | "replace"): Promise<void> {
    await this.prompt(
      "key-remove",
      why === "revoke"
        ? {
            title: "Remove the trading key from this device?",
            body: "The Kokoah app asks to delete this device's trading key, which is protected with your passkey. To trade here again you will approve a new key in your wallet. Confirm only if you asked for this.",
            actionLabel: "Remove key",
            fixedStyle: true,
            hold: true,
          }
        : {
            title: "Replace your passkey-protected trading key?",
            body: "The Kokoah app asks to replace this device's trading key, which is protected with your passkey, with a new one that unlocks without your passkey. Confirm only if you asked for this.",
            actionLabel: "Replace key",
            fixedStyle: true,
            hold: true,
          },
      async () => undefined,
    );
  }

  /** The account's current leverage on HL for the perp coins of an action (spot has none), read by the frame itself. */
  private async accountLeverage(account: Hex, coins: readonly string[], snapshot: MarketSnapshot): Promise<Record<string, number>> {
    const leverage: Record<string, number> = {};
    for (const coin of coins.filter((c) => snapshot.registry.get(c)?.kind !== "spot")) {
      let lev: number | undefined;
      try {
        lev = await this.market.leverageFor(account, coin);
      } catch {
        throw new SignerFailure("MARKET_DATA_UNAVAILABLE", "Could not read the account's leverage from Hyperliquid; try again shortly.", { retryable: true });
      }
      if (lev !== undefined) leverage[coin] = lev;
    }
    return leverage;
  }

  /** The account's book for the stop-loss check (accountBook.ts); unreadable: nothing is signed (retryable). */
  private async accountBook(account: Hex, intent: ActionIntent): Promise<FrameAccountBook> {
    try {
      return await readAccountBook((body) => this.hl.info(body), account, intent);
    } catch {
      throw new SignerFailure("MARKET_DATA_UNAVAILABLE", "Could not read your positions and orders from Hyperliquid to check your stop-losses; nothing was signed. Try again shortly.", {
        retryable: true,
      });
    }
  }

  /** An HL `/info` read by the frame itself; a failed read signs nothing (`MARKET_DATA_UNAVAILABLE`, retryable). */
  private async readInfo(body: Record<string, unknown>, message: string): Promise<unknown> {
    try {
      return await this.hl.info(body);
    } catch {
      throw new SignerFailure("MARKET_DATA_UNAVAILABLE", message, { retryable: true });
    }
  }

  private buildResult(
    requestId: string,
    actionType: string,
    nonce: number,
    expiresAfter: number,
    compiled: Pick<CompiledAction, "cloids" | "marketOrder">,
    transport: Awaited<ReturnType<HlHttp["exchange"]>>,
    expectedCount: number,
  ): SignAndSubmitResult {
    const base = {
      requestId,
      actionType,
      nonce,
      expiresAfter,
      cloids: [...compiled.cloids] as Hex[],
      ...(compiled.marketOrder ? { marketOrder: { ...compiled.marketOrder } } : {}),
      replayed: false,
    };
    if (transport.kind === "unknown") {
      const error: OutcomeUnknownError = {
        code: "OUTCOME_UNKNOWN",
        title: "Checking…",
        message: "The request may or may not have reached Hyperliquid. Check the order status by cloid before doing anything else; do not resubmit.",
        retryable: false,
        category: "request",
        raw: transport.reason,
      };
      return { ...base, status: "unknown", exchangeResponse: null, outcome: null, error };
    }
    const body = redactHex64(transport.body);
    const outcome = redactHex64(parseExchangeResponse(body, expectedCount > 0 ? expectedCount : undefined));
    if (outcome.ok) return { ...base, status: "ok", exchangeResponse: body, outcome };
    return { ...base, status: "rejected", exchangeResponse: body, outcome, error: outcome.error };
  }
}

/**
 * Whether signing an action adds risk, so it waits for the region check: a new order or a change of one that isn't
 * reduce-only, and every leverage or isolated-margin change. Cancels, reduce-only orders, a dead man's switch and a noop
 * only lower risk (as the app's `reducesRisk`).
 */
export function addsRisk(intent: ActionIntent): boolean {
  switch (intent.kind) {
    case "order":
      return !intent.reduceOnly;
    case "modify":
      return !intent.order.reduceOnly;
    case "cancel":
    case "scheduleCancel":
    case "noop":
      return false;
    default:
      return true;
  }
}

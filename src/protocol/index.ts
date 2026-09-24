/**
 * Kokoah signer frame protocol, version 1.
 *
 * The frontend (parent window) and the signer frame (iframe on its own origin) talk only through `postMessage`.
 * Every message is a plain, structured-clone-safe object with one of three envelopes:
 *
 * - **request** (parent → frame): `{ protocol, version, kind: "request", id, method, params }`
 * - **response** (frame → parent): `{ protocol, version, kind: "response", id, method, ok: true, result }` or
 *   `{ …, ok: false, error }`
 * - **event** (frame → parent): `{ protocol, version, kind: "event", event, data }`
 *
 * This module is **runtime dependency-free**: it holds constants, types and tiny type guards used by both the frame and
 * `KokoahSignerClient`. Types that describe shared-library shapes are imported from `@kokoah/shared` as types only.
 * The human-readable spec with examples is `docs/PROTOCOL.md`; keep both in sync.
 *
 * @module
 */
import type { ExchangeOutcome, MappedHlError } from "@kokoah/shared/errors";
import type { ActionIntentInput } from "@kokoah/shared/intents";
import type { PolicyViolation } from "@kokoah/shared/policy";
import type { PreparedUserSignedAction } from "@kokoah/shared/signing";

export type { ActionIntentInput, ExchangeOutcome, MappedHlError, PolicyViolation, PreparedUserSignedAction };

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Value of the `protocol` field on every message. */
export const PROTOCOL_NAME = "kokoah-signer" as const;
/** Protocol version implemented by this package. */
export const PROTOCOL_VERSION = 1 as const;
/** Largest accepted request, measured as the length of its JSON serialization (UTF-16 code units). */
export const MAX_MESSAGE_BYTES = 64 * 1024;
/**
 * Default agent name. Named agents only; Kokoah never uses HL's unnamed agent slot. Hyperliquid allows 3 named agents
 * per account and approving a name again replaces that agent, so apps give each device its own name (e.g.
 * `kokoah-a1b2`) to keep one device from replacing another's key.
 */
export const DEFAULT_AGENT_NAME = "kokoah-web";
/** Agent name limit (HL rejects longer names). */
export const MAX_AGENT_NAME_LENGTH = 16;
/** `createAgent.validForDays` bounds. */
export const MIN_VALID_FOR_DAYS = 1;
export const MAX_VALID_FOR_DAYS = 30;
/** The frame emits `keyExpiringSoon` when the key expires within this window. */
export const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;
/** Every signed action carries `expiresAfter = now + EXPIRES_AFTER_MS` (HL's own app uses 15 s). */
export const EXPIRES_AFTER_MS = 15_000;
/** `confirmAgent.timeoutMs` upper bound. */
export const MAX_CONFIRM_TIMEOUT_MS = 60_000;

/** Every request method. */
export const METHODS = [
  "hello",
  "getStatus",
  "createAgent",
  "createLinkedAgent",
  "confirmAgent",
  "unlock",
  "lock",
  "signAndSubmit",
  "setLimits",
  "revoke",
  "setTheme",
  "setStorageMode",
] as const;
export type MethodName = (typeof METHODS)[number];

/** Every event name. */
export const EVENTS = ["ready", "statusChanged", "keyExpiringSoon", "keyExpired", "promptChanged"] as const;
export type EventName = (typeof EVENTS)[number];

/** Theme variables the parent may set with `setTheme` (CSS custom properties on the frame's root element). */
export const THEME_VARIABLES = [
  "--ks-bg",
  "--ks-fg",
  "--ks-muted",
  "--ks-accent",
  "--ks-accent-fg",
  "--ks-danger",
  "--ks-border",
  "--ks-focus",
  "--ks-radius",
  "--ks-font",
  "--ks-font-size",
  "--ks-padding",
] as const;
export type ThemeVariable = (typeof THEME_VARIABLES)[number];

/** Action types the frame's baseline policy allows. `setLimits.allowedActionTypes` may only be a subset. */
export const BASELINE_ACTION_TYPES = [
  "order",
  "cancel",
  "cancelByCloid",
  "modify",
  "batchModify",
  "updateLeverage",
  "updateIsolatedMargin",
  "scheduleCancel",
  "noop",
] as const;
export type AllowedActionType = (typeof BASELINE_ACTION_TYPES)[number];

// ---------------------------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------------------------

export type Hex = `0x${string}`;
export type NetworkName = "testnet" | "mainnet";

/**
 * How the agent key is kept on this device.
 * - `passkey`: encrypted with a key derived from a WebAuthn PRF secret; unlocking needs user verification.
 * - `device`: encrypted with a non-extractable AES-GCM key stored in IndexedDB; survives reloads without a prompt.
 * - `session`: memory only; gone when the frame reloads.
 */
export type StorageMode = "passkey" | "device" | "session";

/** Lifecycle of the key held by the frame. */
export type KeyState =
  /** No key. */
  | "none"
  /** Created; waiting for the main wallet's `approveAgent` and `confirmAgent`. The frame refuses to sign. */
  | "pending"
  /** Confirmed on Hyperliquid (`extraAgents`). */
  | "active"
  /** `validUntil` has passed (or is within the `expiresAfter` window). The frame refuses to sign. */
  | "expired";

export interface PasskeySupport {
  /** WebAuthn is present and not blocked by Permissions Policy in the frame. */
  available: boolean;
  /** Whether the PRF extension is supported, as far as the browser tells without a ceremony. */
  prf: "supported" | "unsupported" | "unknown";
  /** Why it is unavailable, when it is. */
  reason?: string;
}

/** The effective limits the frame enforces (baseline tightened by `setLimits`). */
export interface PolicySummary {
  allowedActionTypes: AllowedActionType[];
  allowedCoins: "*" | string[];
  maxOrderNotionalUsd: number;
  maxDailyNotionalUsd: number;
  /** `"market"`: each market's own maximum (baseline). A number: `min(number, market maximum)`. */
  maxLeverage: number | "market";
  maxOrdersPerMinute: number;
  /** Max distance of a limit price from the mark price, percent. */
  priceBandPct: number;
  requireStopLossForNewEntries: boolean;
  /** Every order carries exactly this builder code. */
  builder: { address: Hex; feeTenthsBps: number };
  /** Always false: the frame never acts for a Hyperliquid vault (see `ownSubAccountsAllowed` for sub-accounts). */
  vaultAddressAllowed: false;
  /**
   * `vaultAddress` is allowed for the key's master's own sub-accounts only: the frame reads HL `subAccounts` for the
   * master itself (cached briefly) and denies any other address with `POLICY_DENIED` / `VAULT_NOT_ALLOWED`.
   */
  ownSubAccountsAllowed: true;
  /** `expiresAfter` the frame puts on every action, ms after its clock. */
  expiresAfterMs: number;
  /** Intent origins the frame accepts. */
  allowedOrigins: Array<"manual" | "ai_ticket">;
  /** The master account's limits last applied with `setLimits` (null: baseline only). */
  userLimits: UserLimits | null;
  /** Sub-accounts with their own limits (`setLimits` with `account`); any other sub-account uses `userLimits`. */
  accountLimits: Record<Hex, UserLimits>;
}

/** Status of the frame and its key (`getStatus`, `statusChanged`). */
export interface SignerStatus {
  hasKey: boolean;
  keyState: KeyState;
  agentAddress: Hex | null;
  agentName: string | null;
  /** Master account the key was created for. */
  userAddress: Hex | null;
  /** Expiry of the agent (ms since epoch), as approved on Hyperliquid. */
  validUntil: number | null;
  /**
   * When the frame stops signing with this key (ms since epoch, on the frame's HL-corrected clock): `validUntil` minus
   * the `expiresAfter` window (15 s). Null without a key.
   */
  expiresAt: number | null;
  /**
   * The key expires within 7 days and hasn't expired yet: show the renew banner. Same condition as the
   * `keyExpiringSoon` event, which is emitted only once per key, so read this instead of relying on the event.
   */
  expiringSoon: boolean;
  /** The key has expired (`keyState: "expired"`); the frame refuses to sign. Same condition as `keyExpired`. */
  expired: boolean;
  storageMode: StorageMode | null;
  /** True when a key exists but is not in memory (passkey mode after a reload, or after `lock`). */
  locked: boolean;
  network: NetworkName;
  mainnetWritesEnabled: boolean;
  /** Server time minus device time, from HL `exchangeStatus` (0 until measured). Large values mean clock skew. */
  clockOffsetMs: number;
  policy: PolicySummary;
  metrics: {
    /** Messages dropped silently (wrong origin/source, not a Kokoah message, unreadable). */
    ignoredMessages: number;
    /** Requests answered with an error. */
    rejectedRequests: number;
    /** signAndSubmit requests denied by policy. */
    policyDenials: number;
    /** Actions sent to Hyperliquid. */
    submitted: number;
  };
}

// ---------------------------------------------------------------------------------------------
// Methods: params and results
// ---------------------------------------------------------------------------------------------

export interface HelloParams {
  protocolVersion: typeof PROTOCOL_VERSION;
  /** Free-form identification of the parent app, for diagnostics. */
  client?: { name: string; version: string };
}
export interface HelloResult {
  protocolVersion: typeof PROTOCOL_VERSION;
  frameVersion: string;
  frameOrigin: string;
  network: NetworkName;
  mainnetWritesEnabled: boolean;
  capabilities: {
    storageModes: StorageMode[];
    passkey: PasskeySupport;
    webLocks: boolean;
    indexedDB: boolean;
    broadcastChannel: boolean;
  };
  builder: { address: Hex; feeTenthsBps: number };
  /**
   * The frame's status at the handshake (key state, `expiringSoon`/`expired`, policy), so the app knows the key's
   * state without depending on events it may not have subscribed to yet.
   */
  status: SignerStatus;
  limits: {
    maxMessageBytes: number;
    minValidForDays: number;
    maxValidForDays: number;
    expiresAfterMs: number;
    maxAgentNameLength: number;
  };
}

export type GetStatusParams = Record<string, never>;
export type GetStatusResult = SignerStatus;

export interface CreateAgentParams {
  /** The master account (main wallet) that will sign `approveAgent`. */
  userAddress: Hex;
  /** 1–30 days. */
  validForDays: number;
  /**
   * Requested storage. `device` is the recommended default (survives reloads, no prompt); `passkey` is an opt-in
   * upgrade and falls back to `device` when the browser can't do WebAuthn PRF.
   */
  storageMode: StorageMode;
  /** Agent name, 1–16 characters. Default `kokoah-web`. */
  agentName?: string;
  /** EIP-712 `signatureChainId` for the main wallet (hex chain id it is connected to). Default: the network default. */
  signatureChainId?: Hex;
  /** Required when a non-expired key already exists: the old key is wiped immediately. */
  replaceExisting?: boolean;
}
export interface CreateAgentResult {
  agentAddress: Hex;
  agentName: string;
  validUntil: number;
  /** Storage actually used. */
  storageMode: StorageMode;
  requestedStorageMode: StorageMode;
  /** Set when `passkey` was requested but `device` was used. */
  storageFallbackReason?: string;
  keyState: "pending";
  /** From `@kokoah/shared` `buildApproveAgent`: the main wallet signs `typedData`; the parent posts `action`. */
  approveAgent: PreparedUserSignedAction;
}

/**
 * "Link phone": the phone creates its **own** agent key for an account whose main wallet is on another device (the
 * computer). Nothing secret travels: the computer's QR code carries a one-time pairing token for the backend and a
 * link secret that only the two devices know. The frame returns the 6-digit matching code for the key it created;
 * the computer computes the same code from what the backend relays, and the user approves only when both match.
 */
export interface CreateLinkedAgentParams {
  /** The account the phone is being linked to (the backend's pairing binds it). */
  userAddress: Hex;
  /** The agent name the computer will approve (from the pairing), 1–16 characters. */
  agentName: string;
  /** 1–30 days. */
  validForDays: number;
  /** Same as `createAgent`. `device` is the default for phones. */
  storageMode: StorageMode;
  /** Required when a non-expired key already exists on this device: it is wiped. */
  replaceExisting?: boolean;
  link: {
    /** The pairing id the backend issued (lowercase UUID). */
    pairingId: string;
    /** The link secret from the QR code's URL fragment: 16 bytes, base64url (22 characters). Never stored. */
    secret: string;
  };
}
export interface CreateLinkedAgentResult {
  agentAddress: Hex;
  agentName: string;
  validUntil: number;
  storageMode: StorageMode;
  requestedStorageMode: StorageMode;
  storageFallbackReason?: string;
  keyState: "pending";
  pairingId: string;
  /**
   * `@kokoah/shared/link` `deviceLinkCode` over (pairingId, userAddress, agentAddress, agentName, validUntil), keyed
   * with the link secret: 6 digits. Show it; the user compares it with the computer's.
   */
  matchCode: string;
}

export interface ConfirmAgentParams {
  /** Keep polling HL `extraAgents` for up to this long (ms, max 60000). Default 0: check once. */
  timeoutMs?: number;
}
export type ConfirmAgentResult = SignerStatus;

export type UnlockParams = Record<string, never>;
export type UnlockResult = SignerStatus;
export type LockParams = Record<string, never>;
export type LockResult = SignerStatus;

export interface SignAndSubmitParams {
  /**
   * Idempotency key (1–128 of `A–Z a–z 0–9 _ . : -`, with no run of 64 hex digits; a UUID is fine). Reusing it returns
   * the first result instead of re-signing. See {@link REQUEST_ID_PATTERN}.
   */
  requestId: string;
  /**
   * A Kokoah action intent (`@kokoah/shared/intents`). Prices, registries and builder are never taken from the parent.
   * `intent.vaultAddress` trades for a sub-account; the frame signs it only when HL lists that address as a
   * sub-account of the key's master.
   */
  intent: ActionIntentInput;
}

/** Outcome of an action that may or may not have reached Hyperliquid. */
export interface OutcomeUnknownError {
  code: "OUTCOME_UNKNOWN";
  title: string;
  message: string;
  retryable: false;
  category: "request";
  raw: string;
}

export interface SignAndSubmitResult {
  requestId: string;
  /**
   * - `ok`: HL accepted the request (`status: "ok"`). Per-order results, including per-order errors, are in `outcome`.
   * - `rejected`: HL rejected the whole request (`status: "err"`, or a single error status); see `error`.
   * - `unknown`: the request may or may not have reached HL (timeout, network error, 5xx). Query order status by
   *   cloid before doing anything else; never resubmit blindly.
   */
  status: "ok" | "rejected" | "unknown";
  actionType: string;
  nonce: number;
  expiresAfter: number;
  /** Cloids of every order in the action, parent first. */
  cloids: Hex[];
  /** Raw JSON body returned by HL `/exchange` (null when unknown). Never contains the signature. */
  exchangeResponse: unknown;
  /** `parseExchangeResponse` of the body (null when unknown). */
  outcome: ExchangeOutcome | null;
  /** `rejected`: the mapped HL error. `unknown`: an `OUTCOME_UNKNOWN` error. */
  error?: MappedHlError | OutcomeUnknownError;
  /** Market orders: the mid the frame fetched itself and the IOC limit price it signed. */
  marketOrder?: { midPrice: string; limitPrice: string; slippageBps: number };
  /** True when this result was replayed from an earlier request with the same `requestId`. */
  replayed: boolean;
}

/** Limits the parent may set. Each value must be at least as strict as the frame's baseline. */
export interface UserLimits {
  maxOrderNotionalUsd?: number;
  maxDailyNotionalUsd?: number;
  /** Integer ≥ 1. The effective cap per market is `min(maxLeverage, market maximum)`. */
  maxLeverage?: number;
  maxOrdersPerMinute?: number;
  priceBandPct?: number;
  /** Subset of markets (HL coin names, e.g. `BTC`, `xyz:SP500`). */
  allowedCoins?: string[];
  /** `true` only (the baseline is `false`; `false` is a no-op). */
  requireStopLossForNewEntries?: boolean;
  /** Subset of the baseline action types. */
  allowedActionTypes?: AllowedActionType[];
}
/**
 * `setLimits` replaces the previous limits of one account entirely. Without `account` (or with the key's master) it
 * sets the master's limits (`{}` resets them to the baseline). With a sub-account address it sets that sub-account's
 * own limits; `{ account }` alone removes them, so the sub-account uses the master's again.
 */
export type SetLimitsParams = UserLimits & {
  /** A sub-account of the key's master. Omit for the master account. */
  account?: Hex;
};
export interface SetLimitsResult {
  policy: PolicySummary;
}

export interface RevokeParams {
  /** Name to revoke. Default: the current key's name, else `kokoah-web`. */
  agentName?: string;
  signatureChainId?: Hex;
}
export interface RevokeResult {
  /**
   * True when this device's key with that name was wiped from memory and storage. False when there was none, or when
   * its stored copy could not be deleted (then `wipeError` is set).
   */
  wiped: boolean;
  /**
   * Set (with `wiped: false`) when this device's key matched but its stored copy could not be deleted. The key is out
   * of memory in this tab but would come back after a reload: post `revokeAgent` anyway (HL then rejects the key), and
   * call `revoke` again to delete the stored copy.
   */
  wipeError?: string;
  /** The wiped (or, with `wipeError`, the matched) key's address (never reuse it). Null when no local key matched. */
  agentAddress: Hex | null;
  agentName: string;
  /** From `@kokoah/shared` `buildRevokeAgent`: the main wallet signs `typedData`; the parent posts `action`. */
  revokeAgent: PreparedUserSignedAction;
  status: SignerStatus;
}

/** Re-wraps the current stored key under another storage mode. No new `approveAgent`: same key, same agent. */
export interface SetStorageModeParams {
  /** `passkey`: protect the key with a passkey (one prompt). `device`: remove passkey protection (one prompt). */
  to: "passkey" | "device";
}
export type SetStorageModeResult = SignerStatus;

export interface SetThemeParams {
  /** CSS custom properties; values are validated (colors, lengths, font stacks) and length-capped. */
  variables?: Partial<Record<ThemeVariable, string>>;
  colorScheme?: "light" | "dark" | "light dark";
}
export interface SetThemeResult {
  applied: ThemeVariable[];
}

/** Params of every method. */
export interface MethodParams {
  hello: HelloParams;
  getStatus: GetStatusParams;
  createAgent: CreateAgentParams;
  createLinkedAgent: CreateLinkedAgentParams;
  confirmAgent: ConfirmAgentParams;
  unlock: UnlockParams;
  lock: LockParams;
  signAndSubmit: SignAndSubmitParams;
  setLimits: SetLimitsParams;
  revoke: RevokeParams;
  setTheme: SetThemeParams;
  setStorageMode: SetStorageModeParams;
}
/** Result of every method. */
export interface MethodResults {
  hello: HelloResult;
  getStatus: GetStatusResult;
  createAgent: CreateAgentResult;
  createLinkedAgent: CreateLinkedAgentResult;
  confirmAgent: ConfirmAgentResult;
  unlock: UnlockResult;
  lock: LockResult;
  signAndSubmit: SignAndSubmitResult;
  setLimits: SetLimitsResult;
  revoke: RevokeResult;
  setTheme: SetThemeResult;
  setStorageMode: SetStorageModeResult;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** Stable error codes of `ok: false` responses. */
export type SignerErrorCode =
  | "INVALID_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_VERSION"
  | "UNKNOWN_METHOD"
  | "NOT_CONNECTED"
  | "NO_KEY"
  | "KEY_EXISTS"
  | "KEY_PENDING"
  | "KEY_EXPIRED"
  | "KEY_CHANGED"
  | "LOCKED"
  | "AGENT_NOT_FOUND"
  | "AGENT_MISMATCH"
  | "INVALID_INTENT"
  | "UNSUPPORTED_MARKET"
  | "COMPILE_FAILED"
  | "POLICY_DENIED"
  | "MARKET_DATA_UNAVAILABLE"
  | "REQUEST_ID_REUSED"
  | "SIGNER_BUSY"
  | "LIMIT_LOOSENING_REJECTED"
  | "PASSKEY_UNAVAILABLE"
  | "PASSKEY_FAILED"
  | "USER_CANCELLED"
  | "USER_TIMEOUT"
  | "PROMPT_BUSY"
  | "UNLOCK_FAILED"
  | "STORAGE_FAILED"
  | "MAINNET_WRITES_DISABLED"
  | "HL_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface SignerError {
  code: SignerErrorCode;
  message: string;
  /** Whether sending the same request again later may succeed. */
  retryable: boolean;
  details?: {
    /** POLICY_DENIED: every violation, from `@kokoah/shared` `evaluatePolicy` (or the frame's own checks). */
    violations?: PolicyViolation[];
    /** INVALID_REQUEST / INVALID_INTENT: validation issues. */
    issues?: Array<{ message: string; path?: string }>;
    /** COMPILE_FAILED: the `CompileError` code. */
    compileCode?: string;
    /** LIMIT_LOOSENING_REJECTED: the fields that would loosen the baseline. */
    fields?: string[];
    /** Anything else worth showing (never secrets). */
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

export interface EventData {
  /** Posted once when the frame has loaded (to each allowed parent origin; the browser delivers it only to the real one). */
  ready: { protocolVersion: typeof PROTOCOL_VERSION };
  /** The key or policy changed (created, confirmed, locked, unlocked, revoked, expired, changed in another tab, limits). */
  statusChanged: SignerStatus;
  /** The key expires within 7 days: renew it (`createAgent` with `replaceExisting`). */
  keyExpiringSoon: { agentAddress: Hex; validUntil: number; msRemaining: number };
  /** The key has expired; the frame refuses to sign with it. */
  keyExpired: { agentAddress: Hex; validUntil: number };
  /** The frame needs (or no longer needs) the user to click inside it. Show the iframe while `visible` is true. */
  promptChanged: { visible: boolean; kind: "passkey-create" | "passkey-unlock" | null };
}

// ---------------------------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------------------------

interface EnvelopeBase {
  protocol: typeof PROTOCOL_NAME;
  version: typeof PROTOCOL_VERSION;
}

export interface RequestMessage<M extends MethodName = MethodName> extends EnvelopeBase {
  kind: "request";
  /**
   * Unique per request (1–64 of `A–Z a–z 0–9 _ . : -`, not 64 hex digits); echoed in the response. See
   * {@link ID_PATTERN}.
   */
  id: string;
  method: M;
  params: MethodParams[M];
}

export type ResponseMessage<M extends MethodName = MethodName> =
  | (EnvelopeBase & { kind: "response"; id: string; method: M; ok: true; result: MethodResults[M] })
  | (EnvelopeBase & { kind: "response"; id: string; method: M; ok: false; error: SignerError });

export interface EventMessage<E extends EventName = EventName> extends EnvelopeBase {
  kind: "event";
  event: E;
  data: EventData[E];
}

export type FrameToParentMessage = ResponseMessage | EventMessage;

/**
 * Request ids (`id`) and `signAndSubmit.requestId`: 1–64 (resp. 1–128) of `A–Z a–z 0–9 _ . : -`, and **no run of 64
 * hex digits**. Both are echoed in the response, and the frame refuses to post any message containing 64 hex digits in
 * a row (the shape of a private key or a signature half). An id of that shape would turn the answer to an order that
 * already reached Hyperliquid into an `INTERNAL_ERROR`, so such ids are rejected up front, before anything is signed.
 */
export const ID_PATTERN = /^(?!.*[0-9A-Fa-f]{64})[A-Za-z0-9_.:-]{1,64}$/;
export const REQUEST_ID_PATTERN = /^(?!.*[0-9A-Fa-f]{64})[A-Za-z0-9_.:-]{1,128}$/;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** True for anything carrying this protocol's envelope header (does not validate the rest). */
export function isProtocolMessage(x: unknown): x is EnvelopeBase & Record<string, unknown> {
  return isRecord(x) && x.protocol === PROTOCOL_NAME && x.version === PROTOCOL_VERSION;
}

/** Shallow check of a frame → parent message (the client uses it before trusting fields). */
export function isFrameToParentMessage(x: unknown): x is FrameToParentMessage {
  if (!isProtocolMessage(x)) return false;
  if (x.kind === "response") {
    return typeof x.id === "string" && typeof x.method === "string" && typeof x.ok === "boolean" && (x.ok ? "result" in x : isRecord(x.error));
  }
  if (x.kind === "event") return typeof x.event === "string" && (EVENTS as readonly string[]).includes(x.event) && "data" in x;
  return false;
}

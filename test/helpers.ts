/**
 * Test harness: a mocked Hyperliquid API (no network), a fake parent window, fake Web Locks, a mocked WebAuthn PRF
 * provider and a helper that drives a FrameCore through the real message path.
 */
import { createHash, webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { parseFrameConfig, type FrameConfig } from "../src/frame/config.js";
import { FrameCore, type BroadcastLike, type FrameDeps } from "../src/frame/core.js";
import type { FetchLike } from "../src/frame/hl.js";
import type { LockManagerLike } from "../src/frame/nonces.js";
import type { PasskeyCreateOptions, PasskeyCreateResult, PasskeyGetOptions, PasskeyProvider } from "../src/frame/passkey.js";
import { IdbSignerStore, type SignerStore } from "../src/frame/storage.js";
import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  type EventData,
  type EventMessage,
  type EventName,
  type FrameToParentMessage,
  type MethodName,
  type MethodParams,
  type MethodResults,
  type PasskeySupport,
  type ResponseMessage,
  type SignerError,
} from "../src/protocol/index.js";

export const APP_ORIGIN = "https://app.kokoah.example";
export const STAGING_ORIGIN = "https://staging.kokoah.example";
export const FRAME_ORIGIN = "https://signer.kokoah.example";
export const BUILDER = "0x00000000000000000000000000000000000b0b1d" as const;
export const USER = "0x1111111111111111111111111111111111111111" as const;
export const T0 = Date.parse("2026-09-22T12:00:00.000Z");
export const DAY = 24 * 60 * 60 * 1000;

export function testConfig(env: Record<string, string> = {}, production = true): FrameConfig {
  return parseFrameConfig(
    {
      VITE_ALLOWED_PARENT_ORIGINS: `${APP_ORIGIN},${STAGING_ORIGIN}`,
      VITE_BUILDER_ADDRESS: BUILDER,
      VITE_BUILDER_FEE_TENTHS_BPS: "25",
      ...env,
    },
    { production },
  );
}

/** A controllable clock. */
export class Clock {
  t = T0;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

// ---------------------------------------------------------------------------------------------
// Mock Hyperliquid
// ---------------------------------------------------------------------------------------------

export interface ExchangeCall {
  url: string;
  body: {
    action: Record<string, unknown> & { type: string };
    nonce: number;
    signature: { r: `0x${string}`; s: `0x${string}`; v: number };
    vaultAddress?: string;
    expiresAfter?: number;
  };
}

type Responder = (call: ExchangeCall) => Response | Promise<Response> | "network-error";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const META0 = {
  universe: [
    { name: "BTC", szDecimals: 5, maxLeverage: 40 },
    { name: "ETH", szDecimals: 4, maxLeverage: 25 },
    { name: "OLD", szDecimals: 1, maxLeverage: 3, isDelisted: true },
    { name: "SOL", szDecimals: 2, maxLeverage: 20 },
  ],
  marginTables: [],
};
export const META_XYZ = {
  universe: [
    { name: "xyz:SP500", szDecimals: 3, maxLeverage: 20, marginMode: "strictIsolated" },
    { name: "xyz:GOLD", szDecimals: 4, maxLeverage: 10 },
  ],
  marginTables: [],
  collateralToken: 0,
};
/** Mainnet `spotMeta` excerpt: the pinned stablecoin pairs (@166 USDT0/USDC, @150 USDE/USDC) and HYPE/USDC. */
export const SPOT_META = {
  universe: [
    { tokens: [150, 0], name: "@107", index: 107, isCanonical: false },
    { tokens: [235, 0], name: "@150", index: 150, isCanonical: false },
    { tokens: [268, 0], name: "@166", index: 166, isCanonical: false },
  ],
  tokens: [
    { name: "USDC", szDecimals: 8, weiDecimals: 8, index: 0, tokenId: "0x6d1e7cde53ba9467b783cb7c530ce054", isCanonical: true },
    { name: "HYPE", szDecimals: 2, weiDecimals: 8, index: 150, tokenId: "0x0d01dc56dcaaca66ad901c959b4011ec", isCanonical: false },
    { name: "USDE", szDecimals: 2, weiDecimals: 8, index: 235, tokenId: "0x2e6d84f2d7ca82e6581e03523e4389f7", isCanonical: false },
    { name: "USDT0", szDecimals: 2, weiDecimals: 8, index: 268, tokenId: "0x25faedc3f054130dbb4e4203aca63567", isCanonical: false },
  ],
};
export const SPOT_META_AND_CTXS = [
  SPOT_META,
  [
    { coin: "@107", markPx: "40", midPx: "40.01", prevDayPx: "39", dayNtlVlm: "1000000" },
    { coin: "@150", markPx: "0.9991", midPx: "0.99915", prevDayPx: "0.999", dayNtlVlm: "1000000" },
    { coin: "@166", markPx: "0.9998", midPx: "0.99985", prevDayPx: "0.9997", dayNtlVlm: "50000000" },
  ],
];
/** HL `userFees` excerpt: the VIP tiers, no trial running and one available now. */
export const USER_FEES = {
  feeSchedule: {
    cross: "0.00045",
    add: "0.00015",
    tiers: {
      vip: [
        { ntlCutoff: "5000000.0", cross: "0.0004", add: "0.00012" },
        { ntlCutoff: "25000000.0", cross: "0.00035", add: "0.00008" },
        { ntlCutoff: "100000000.0", cross: "0.0003", add: "0.00004" },
        { ntlCutoff: "500000000.0", cross: "0.00028", add: "0.0" },
      ],
      mm: [{ makerFractionCutoff: "0.005", add: "-0.00001" }],
    },
  },
  userCrossRate: "0.00045",
  userAddRate: "0.00015",
  activeReferralDiscount: "0.0",
  trial: null,
  feeTrialEscrow: "0.0",
  nextTrialAvailableTimestamp: null,
};
export const PERP_DEXS = [null, { name: "xyz", fullName: "XYZ", deployer: "0x2222222222222222222222222222222222222222", assetToStreamingOiCap: [], assetToFundingMultiplier: [] }];

/** In-memory stand-in for api.hyperliquid-testnet.xyz. */
export class MockHl {
  readonly clock: Clock;
  mark: Record<string, string> = { BTC: "100000", ETH: "2000", OLD: "1", SOL: "150", "xyz:SP500": "6000", "xyz:GOLD": "3000" };
  mid: Record<string, string | null> = { BTC: "100010", ETH: "2001", OLD: null, SOL: "150.5", "xyz:SP500": "6001", "xyz:GOLD": "3001" };
  /** Server clock minus the test clock. */
  serverOffsetMs = 0;
  extraAgents: Record<string, Array<{ address: string; name: string; validUntil: number | null }>> = {};
  leverage: Record<string, number> = {};
  /** Leverage per account (lowercase address) and coin; falls back to `leverage`. */
  leverageByUser: Record<string, Record<string, number>> = {};
  /** HL `subAccounts` answers by master (lowercase); unknown masters answer `null`. */
  subAccounts: Record<string, unknown> = {};
  /** HL `referral` answers by user (lowercase); unknown users have no referrer. */
  referral: Record<string, unknown> = {};
  /** HL `spotMetaAndAssetCtxs` answer (Convert); default: the pinned mainnet stablecoin pairs plus HYPE/USDC. */
  spot: unknown = SPOT_META_AND_CTXS;
  /** HL `userFees` answer (fee trial). */
  userFees: unknown = structuredClone(USER_FEES);
  /** HL `userNonFundingLedgerUpdates` answer (HLP deposit caps). */
  ledger: unknown = [];
  /** HL `userVaultEquities` answer (vault withdrawals). */
  vaultEquities: unknown = [];
  infoCalls: Array<Record<string, unknown>> = [];
  exchangeCalls: ExchangeCall[] = [];
  infoFailure: ((body: Record<string, unknown>) => boolean) | null = null;
  responder: Responder | null = null;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /** Approves an agent as if the main wallet had posted approveAgent. */
  approve(user: string, address: string, name: string, validUntil: number | null): void {
    (this.extraAgents[user.toLowerCase()] ??= []).push({ address: address.toLowerCase(), name, validUntil });
  }

  fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.endsWith("/info")) {
      this.infoCalls.push(body);
      if (this.infoFailure?.(body)) throw new TypeError("Failed to fetch");
      return json(this.info(body));
    }
    if (url.endsWith("/exchange")) {
      const call: ExchangeCall = { url, body: body as unknown as ExchangeCall["body"] };
      this.exchangeCalls.push(call);
      const r = this.responder ? await this.responder(call) : this.defaultExchange(call);
      if (r === "network-error") throw new TypeError("Failed to fetch");
      return r;
    }
    return json({ error: "not found" }, 404);
  };

  ctxs(meta: { universe: Array<{ name: string }> }) {
    return meta.universe.map((u) => ({ markPx: this.mark[u.name] ?? "0", midPx: this.mid[u.name] ?? null, oraclePx: this.mark[u.name] ?? "0", funding: "0.0000125", openInterest: "1000" }));
  }

  info(body: Record<string, unknown>): unknown {
    switch (body.type) {
      case "metaAndAssetCtxs":
        if (body.dex === undefined || body.dex === "") return [META0, this.ctxs(META0)];
        if (body.dex === "xyz") return [META_XYZ, this.ctxs(META_XYZ)];
        return [{ universe: [] }, []];
      case "perpDexs":
        return PERP_DEXS;
      case "exchangeStatus":
        return { time: this.clock.now() + this.serverOffsetMs, specialStatuses: null };
      case "extraAgents":
        return this.extraAgents[String(body.user).toLowerCase()] ?? [];
      case "subAccounts":
        return this.subAccounts[String(body.user).toLowerCase()] ?? null;
      case "referral":
        return this.referral[String(body.user).toLowerCase()] ?? { referredBy: null, cumVlm: "0", unclaimedRewards: "0", claimedRewards: "0", builderRewards: "0", referrerState: { stage: "needToCreateCode" }, rewardHistory: [] };
      case "spotMetaAndAssetCtxs":
        return this.spot;
      case "userFees":
        return this.userFees;
      case "userNonFundingLedgerUpdates":
        return this.ledger;
      case "userVaultEquities":
        return this.vaultEquities;
      case "activeAssetData": {
        const lev = this.leverageByUser[String(body.user).toLowerCase()]?.[String(body.coin)] ?? this.leverage[String(body.coin)] ?? 10;
        return { user: body.user, coin: body.coin, leverage: { type: "cross", value: lev }, maxTradeSzs: ["1", "1"], availableToTrade: ["1", "1"], markPx: this.mark[String(body.coin)] };
      }
      default:
        return null;
    }
  }

  defaultExchange(call: ExchangeCall): Response {
    const a = call.body.action;
    if (a.type === "order") {
      const orders = a.orders as Array<{ c?: string }>;
      return json({ status: "ok", response: { type: "order", data: { statuses: orders.map((o, i) => ({ resting: { oid: 1000 + i, ...(o.c ? { cloid: o.c } : {}) } })) } } });
    }
    if (a.type === "cancel" || a.type === "cancelByCloid") {
      return json({ status: "ok", response: { type: "cancel", data: { statuses: (a.cancels as unknown[]).map(() => "success") } } });
    }
    return json({ status: "ok", response: { type: "default" } });
  }
}

// ---------------------------------------------------------------------------------------------
// Fakes: parent window, Web Locks, broadcast, passkeys
// ---------------------------------------------------------------------------------------------

export interface Posted {
  message: FrameToParentMessage;
  targetOrigin: string;
}

export class FakeParent {
  posted: Posted[] = [];
  postMessage = vi.fn((message: unknown, targetOrigin: string) => {
    // Structured clone, as the browser does (also proves the message is cloneable).
    this.posted.push({ message: structuredClone(message) as FrameToParentMessage, targetOrigin });
  });
}

/** FIFO exclusive locks per name, shared by every "tab" that holds the same instance. */
export class FakeLocks implements LockManagerLike {
  private readonly tails = new Map<string, Promise<void>>();
  requests: string[] = [];
  async request<T>(name: string, options: { signal?: AbortSignal }, callback: (lock: unknown) => Promise<T> | T): Promise<T> {
    this.requests.push(name);
    const prev = this.tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(name, tail);
    const signal = options.signal;
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        void prev.then(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
    } catch (e) {
      void prev.then(release);
      throw e;
    }
    try {
      return await callback({ name, mode: "exclusive" });
    } finally {
      release();
      if (this.tails.get(name) === tail) this.tails.delete(name);
    }
  }
}

/** Same-origin BroadcastChannel stand-in connecting simulated tabs. */
export class FakeBus {
  private readonly channels = new Set<FakeChannel>();
  channel(): FakeChannel {
    const c = new FakeChannel(this);
    this.channels.add(c);
    return c;
  }
  deliver(from: FakeChannel, data: unknown): void {
    for (const c of this.channels) if (c !== from) queueMicrotask(() => c.onmessage?.({ data: structuredClone(data) }));
  }
  remove(c: FakeChannel): void {
    this.channels.delete(c);
  }
}
export class FakeChannel implements BroadcastLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  private readonly bus: FakeBus;
  constructor(bus: FakeBus) {
    this.bus = bus;
  }
  postMessage(message: unknown): void {
    this.bus.deliver(this, message);
  }
  close(): void {
    this.bus.remove(this);
  }
}

/** WebAuthn PRF stand-in: PRF(salt) = SHA-256(credential secret ‖ salt). */
export class MockPasskeys implements PasskeyProvider {
  supportResult: PasskeySupport = { available: true, prf: "supported" };
  secret = new Uint8Array(32).fill(7);
  returnPrfOnCreate = true;
  prfEnabled: boolean | undefined = true;
  failNextGet: "cancelled" | "unsupported" | null = null;
  createCalls: PasskeyCreateOptions[] = [];
  getCalls: PasskeyGetOptions[] = [];
  readonly credentialId = new Uint8Array([9, 8, 7, 6]);

  prf(salt: Uint8Array): Uint8Array {
    return new Uint8Array(createHash("sha256").update(this.secret).update(salt).digest());
  }
  async support(): Promise<PasskeySupport> {
    return this.supportResult;
  }
  async create(o: PasskeyCreateOptions): Promise<PasskeyCreateResult> {
    this.createCalls.push(o);
    return { credentialId: this.credentialId, prfEnabled: this.prfEnabled, prfFirst: this.returnPrfOnCreate && this.prfEnabled !== false ? this.prf(o.prfSalt) : undefined };
  }
  async get(o: PasskeyGetOptions): Promise<{ prfFirst: Uint8Array }> {
    this.getCalls.push(o);
    const { PasskeyError } = await import("../src/frame/passkey.js");
    if (this.failNextGet) {
      const code = this.failNextGet;
      this.failNextGet = null;
      throw new PasskeyError(code, `mock ${code}`);
    }
    return { prfFirst: this.prf(o.prfSalt) };
  }
}

// ---------------------------------------------------------------------------------------------
// Frame harness
// ---------------------------------------------------------------------------------------------

let idCounter = 0;

export interface HarnessOptions {
  clock?: Clock;
  hl?: MockHl;
  idb?: IDBFactory;
  store?: SignerStore;
  locks?: LockManagerLike | undefined | "none";
  passkeys?: PasskeyProvider;
  config?: FrameConfig;
  bus?: FakeBus;
  generatePrivateKey?: () => `0x${string}`;
  logger?: FrameDeps["logger"];
  withUi?: boolean;
  promptTimeoutMs?: number;
}

export class FrameHarness {
  readonly core: FrameCore;
  readonly parent: FakeParent;
  readonly hl: MockHl;
  readonly clock: Clock;
  readonly idb: IDBFactory;
  readonly root: HTMLElement | null;
  readonly generatedKeys: `0x${string}`[];

  private constructor(fields: {
    core: FrameCore;
    parent: FakeParent;
    hl: MockHl;
    clock: Clock;
    idb: IDBFactory;
    root: HTMLElement | null;
    generatedKeys: `0x${string}`[];
  }) {
    this.core = fields.core;
    this.parent = fields.parent;
    this.hl = fields.hl;
    this.clock = fields.clock;
    this.idb = fields.idb;
    this.root = fields.root;
    this.generatedKeys = fields.generatedKeys;
  }

  static async create(o: HarnessOptions = {}): Promise<FrameHarness> {
    const clock = o.clock ?? new Clock();
    const hl = o.hl ?? new MockHl(clock);
    const idb = o.idb ?? new IDBFactory();
    const store = o.store ?? (await IdbSignerStore.open(idb));
    const parent = new FakeParent();
    const withUi = o.withUi ?? true;
    const root = withUi ? document.createElement("div") : null;
    if (root) document.body.append(root);
    const generatedKeys: `0x${string}`[] = [];
    const gen = o.generatePrivateKey ?? generatePrivateKey;
    const core = await FrameCore.create({
      config: o.config ?? testConfig(),
      frameVersion: "0.0.0-test",
      frameOrigin: FRAME_ORIGIN,
      parent,
      document: withUi ? document : null,
      uiRoot: root,
      fetch: hl.fetch,
      crypto: webcrypto as unknown as Crypto,
      store,
      locks: o.locks === "none" ? undefined : (o.locks ?? new FakeLocks()),
      passkeys: o.passkeys ?? new MockPasskeys(),
      broadcast: o.bus ? o.bus.channel() : null,
      now: clock.now,
      generatePrivateKey: () => {
        const k = gen();
        generatedKeys.push(k);
        return k;
      },
      ...(o.logger ? { logger: o.logger } : {}),
      ...(o.promptTimeoutMs !== undefined ? { promptTimeoutMs: o.promptTimeoutMs } : {}),
    });
    return new FrameHarness({ core, parent, hl, clock, idb, root, generatedKeys });
  }

  /** Sends a raw message through the real entry point. */
  async post(data: unknown, options: { origin?: string; source?: unknown } = {}): Promise<void> {
    await this.core.handleMessage({ data, origin: options.origin ?? APP_ORIGIN, source: options.source === undefined ? this.parent : options.source });
  }

  /** Sends a request and returns the response (throws if none was posted). */
  async request<M extends MethodName>(method: M, params: MethodParams[M] | Record<string, unknown>, options: { origin?: string } = {}): Promise<ResponseMessage<M>> {
    const id = `t${++idCounter}`;
    await this.post({ protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, kind: "request", id, method, params }, options);
    const r = this.parent.posted.find((p) => p.message.kind === "response" && p.message.id === id);
    if (!r) throw new Error(`no response to ${method}`);
    return r.message as ResponseMessage<M>;
  }

  /** Sends a request; expects success. */
  async ok<M extends MethodName>(method: M, params: MethodParams[M] | Record<string, unknown> = {}): Promise<MethodResults[M]> {
    const r = await this.request(method, params);
    if (!r.ok) throw new Error(`${method} failed: ${r.error.code} ${r.error.message} ${JSON.stringify(r.error.details ?? {})}`);
    return r.result;
  }

  /** Sends a request; expects an error. */
  async fail<M extends MethodName>(method: M, params: MethodParams[M] | Record<string, unknown> = {}): Promise<SignerError> {
    const r = await this.request(method, params);
    if (r.ok) throw new Error(`${method} unexpectedly succeeded`);
    return r.error;
  }

  events<E extends EventName>(name: E): Array<EventData[E]> {
    return this.parent.posted.filter((p) => p.message.kind === "event" && p.message.event === name).map((p) => (p.message as EventMessage<E>).data);
  }

  /** hello + createAgent + HL approval + confirmAgent. Returns the agent address and its private key. */
  async activeAgent(storageMode: "device" | "session" | "passkey" = "device", validForDays = 30): Promise<{ address: `0x${string}`; privateKey: `0x${string}`; validUntil: number }> {
    await this.ok("hello", { protocolVersion: 1 });
    const pending = this.createAgent({ userAddress: USER, validForDays, storageMode });
    if (storageMode === "passkey") await this.clickPrompt();
    const created = await pending;
    this.hl.approve(USER, created.agentAddress, created.agentName, created.validUntil);
    await this.ok("confirmAgent", {});
    return { address: created.agentAddress, privateKey: this.generatedKeys.at(-1) as `0x${string}`, validUntil: created.validUntil };
  }

  async createAgent(params: MethodParams["createAgent"]): Promise<MethodResults["createAgent"]> {
    return await this.ok("createAgent", params);
  }

  /** `setLimits` that loosens the stored limits: confirms the frame's prompt. */
  async loosen(params: MethodParams["setLimits"]): Promise<MethodResults["setLimits"]> {
    const pending = this.request("setLimits", params);
    await this.clickPrompt();
    const r = await pending;
    if (!r.ok) throw new Error(`setLimits failed: ${r.error.code} ${r.error.message}`);
    return r.result;
  }

  /** Text of the in-frame prompt while it is shown ("" otherwise). */
  promptText(): string {
    const panel = this.root?.querySelector<HTMLElement>(".ks-prompt");
    return panel && !panel.hidden ? (panel.textContent ?? "") : "";
  }

  /** Waits for the in-frame prompt and clicks its primary button. */
  async clickPrompt(button: "primary" | "cancel" = "primary"): Promise<void> {
    await waitFor(() => this.root?.querySelector<HTMLElement>(".ks-prompt")?.hidden === false);
    const b = this.root?.querySelector<HTMLButtonElement>(button === "primary" ? ".ks-primary" : ".ks-secondary");
    if (!b) throw new Error("no prompt button");
    await waitFor(() => !b.disabled);
    b.click();
  }

  destroy(): void {
    this.core.destroy();
    this.root?.remove();
  }
}

/** Polls until `cond` holds (default 2 s). */
export async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

let cloidCounter = 0;
/** A fresh deterministic-looking cloid for intents. */
export function cloid(): `0x${string}` {
  cloidCounter++;
  return `0x6b6f0101${cloidCounter.toString(16).padStart(24, "0")}`;
}

/** An HL `subAccounts` entry. */
export function subAccountEntry(address: string, master: string = USER, name = "Swing"): Record<string, unknown> {
  return { name, subAccountUser: address, master, clearinghouseState: { marginSummary: { accountValue: "0" }, assetPositions: [] }, spotState: { balances: [] } };
}

export function limitOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "order", coin: "ETH", side: "buy", orderType: "limit", size: "0.1", price: "2000", origin: "manual", cloid: cloid(), ...overrides };
}

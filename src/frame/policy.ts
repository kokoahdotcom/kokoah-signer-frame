/**
 * The frame's signing policy: a baseline compiled into the frame, optionally tightened (never loosened) by the parent
 * with `setLimits`, and evaluated with `@kokoah/shared` `evaluatePolicy` before anything is signed.
 *
 * Evaluation runs twice on every action:
 * 1. on the **compiled** subject (intent + exact wire action: origin, builder, prices, notional, rate, leverage);
 * 2. on the **wire** subject built from the exact action object that will be hashed and signed (defense in depth: a
 *    compiler bug can't turn an allowed intent into, say, a transfer).
 *
 * Price band (shared `band.ts`): orders that execute now (market, IOC, marketable limits) must be within
 * `priceBandPct` (10% baseline, user-tightenable) of HL's mark; resting GTC/ALO limits that don't cross may sit up to
 * `RESTING_PRICE_BAND_PCT` (50%) away; untriggered triggers likewise. Mark and mid always come from the frame's own
 * HL reads.
 *
 * The frame adds four things the shared policy has no field for: the per-market leverage cap (baseline = each
 * market's own maximum), a hard `vaultAddress` rule independent of the policy object (only a sub-account that the
 * frame itself found in HL's `subAccounts` list of the key's master; HL vaults and anything else are denied), the
 * notional counted against the daily limit, and the agent-wide baseline daily cap across all accounts.
 *
 * Personal limits (`setLimits`) are kept per account: the master's, and optionally one set per sub-account (a
 * sub-account without its own uses the master's). Orders per minute are counted per agent across accounts; daily
 * notional per account for personal limits, and per agent for the baseline cap.
 *
 * Revenue actions (PHASE3 REV), all for the master account only:
 * - Convert stablecoins: spot orders only on the pinned stablecoin/USDC pairs of the frame's network
 *   (`allowedSpotCoins`), each checked against the `spotMeta` the frame fetches itself; one IOC order, the builder on
 *   sells and none on buys. Every other spot market stays denied.
 * - `startFeeTrial`: allowed (it is in the baseline action types).
 * - `setReferrer`: only with the frame's configured referral code (`referralCode`, from the build, never from the
 *   parent), only while HL reports no referrer for the account and at most once per key (see `core.ts`).
 *
 * @module
 */
import type { AccountIntent, CompiledAccountAction, CompiledAction } from "@kokoah/shared/actions";
import type { ActionIntent } from "@kokoah/shared/intents";
import type { MarketRegistry } from "@kokoah/shared/markets";
import { createManualTradingPolicy, evaluatePolicy, parsePolicy, type Policy, type PolicyViolation } from "@kokoah/shared/policy";
import { BASELINE_ACTION_TYPES, EXPIRES_AFTER_MS, type AllowedActionType, type PolicySummary, type UserLimits } from "../protocol/index.js";

/** Leverage value meaning "no global cap; each market's own maximum applies". */
export const NO_GLOBAL_LEVERAGE_CAP = 1000;

/** Baseline limits compiled into the frame. The parent can only tighten them. */
export const BASELINE_LIMITS = Object.freeze({
  allowedActionTypes: [...BASELINE_ACTION_TYPES] as AllowedActionType[],
  allowedCoins: "*" as const,
  maxOrderNotionalUsd: 1_000_000,
  maxDailyNotionalUsd: 25_000_000,
  maxOrdersPerMinute: 60,
  priceBandPct: 10,
  requireStopLossForNewEntries: false,
  /** `expiresAfter` is mandatory and at most this far ahead (the frame itself uses 15 s). */
  maxExpiresAfterWindowMs: 30_000,
  allowedOrigins: ["manual", "ai_ticket"] as Array<"manual" | "ai_ticket">,
});

/** The builder every order must carry. */
export interface BuilderSetting {
  address: `0x${string}`;
  feeTenthsBps: number;
}

/** Frame-wide allowances beyond trading (both from the frame's own build configuration). */
export interface BaselineExtras {
  /** Spot pairs Convert may trade: the network's pinned stablecoin pairs. Empty: no spot at all. */
  spotCoins?: readonly string[];
  /** Kokoah's Hyperliquid referral code, the only one `setReferrer` may carry. Null: `setReferrer` is denied. */
  referralCode?: string | null;
}

/** Builds the baseline `Policy` (shared schema) for a builder. */
export function createBaselinePolicy(builder: BuilderSetting, extras: BaselineExtras = {}): Policy {
  return createManualTradingPolicy({
    builder: { b: builder.address.toLowerCase() as `0x${string}`, f: builder.feeTenthsBps },
    overrides: {
      allowedActionTypes: [...BASELINE_LIMITS.allowedActionTypes],
      allowedCoins: "*",
      maxOrderNotionalUsd: BASELINE_LIMITS.maxOrderNotionalUsd,
      maxDailyNotionalUsd: BASELINE_LIMITS.maxDailyNotionalUsd,
      maxLeverage: NO_GLOBAL_LEVERAGE_CAP,
      requireStopLossForNewEntries: BASELINE_LIMITS.requireStopLossForNewEntries,
      maxOrdersPerMinute: BASELINE_LIMITS.maxOrdersPerMinute,
      priceBandPct: BASELINE_LIMITS.priceBandPct,
      allowedVaultAddresses: [],
      maxExpiresAfterWindowMs: BASELINE_LIMITS.maxExpiresAfterWindowMs,
      allowedOrigins: [...BASELINE_LIMITS.allowedOrigins],
      exemptReduceOnlyFromNotionalCaps: true,
      ...(extras.spotCoins && extras.spotCoins.length > 0 ? { allowedSpotCoins: [...extras.spotCoins] } : {}),
      ...(extras.referralCode ? { referralCode: extras.referralCode } : {}),
    },
  });
}

/** Result of {@link applyUserLimits}. */
export type ApplyLimitsResult = { ok: true; policy: Policy; limits: UserLimits | null } | { ok: false; fields: string[]; message: string };

/**
 * Applies user limits on top of the baseline. Every field must be at least as strict as the baseline; otherwise
 * nothing is applied and the loosening fields are listed. `{}` resets to the baseline.
 */
export function applyUserLimits(baseline: Policy, limits: UserLimits): ApplyLimitsResult {
  const loosening: string[] = [];
  const num = (field: "maxOrderNotionalUsd" | "maxDailyNotionalUsd" | "maxOrdersPerMinute" | "priceBandPct") => {
    const value = limits[field];
    if (value !== undefined && !(value <= baseline[field])) loosening.push(field);
  };
  num("maxOrderNotionalUsd");
  num("maxDailyNotionalUsd");
  num("maxOrdersPerMinute");
  num("priceBandPct");
  if (limits.maxLeverage !== undefined && !(limits.maxLeverage <= baseline.maxLeverage)) loosening.push("maxLeverage");
  if (limits.allowedCoins !== undefined && baseline.allowedCoins !== "*") {
    const base = baseline.allowedCoins;
    if (!limits.allowedCoins.every((c) => base.includes(c))) loosening.push("allowedCoins");
  }
  if (limits.requireStopLossForNewEntries === false && baseline.requireStopLossForNewEntries) loosening.push("requireStopLossForNewEntries");
  if (limits.allowedActionTypes !== undefined && !limits.allowedActionTypes.every((t) => (baseline.allowedActionTypes as readonly string[]).includes(t))) {
    loosening.push("allowedActionTypes");
  }
  if (loosening.length > 0) {
    return { ok: false, fields: loosening, message: `setLimits may only tighten the frame's baseline policy; these fields would loosen it: ${loosening.join(", ")}` };
  }
  const cleaned: UserLimits = {};
  if (limits.maxOrderNotionalUsd !== undefined) cleaned.maxOrderNotionalUsd = limits.maxOrderNotionalUsd;
  if (limits.maxDailyNotionalUsd !== undefined) cleaned.maxDailyNotionalUsd = limits.maxDailyNotionalUsd;
  if (limits.maxLeverage !== undefined) cleaned.maxLeverage = limits.maxLeverage;
  if (limits.maxOrdersPerMinute !== undefined) cleaned.maxOrdersPerMinute = limits.maxOrdersPerMinute;
  if (limits.priceBandPct !== undefined) cleaned.priceBandPct = limits.priceBandPct;
  if (limits.allowedCoins !== undefined) cleaned.allowedCoins = [...new Set(limits.allowedCoins)];
  if (limits.requireStopLossForNewEntries === true) cleaned.requireStopLossForNewEntries = true;
  if (limits.allowedActionTypes !== undefined) cleaned.allowedActionTypes = [...new Set(limits.allowedActionTypes)];
  const policy = parsePolicy({ ...baseline, ...cleaned });
  return { ok: true, policy, limits: Object.keys(cleaned).length > 0 ? cleaned : null };
}

/** Most sub-accounts with their own limits a frame keeps (HL allows 50 per master). */
export const MAX_ACCOUNT_LIMITS = 64;

/** Per-sub-account limits set with `setLimits({ account, … })`. */
export interface AccountLimits {
  policy: Policy;
  limits: UserLimits;
}

/** The policy for an account: the sub-account's own limits when set, else the master's. */
export function policyForAccount(masterPolicy: Policy, accountLimits: ReadonlyMap<string, AccountLimits>, subAccount: string | undefined): Policy {
  if (subAccount === undefined) return masterPolicy;
  return accountLimits.get(subAccount.toLowerCase())?.policy ?? masterPolicy;
}

/** The limits for an account (see {@link policyForAccount}). */
export function limitsForAccount(masterLimits: UserLimits | null, accountLimits: ReadonlyMap<string, AccountLimits>, subAccount: string | undefined): UserLimits | null {
  if (subAccount === undefined) return masterLimits;
  return accountLimits.get(subAccount.toLowerCase())?.limits ?? masterLimits;
}

/** Summary of the effective policy for `getStatus`. */
export function summarizeFramePolicy(policy: Policy, userLimits: UserLimits | null, accountLimits: ReadonlyMap<string, AccountLimits> = new Map()): PolicySummary {
  const builder = policy.requiredBuilder;
  if (!builder) throw new Error("The frame policy always requires a builder");
  return {
    allowedActionTypes: [...policy.allowedActionTypes] as AllowedActionType[],
    allowedCoins: policy.allowedCoins === "*" ? "*" : [...policy.allowedCoins],
    maxOrderNotionalUsd: policy.maxOrderNotionalUsd,
    maxDailyNotionalUsd: policy.maxDailyNotionalUsd,
    maxLeverage: policy.maxLeverage >= NO_GLOBAL_LEVERAGE_CAP ? "market" : policy.maxLeverage,
    maxOrdersPerMinute: policy.maxOrdersPerMinute,
    priceBandPct: policy.priceBandPct,
    requireStopLossForNewEntries: policy.requireStopLossForNewEntries,
    builder: { address: builder.b, feeTenthsBps: builder.f },
    vaultAddressAllowed: false,
    ownSubAccountsAllowed: true,
    expiresAfterMs: EXPIRES_AFTER_MS,
    allowedOrigins: (policy.allowedOrigins ?? ["manual", "ai_ticket"]).filter((o): o is "manual" | "ai_ticket" => o !== "guardian"),
    spotCoins: [...(policy.allowedSpotCoins ?? [])],
    referralCode: policy.referralCode ?? null,
    userLimits: userLimits === null ? null : structuredClone(userLimits),
    accountLimits: Object.fromEntries([...accountLimits].map(([account, a]) => [account, structuredClone(a.limits)])) as Record<`0x${string}`, UserLimits>,
  };
}

/** Coins an action touches (from the compiled intent). Account actions touch none. */
export function intentCoins(compiled: { intent: ActionIntent | AccountIntent }): string[] {
  const i = compiled.intent;
  switch (i.kind) {
    case "setReferrer":
    case "startFeeTrial":
      return [];
    case "order":
    case "updateLeverage":
    case "updateIsolatedMargin":
      return [i.coin];
    case "modify":
      return [i.order.coin];
    case "cancel":
      return [...new Set(i.cancels.map((c) => c.coin))];
    case "scheduleCancel":
    case "noop":
      return [];
  }
}

interface WireOrder {
  a?: unknown;
  b?: unknown;
  p?: unknown;
  s?: unknown;
  r?: unknown;
  t?: { trigger?: { triggerPx?: unknown } } | unknown;
}

function wireOrders(action: Record<string, unknown>): WireOrder[] {
  if (action.type === "order" && Array.isArray(action.orders)) return action.orders as WireOrder[];
  if (action.type === "modify" && typeof action.order === "object" && action.order !== null) return [action.order as WireOrder];
  if (action.type === "batchModify" && Array.isArray(action.modifies)) {
    return (action.modifies as Array<{ order?: unknown }>).map((m) => (m?.order ?? {}) as WireOrder);
  }
  return [];
}

/** Number of orders an action creates (counts toward the per-minute limit; cancels count 0). */
export function orderCount(action: Record<string, unknown>): number {
  return wireOrders(action).length;
}

/**
 * Notional (USD) counted against the daily limit: for each non-reduce-only order, size × max(limit price, trigger
 * price, mark). Reduce-only orders are exempt, as in the baseline policy.
 */
export function actionNotionalUsd(action: Record<string, unknown>, registry: MarketRegistry, markPrices: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const o of wireOrders(action)) {
    if (o.r === true) continue;
    const size = Number(o.s);
    const px = Number(o.p);
    const trig = typeof o.t === "object" && o.t !== null && "trigger" in o.t ? Number((o.t as { trigger?: { triggerPx?: unknown } }).trigger?.triggerPx) : NaN;
    const coin = typeof o.a === "number" ? registry.getByAssetId(o.a)?.coin : undefined;
    const mark = coin !== undefined ? markPrices[coin] : undefined;
    const price = Math.max(...[px, trig, mark ?? NaN].filter((x) => Number.isFinite(x)));
    if (Number.isFinite(size) && Number.isFinite(price)) total += size * price;
  }
  return total;
}

/** Inputs of {@link evaluateFramePolicy}. */
export interface FramePolicyInput {
  compiled: CompiledAction;
  expiresAfter: number;
  now: number;
  /** Effective policy (baseline + user limits). */
  policy: Policy;
  /** Whether the user tightened `maxLeverage` (else the per-market maximum is the only cap). */
  registry: MarketRegistry;
  markPrices: Readonly<Record<string, number>>;
  /**
   * Book mids the frame fetched from HL itself (never from the parent). Optional: they refine which limits count as
   * marketable (executes now: `priceBandPct`) versus resting (up to `RESTING_PRICE_BAND_PCT` from mark).
   */
  midPrices?: Readonly<Record<string, string | number>>;
  /** Orders this agent signed in the last minute, across every account. */
  ordersInLastMinute: number;
  /** Notional already signed today for the account the action is for (checked against the account's own limit). */
  dailyNotionalUsedUsd: number;
  /**
   * Notional this agent signed today across every account, checked against the baseline daily cap so spreading
   * orders over sub-accounts can't multiply it. Omitted: `dailyNotionalUsedUsd` (single account).
   */
  agentDailyNotionalUsedUsd?: number;
  /** The account's current leverage per coin, when known (only fetched when `maxLeverage` was tightened). */
  leverageByCoin?: Readonly<Record<string, number>>;
  /**
   * The sub-account the frame itself found in HL's `subAccounts` list of the key's master (never taken from the
   * parent). An action with `vaultAddress` is denied unless it equals this address.
   */
  ownedSubAccount?: `0x${string}`;
}

/** Decision of {@link evaluateFramePolicy}. */
export interface FramePolicyDecision {
  allowed: boolean;
  violations: PolicyViolation[];
  actionType: string;
}

/** Effective leverage cap for the coins of an action: `min(policy cap, each market's maximum)`. */
export function leverageCapFor(policy: Policy, registry: MarketRegistry, coins: readonly string[]): number {
  let cap = policy.maxLeverage;
  for (const coin of coins) {
    const m = registry.get(coin);
    if (m) cap = Math.min(cap, m.maxLeverage);
  }
  return cap;
}

/**
 * Evaluates an action about to be signed. Denies unless both the compiled and the wire evaluation pass and the
 * frame's own rules hold.
 */
export function evaluateFramePolicy(input: FramePolicyInput): FramePolicyDecision {
  const coins = intentCoins(input.compiled);
  const cap = leverageCapFor(input.policy, input.registry, coins);
  const violations: PolicyViolation[] = [];
  const add = (v: PolicyViolation) => {
    if (!violations.some((x) => x.code === v.code && x.message === v.message)) violations.push(v);
  };
  // Frame rule: the master account, or one of its own sub-accounts as verified by the frame on HL. The policy
  // object's allowedVaultAddresses is ignored: it is replaced by the verified address or by nothing.
  const wireVault = lowerOrUndefined(input.compiled.vaultAddress);
  const intentVault = lowerOrUndefined(input.compiled.intent.vaultAddress);
  const owned = lowerOrUndefined(input.ownedSubAccount);
  let allowedVaults: `0x${string}`[] = [];
  if (wireVault !== undefined || intentVault !== undefined) {
    if (wireVault !== intentVault) {
      add({ code: "VAULT_NOT_ALLOWED", message: "The signed vaultAddress differs from the intent's." });
    } else if (owned === undefined || owned !== wireVault) {
      add({ code: "VAULT_NOT_ALLOWED", message: `The signer frame acts only for the master account and its own sub-accounts; ${wireVault} is not a sub-account of this key's master on Hyperliquid.` });
    } else {
      allowedVaults = [owned];
    }
    // Frame rule: stablecoin conversions are for the master account only.
    const intent = input.compiled.intent;
    if (intent.kind === "order" && input.registry.get(intent.coin)?.kind === "spot") {
      add({ code: "VAULT_NOT_ALLOWED", message: "Stablecoin conversions are for the main account only." });
    }
  }
  const policy: Policy = {
    ...input.policy,
    allowedVaultAddresses: allowedVaults,
    ...(cap === input.policy.maxLeverage ? {} : { maxLeverage: Math.max(1, Math.floor(cap)) }),
  };
  // Frame rule: the baseline daily cap holds per agent, across every account.
  if (input.agentDailyNotionalUsedUsd !== undefined) {
    const action = input.compiled.action as unknown as Record<string, unknown>;
    const next = input.agentDailyNotionalUsedUsd + actionNotionalUsd(action, input.registry, input.markPrices);
    if (next > BASELINE_LIMITS.maxDailyNotionalUsd) {
      add({ code: "DAILY_NOTIONAL_EXCEEDED", message: `This device's key would pass the signer's daily limit of $${BASELINE_LIMITS.maxDailyNotionalUsd.toLocaleString("en-US")} across all accounts.` });
    }
  }
  const midPrices: Record<string, number> = {};
  for (const [coin, raw] of Object.entries(input.midPrices ?? {})) {
    const mid = Number(raw);
    if (Number.isFinite(mid) && mid > 0) midPrices[coin] = mid;
  }
  const context = {
    policy,
    now: input.now,
    markPrices: input.markPrices,
    midPrices,
    dailyNotionalUsedUsd: input.dailyNotionalUsedUsd,
    ordersInLastMinute: input.ordersInLastMinute,
    registry: input.registry,
    expiresAfter: input.expiresAfter,
    ...(input.leverageByCoin !== undefined ? { leverageByCoin: input.leverageByCoin } : {}),
  };
  const compiledDecision = evaluatePolicy({ kind: "compiled", compiled: input.compiled, expiresAfter: input.expiresAfter }, context);
  for (const v of compiledDecision.violations) add(v);
  const wireAction = input.compiled.action as unknown as { type: string } & Record<string, unknown>;
  const wireDecision = evaluatePolicy(
    {
      kind: "wire",
      action: wireAction,
      expiresAfter: input.expiresAfter,
      origin: input.compiled.intent.origin,
      ...(input.compiled.vaultAddress !== undefined ? { vaultAddress: input.compiled.vaultAddress } : {}),
    },
    context,
  );
  for (const v of wireDecision.violations) add(v);
  return { allowed: violations.length === 0, violations, actionType: wireDecision.actionType };
}

/** Inputs of {@link evaluateFrameAccountPolicy}. */
export interface FrameAccountPolicyInput {
  compiled: CompiledAccountAction;
  expiresAfter: number;
  now: number;
  /** Effective policy of the master account (account actions never act for a sub-account). */
  policy: Policy;
  /**
   * `setReferrer` only: what the frame itself read from HL `referral` for the master (true: a referrer is already set)
   * and whether this key already signed one (persisted). Either one denies.
   */
  referrer?: { alreadyReferred: boolean; signedBefore: boolean };
}

/**
 * Evaluates an account action (`setReferrer`, `startFeeTrial`) about to be signed: the shared policy on the exact wire
 * action (no `vaultAddress`: the master account only), plus the frame's "once" rule for `setReferrer`.
 */
export function evaluateFrameAccountPolicy(input: FrameAccountPolicyInput): FramePolicyDecision {
  const violations: PolicyViolation[] = [];
  const add = (v: PolicyViolation) => {
    if (!violations.some((x) => x.code === v.code && x.message === v.message)) violations.push(v);
  };
  const wireAction = input.compiled.action as unknown as { type: string } & Record<string, unknown>;
  const decision = evaluatePolicy(
    { kind: "wire", action: wireAction, expiresAfter: input.expiresAfter, origin: input.compiled.intent.origin },
    { policy: { ...input.policy, allowedVaultAddresses: [] }, now: input.now, markPrices: {}, dailyNotionalUsedUsd: 0, ordersInLastMinute: 0, expiresAfter: input.expiresAfter },
  );
  for (const v of decision.violations) add(v);
  if (wireAction.type === "setReferrer") {
    if (!input.referrer) add({ code: "REFERRER_ACTION_DENIED", message: "The signer could not check the account's referrer." });
    else {
      if (input.referrer.alreadyReferred) add({ code: "REFERRER_ACTION_DENIED", message: "This account already has a referrer on Hyperliquid." });
      if (input.referrer.signedBefore) add({ code: "REFERRER_ACTION_DENIED", message: "This trading key already set the referral code once." });
    }
  }
  return { allowed: violations.length === 0, violations, actionType: decision.actionType };
}

function lowerOrUndefined(address: string | undefined): `0x${string}` | undefined {
  return address === undefined ? undefined : (address.toLowerCase() as `0x${string}`);
}

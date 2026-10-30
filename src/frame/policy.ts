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
 * `priceBandPct` (5% baseline, user-tightenable) of HL's mark; resting GTC/ALO limits that don't cross may sit up to
 * `RESTING_PRICE_BAND_PCT` (50%) away; untriggered triggers likewise. Mark and mid always come from the frame's own
 * HL reads.
 *
 * The frame adds four things the shared policy has no field for: the per-market leverage cap (the baseline's 50x or
 * the user's limit, never above each market's own maximum), a hard `vaultAddress` rule independent of the policy object (only a sub-account that the
 * frame itself found in HL's `subAccounts` list of the key's master; HL vaults and anything else are denied), the
 * notional counted against the daily limit, and the agent-wide baseline daily cap across all accounts.
 *
 * Personal limits (`setLimits`) are kept per account: the master's, and optionally one set per sub-account, applied on
 * top of the master's: each field is the stricter of the two (the lower number, the markets and actions both allow, a
 * stop-loss when either requires one), so a sub-account's limits set earlier never escape a later tightening of the
 * master's; a field it leaves out keeps the master's value, and without limits of its own it uses the master's.
 * Orders per minute are counted per agent across accounts. Daily notional is counted per agent for the
 * baseline cap, and for personal limits once for the master and every sub-account without a daily limit of its own
 * (they share the master's), and separately for each sub-account that sets `maxDailyNotionalUsd`. The frame stores
 * them itself (`core.ts`); {@link limitChanges} tells a tightening, applied silently, from a loosening, which needs the
 * user's click in the frame.
 *
 * Spot, for the master account only:
 * - Convert stablecoins (PHASE3 REV): orders only on the pinned stablecoin/USDC pairs of the frame's network
 *   (`allowedSpotCoins`), each checked against the `spotMeta` the frame fetches itself; one IOC order, the builder on
 *   sells and none on buys.
 * - Spot trading (PHASE3 SPOT), off until the parent sets `spotTrading: true`: also the verified token/USDC pairs
 *   (shared `VERIFIED_SPOT_PAIRS`, Hyperliquid's "Strict" list), each checked against the frame's own `spotMeta`, with
 *   market orders and IOC, GTC and post-only limits within the bands (shared `spotTrading`). On mainnet one order on a
 *   verified pair may be at most 10% of its 24 h volume, as the frame read it (shared `spotOrderVolumeProblem`). No
 *   triggers (Hyperliquid's app offers none on spot), no reduce-only, no modify. Every other spot market is denied.
 *
 * Revenue actions (PHASE3 REV), for the master account only:
 * - `startFeeTrial`: allowed (it is in the baseline action types).
 * - `setReferrer`: only with the frame's configured referral code (`referralCode`, from the build, never from the
 *   parent), only while HL reports no referrer for the account and at most once per key (see `core.ts`).
 *
 * @module
 */
import type { AccountIntent, CompiledAccountAction, CompiledAction } from "@kokoah/shared/actions";
import type { ActionIntent } from "@kokoah/shared/intents";
import type { MarketRegistry } from "@kokoah/shared/markets";
import { vaultTransferProblems } from "@kokoah/shared/vaults";
import { type AccountBook, createManualTradingPolicy, evaluatePolicy, parsePolicy, type Policy, type PolicyViolation, spotOrderVolumeProblem } from "@kokoah/shared/policy";
import * as v from "valibot";
import { BASELINE_ACTION_TYPES, EXPIRES_AFTER_MS, type AllowedActionType, type PolicySummary, type UserLimits } from "../protocol/index.js";
import { PARAMS_SCHEMAS } from "./messages.js";

/** Baseline limits compiled into the frame. The parent can only tighten them. */
export const BASELINE_LIMITS = Object.freeze({
  allowedActionTypes: [...BASELINE_ACTION_TYPES] as AllowedActionType[],
  allowedCoins: "*" as const,
  maxOrderNotionalUsd: 250_000,
  maxDailyNotionalUsd: 25_000_000,
  /** Each market's own maximum applies below it. */
  maxLeverage: 50,
  maxOrdersPerMinute: 60,
  /** Signed actions of any kind (cancels, leverage, noop… too) per minute, so none can be looped without limit. */
  maxActionsPerMinute: 120,
  priceBandPct: 5,
  requireStopLossForNewEntries: false,
  /**
   * Where the user's limits require a stop-loss: it must be within this % of the entry, on the losing side (as for the
   * servers' keys), so a token stop half the price away doesn't count.
   */
  maxStopLossDistancePct: 25,
  /** `expiresAfter` is mandatory and at most this far ahead (the frame itself uses 15 s). */
  maxExpiresAfterWindowMs: 30_000,
  allowedOrigins: ["manual", "ai_ticket"] as Array<"manual" | "ai_ticket">,
});

/**
 * Frame action types the shared policy has no place for: vault transfers are the one fund movement a trading key may
 * make, checked on their own rules (`evaluateFrameAccountPolicy`); the shared policy hard-denies them everywhere else.
 * They stay in the user's limits (`allowedActionTypes`) and are left out of the shared `Policy` built from them.
 */
export const FRAME_ONLY_ACTION_TYPES: readonly AllowedActionType[] = Object.freeze(["vaultTransfer"]);

/** The shared policy's part of a list of frame action types. */
function sharedActionTypes(types: readonly AllowedActionType[]): Policy["allowedActionTypes"] {
  return types.filter((t) => !FRAME_ONLY_ACTION_TYPES.includes(t)) as Policy["allowedActionTypes"];
}

/** Whether limits (the master's) leave vault transfers on: without `allowedActionTypes`, every baseline type is. */
export function vaultTransfersAllowed(limits: UserLimits | null): boolean {
  return limits?.allowedActionTypes === undefined || limits.allowedActionTypes.includes("vaultTransfer");
}

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
      allowedActionTypes: sharedActionTypes(BASELINE_LIMITS.allowedActionTypes),
      allowedCoins: "*",
      maxOrderNotionalUsd: BASELINE_LIMITS.maxOrderNotionalUsd,
      maxDailyNotionalUsd: BASELINE_LIMITS.maxDailyNotionalUsd,
      maxLeverage: BASELINE_LIMITS.maxLeverage,
      requireStopLossForNewEntries: BASELINE_LIMITS.requireStopLossForNewEntries,
      maxStopLossDistancePct: BASELINE_LIMITS.maxStopLossDistancePct,
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
 * nothing is applied and the loosening fields are listed. `{}` resets to the baseline, with spot trading off.
 *
 * Spot trading is the one setting that starts off: `spotTrading: true` adds `spot.tradingCoins` (the verified pairs
 * the frame can trade, all within its baseline) to the policy's `allowedSpotCoins` and sets the shared `spotTrading`
 * flag; omitted or `false` leaves Convert's stablecoin pairs with IOC orders only.
 */
export function applyUserLimits(baseline: Policy, limits: UserLimits, spot: { tradingCoins: readonly string[] } = { tradingCoins: [] }): ApplyLimitsResult {
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
  if (limits.allowedActionTypes !== undefined && !limits.allowedActionTypes.every((t) => frameActionTypes(baseline).includes(t))) {
    loosening.push("allowedActionTypes");
  }
  if (loosening.length > 0) {
    return { ok: false, fields: loosening, message: `setLimits may only tighten the frame's baseline policy; these fields would loosen it: ${loosening.join(", ")}` };
  }
  if (limits.allowedActionTypes !== undefined && sharedActionTypes(limits.allowedActionTypes).length === 0) {
    return { ok: false, fields: ["allowedActionTypes"], message: "allowedActionTypes must keep at least one action besides vaultTransfer" };
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
  if (limits.spotTrading === true) cleaned.spotTrading = true;
  return { ok: true, policy: withLimits(baseline, cleaned, spot.tradingCoins), limits: Object.keys(cleaned).length > 0 ? cleaned : null };
}

/**
 * `policy` with already validated limits on top: each field set in `limits` replaces the policy's, every other field
 * keeps the policy's value.
 */
function withLimits(policy: Policy, limits: UserLimits, tradingCoins: readonly string[]): Policy {
  const { spotTrading, allowedActionTypes, ...policyLimits } = limits;
  return parsePolicy({
    ...policy,
    ...policyLimits,
    ...(allowedActionTypes !== undefined ? { allowedActionTypes: sharedActionTypes(allowedActionTypes) } : {}),
    ...(spotTrading ? { allowedSpotCoins: [...new Set([...(policy.allowedSpotCoins ?? []), ...tradingCoins])], spotTrading: true } : {}),
  });
}

/** Every action type `baseline` allows, the frame's own ones included. */
function frameActionTypes(baseline: Policy): readonly string[] {
  return [...baseline.allowedActionTypes, ...FRAME_ONLY_ACTION_TYPES];
}

/** Most sub-accounts with their own limits a frame keeps (HL allows 50 per master). */
export const MAX_ACCOUNT_LIMITS = 64;

/**
 * A sub-account's own limits, set with `setLimits({ account, … })` and checked against the baseline. They apply on top
 * of the master's, field by field the stricter of the two (see {@link policyForAccount}).
 */
export interface AccountLimits {
  limits: UserLimits;
}

const NUMBER_LIMITS = ["maxOrderNotionalUsd", "maxDailyNotionalUsd", "maxLeverage", "maxOrdersPerMinute", "priceBandPct"] as const;

/**
 * The policy for an account: the master's, with a sub-account's own limits on top. Each field the sub-account sets is
 * the stricter of its value and the master's: the lower number, the markets and action types both allow (none when
 * they share none), spot trading only when both have it; the stop-loss requirement and every other field are the
 * master's when the sub-account doesn't add them. So a sub-account that sets only `maxLeverage` still has the master's
 * notional and stop-loss rules, and limits a sub-account set earlier never escape a later tightening of the master's.
 * `tradingCoins`: the verified spot pairs `spotTrading` adds (see {@link applyUserLimits}).
 */
export function policyForAccount(
  masterPolicy: Policy,
  accountLimits: ReadonlyMap<string, AccountLimits>,
  subAccount: string | undefined,
  tradingCoins: readonly string[] = [],
): Policy {
  const own = subAccount === undefined ? undefined : accountLimits.get(subAccount.toLowerCase());
  if (own === undefined) return masterPolicy;
  const { allowedCoins, allowedActionTypes, spotTrading, ...rest } = own.limits;
  const numbers: UserLimits = { ...rest };
  for (const field of NUMBER_LIMITS) if (rest[field] !== undefined) numbers[field] = Math.min(rest[field], masterPolicy[field]);
  const policy = withLimits(masterPolicy, { ...numbers, ...(spotTrading === true && masterPolicy.spotTrading === true ? { spotTrading } : {}) }, tradingCoins);
  // The lists are narrowed after the schema check: one that keeps nothing (an empty list) allows nothing.
  return {
    ...policy,
    ...(allowedCoins !== undefined ? { allowedCoins: masterPolicy.allowedCoins === "*" ? [...allowedCoins] : allowedCoins.filter((c) => masterPolicy.allowedCoins.includes(c)) } : {}),
    ...(allowedActionTypes !== undefined ? { allowedActionTypes: sharedActionTypes(allowedActionTypes).filter((t) => masterPolicy.allowedActionTypes.includes(t)) } : {}),
  };
}

/** The limits in force for an account: the master's, with a sub-account's own fields on top, each the stricter of the two (see {@link policyForAccount}). */
export function limitsForAccount(masterLimits: UserLimits | null, accountLimits: ReadonlyMap<string, AccountLimits>, subAccount: string | undefined): UserLimits | null {
  const own = subAccount === undefined ? undefined : accountLimits.get(subAccount.toLowerCase());
  if (own === undefined) return masterLimits;
  const out: UserLimits = { ...masterLimits, ...own.limits };
  for (const field of NUMBER_LIMITS) {
    const a = own.limits[field];
    const b = masterLimits?.[field];
    if (a !== undefined && b !== undefined) out[field] = Math.min(a, b);
  }
  for (const field of ["allowedCoins", "allowedActionTypes"] as const) {
    const a = own.limits[field] as readonly string[] | undefined;
    const b = masterLimits?.[field] as readonly string[] | undefined;
    if (a !== undefined && b !== undefined) (out as Record<string, unknown>)[field] = a.filter((x) => b.includes(x));
  }
  if (own.limits.spotTrading === true && masterLimits?.spotTrading !== true) delete out.spotTrading;
  return out;
}

/**
 * Sub-accounts whose own limits set `maxDailyNotionalUsd` (lowercase): each has its own daily counter. Every other
 * sub-account shares the master's daily limit and counter, whatever else its own limits set.
 */
export function separateDailyAccounts(accountLimits: ReadonlyMap<string, AccountLimits>): string[] {
  return [...accountLimits].filter(([, a]) => a.limits.maxDailyNotionalUsd !== undefined).map(([account]) => account.toLowerCase());
}

/**
 * Limits read back from the frame's storage, checked again as if the parent had sent them: a field that no longer
 * parses or no longer fits this build's baseline (a later build may have tightened it) is dropped, so the baseline's
 * own, stricter value applies. Action types this build doesn't know are left out of `allowedActionTypes`.
 */
export function storedUserLimits(baseline: Policy, raw: unknown): UserLimits | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const parsed: UserLimits = {};
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (field === "account") continue;
    const known = field === "allowedActionTypes" && Array.isArray(value) ? value.filter((t) => (BASELINE_ACTION_TYPES as readonly unknown[]).includes(t)) : value;
    const one = v.safeParse(PARAMS_SCHEMAS.setLimits, { [field]: known });
    if (one.success) Object.assign(parsed, one.output);
  }
  let r = applyUserLimits(baseline, parsed);
  if (!r.ok) {
    for (const field of r.fields) delete parsed[field as keyof UserLimits];
    r = applyUserLimits(baseline, parsed);
  }
  return r.ok ? r.limits : null;
}

/** The user's limits as the frame keeps them: the master's, and each sub-account's own (lowercase address). */
export interface LimitsSet {
  master: UserLimits | null;
  accounts: ReadonlyMap<string, AccountLimits>;
}

/** One difference {@link limitChanges} found, in plain words for the frame's prompt. */
export interface LimitChange {
  field: keyof UserLimits;
  /** E.g. `Largest order: $100 → $5,000`. */
  text: string;
  /** True when the account may do more than before. */
  looser: boolean;
}

const usd = (n: number): string => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** Up to six names. Coin names come from the parent: anything but printable ASCII (bidi controls…) shows as `?`. */
function names(items: readonly string[]): string {
  const shown = items.slice(0, 6).map((x) => x.replace(/[^\x21-\x7e]/g, "?"));
  return items.length > 6 ? `${shown.join(", ")} and ${items.length - 6} more` : shown.join(", ");
}

/**
 * What changes for one account (`subAccount`, or the master when undefined) between the limits in force `before` and
 * `after` a `setLimits`, compared on effective values: the account's own field, else the master's (for a sub-account),
 * else the baseline's. Anything that lets the account do more is `looser`: a higher number, a field removed (the
 * baseline or the master's looser value applies again), more markets or action types, spot trading on, the stop-loss
 * requirement off. A sub-account that gets a daily counter of its own while the master has a daily limit is looser
 * too, whatever the number: its trading no longer uses up the master's limit, so the day's total can grow by it.
 */
export function limitChanges(baseline: Policy, before: LimitsSet, after: LimitsSet, subAccount?: string): LimitChange[] {
  const sub = subAccount?.toLowerCase();
  const b = limitsForAccount(before.master, before.accounts, sub) ?? {};
  const a = limitsForAccount(after.master, after.accounts, sub) ?? {};
  const changes: LimitChange[] = [];
  const add = (field: keyof UserLimits, label: string, from: string, to: string, looser: boolean) => {
    if (from !== to) changes.push({ field, text: `${label}: ${from} → ${to}`, looser });
  };
  const number = (field: "maxOrderNotionalUsd" | "maxDailyNotionalUsd" | "maxLeverage" | "maxOrdersPerMinute" | "priceBandPct", label: string, show: (n: number) => string) => {
    const from = b[field] ?? baseline[field];
    const to = a[field] ?? baseline[field];
    if (from !== to) add(field, label, show(from), show(to), to > from);
  };
  number("maxOrderNotionalUsd", "Largest order", usd);
  const ownDailyBefore = sub === undefined ? undefined : before.accounts.get(sub)?.limits.maxDailyNotionalUsd;
  const ownDailyAfter = sub === undefined ? undefined : after.accounts.get(sub)?.limits.maxDailyNotionalUsd;
  const sharedDaily = after.master?.maxDailyNotionalUsd;
  if (ownDailyBefore === undefined && ownDailyAfter !== undefined && sharedDaily !== undefined) {
    // What is enforced: the stricter of its own and the master's (limitsForAccount).
    add("maxDailyNotionalUsd", "Trading per day", `${usd(sharedDaily)} shared with the main account`, `${usd(a.maxDailyNotionalUsd ?? ownDailyAfter)} of its own, on top of the main account's`, true);
  } else number("maxDailyNotionalUsd", "Trading per day", usd);
  number("maxLeverage", "Leverage", (n) => `up to ${n}x`);
  number("maxOrdersPerMinute", "Orders per minute", String);
  number("priceBandPct", "Price distance from the market", (n) => `${n}%`);
  const set = (field: "allowedCoins" | "allowedActionTypes", label: string, all: readonly string[] | "*") => {
    const from = b[field] ?? all;
    const to = a[field] ?? all;
    const show = (x: readonly string[] | "*") => (x === "*" || (all !== "*" && all.every((t) => x.includes(t))) ? "all" : names(x));
    const looser = to === "*" ? from !== "*" : from !== "*" && to.some((x) => !from.includes(x));
    const tighter = from === "*" ? to !== "*" : to !== "*" && from.some((x) => !to.includes(x));
    if (looser || tighter) add(field, label, show(from), show(to), looser);
  };
  set("allowedCoins", "Markets", "*");
  set("allowedActionTypes", "Allowed actions", frameActionTypes(baseline));
  const stopBefore = b.requireStopLossForNewEntries === true || baseline.requireStopLossForNewEntries;
  const stopAfter = a.requireStopLossForNewEntries === true || baseline.requireStopLossForNewEntries;
  add("requireStopLossForNewEntries", "Stop-loss on new positions", stopBefore ? "required" : "not required", stopAfter ? "required" : "not required", stopBefore && !stopAfter);
  add("spotTrading", "Spot trading", b.spotTrading === true ? "on" : "off", a.spotTrading === true ? "on" : "off", a.spotTrading === true && b.spotTrading !== true);
  return changes;
}

/** Summary of the effective policy for `getStatus`. `spotTradingCoins`: the verified pairs spot trading would add. */
export function summarizeFramePolicy(
  policy: Policy,
  userLimits: UserLimits | null,
  accountLimits: ReadonlyMap<string, AccountLimits> = new Map(),
  spotTradingCoins: readonly string[] = [],
): PolicySummary {
  const builder = policy.requiredBuilder;
  if (!builder) throw new Error("The frame policy always requires a builder");
  return {
    allowedActionTypes: [...policy.allowedActionTypes, ...(vaultTransfersAllowed(userLimits) ? FRAME_ONLY_ACTION_TYPES : [])] as AllowedActionType[],
    allowedCoins: policy.allowedCoins === "*" ? "*" : [...policy.allowedCoins],
    maxOrderNotionalUsd: policy.maxOrderNotionalUsd,
    maxDailyNotionalUsd: policy.maxDailyNotionalUsd,
    maxLeverage: policy.maxLeverage,
    maxOrdersPerMinute: policy.maxOrdersPerMinute,
    priceBandPct: policy.priceBandPct,
    requireStopLossForNewEntries: policy.requireStopLossForNewEntries,
    builder: { address: builder.b, feeTenthsBps: builder.f },
    vaultAddressAllowed: false,
    ownSubAccountsAllowed: true,
    expiresAfterMs: EXPIRES_AFTER_MS,
    // The browser key signs only the user's own orders and AI tickets; server origins (guardian, bot, telegram) never.
    allowedOrigins: (policy.allowedOrigins ?? ["manual", "ai_ticket"]).filter((o): o is "manual" | "ai_ticket" => o === "manual" || o === "ai_ticket"),
    spotCoins: [...(policy.allowedSpotCoins ?? [])],
    spotTrading: policy.spotTrading === true,
    spotTradingCoins: [...spotTradingCoins],
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
    case "hlpDeposit":
    case "vaultWithdraw":
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

/** Spot orders of an action (wire `order` only): coin, size and limit price. */
function spotLegs(action: Record<string, unknown>, registry: MarketRegistry): Array<{ coin: string; size: number; price: number }> {
  if (action.type !== "order") return [];
  const legs: Array<{ coin: string; size: number; price: number }> = [];
  for (const o of wireOrders(action)) {
    const market = typeof o.a === "number" ? registry.getByAssetId(o.a) : undefined;
    if (market?.kind !== "spot") continue;
    const size = Number(o.s);
    const price = Number(o.p);
    legs.push({ coin: market.coin, size: Number.isFinite(size) ? size : 0, price: Number.isFinite(price) ? price : 0 });
  }
  return legs;
}

/** A HIP-3 leg of a wire action that the mainnet dex pin applies to. */
export interface PinnedLeg {
  coin: string;
  /** The HIP-3 dex's name. */
  dex: string;
}

/**
 * The HIP-3 legs of a wire action that the mainnet dex pin (shared `perpDexs.ts`) applies to: everything but cancels
 * and reduce-only orders, that is orders and modifies that aren't reduce-only, and every leverage or isolated-margin
 * change (either way: adding margin or lowering leverage would move more of the account into a market whose mark the
 * deployer sets). Cancels and reduce-only orders (closes, position TP/SL) only take risk off, so they stay possible on
 * a dex that isn't pinned or whose deployer changed. `scheduleCancel` and `noop` touch no market.
 */
export function hip3PinnedLegs(action: Record<string, unknown>, registry: MarketRegistry): PinnedLeg[] {
  const legs: PinnedLeg[] = [];
  const add = (asset: unknown) => {
    const market = typeof asset === "number" ? registry.getByAssetId(asset) : undefined;
    if (market?.kind === "hip3") legs.push({ coin: market.coin, dex: market.dex });
  };
  switch (action.type) {
    case "order":
    case "modify":
    case "batchModify":
      for (const o of wireOrders(action)) if (o.r !== true) add(o.a);
      break;
    case "updateLeverage":
    case "updateIsolatedMargin":
      add(action.asset);
      break;
  }
  return legs;
}

/** Number of orders an action creates (counts toward the per-minute limit; cancels count 0). */
export function orderCount(action: Record<string, unknown>): number {
  return wireOrders(action).length;
}

/** Notional (USD) of one wire order: size × max(limit price, trigger price, mark); 0 when unreadable. */
function orderNotionalUsd(o: WireOrder, registry: MarketRegistry, markPrices: Readonly<Record<string, number>>): number {
  const size = Number(o.s);
  const px = Number(o.p);
  const trig = typeof o.t === "object" && o.t !== null && "trigger" in o.t ? Number((o.t as { trigger?: { triggerPx?: unknown } }).trigger?.triggerPx) : NaN;
  const coin = typeof o.a === "number" ? registry.getByAssetId(o.a)?.coin : undefined;
  const mark = coin !== undefined ? markPrices[coin] : undefined;
  const price = Math.max(...[px, trig, mark ?? NaN].filter((x) => Number.isFinite(x)));
  return Number.isFinite(size) && Number.isFinite(price) ? size * price : 0;
}

/**
 * Notional (USD) counted against the daily limit: for each non-reduce-only order, size × max(limit price, trigger
 * price, mark). Reduce-only orders are exempt, as in the baseline policy.
 */
export function actionNotionalUsd(action: Record<string, unknown>, registry: MarketRegistry, markPrices: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const o of wireOrders(action)) if (o.r !== true) total += orderNotionalUsd(o, registry, markPrices);
  return total;
}

/**
 * Orders whose notional is above this in all (every order of one action, reduce-only ones included, as
 * {@link describeOrders} counts it) are signed only after the user confirms the frame's description of them in its own
 * prompt (`core.ts`).
 */
export const CONFIRM_ORDERS_ABOVE_USD = 25_000;

/**
 * Orders the frame signed without a prompt count toward a rolling total over `UNPROMPTED_WINDOW_MS` (10 minutes,
 * nonces.ts; counted as {@link describeOrders} counts them, across every account): orders that would take it above
 * this need the same confirmation, so many orders just under {@link CONFIRM_ORDERS_ABOVE_USD} can't add up unseen. A
 * confirmed prompt that showed the total starts it again.
 */
export const CONFIRM_UNPROMPTED_ABOVE_USD = 100_000;

/**
 * The same over `UNPROMPTED_DAY_MS` (24 hours): the most a page can have the frame sign without the user seeing a
 * prompt in a day, however it spreads the orders out. Confirmed orders don't count; a confirmed prompt that showed the
 * total starts it again.
 */
export const CONFIRM_UNPROMPTED_DAY_ABOVE_USD = 250_000;

/** The orders of an action in plain words for the frame's prompt, and their notional in all. */
export interface OrdersDescription {
  /** One line per order, e.g. `Buy 0.3 BTC at $100,000 (limit) · about $30,000`. */
  lines: string[];
  /** Side, size and market of each order, e.g. `Buy 0.3 BTC`, for the prompt's title and button. */
  heads: string[];
  /** The action changes open orders (a modify) rather than placing new ones. */
  changes: boolean;
  /** Every order's size × max(limit price, trigger price, mark), reduce-only orders included. */
  totalUsd: number;
}

/** Market names come from Hyperliquid (a HIP-3 deployer chooses its own): anything but printable ASCII shows as `?`. */
export function printable(x: string): string {
  return x.replace(/[^\x20-\x7e]/g, "?");
}

const plain = (x: unknown): string => Number(x).toLocaleString("en-US", { maximumFractionDigits: 8 });

/**
 * What an action's orders do, from the exact wire action the frame signs: side, size and market, the limit price (a
 * market order's worst price) and trigger, reduce-only, and the notional of each. `marketOrder`: the first order is a
 * market order (compiled as IOC at its worst price). Actions without orders describe nothing.
 */
export function describeOrders(action: Record<string, unknown>, registry: MarketRegistry, markPrices: Readonly<Record<string, number>>, marketOrder = false): OrdersDescription {
  const lines: string[] = [];
  const heads: string[] = [];
  let totalUsd = 0;
  for (const [i, o] of wireOrders(action).entries()) {
    const market = typeof o.a === "number" ? registry.getByAssetId(o.a) : undefined;
    const name = printable(market?.displayName ?? market?.coin ?? `asset ${String(o.a)}`);
    const t = (typeof o.t === "object" && o.t !== null ? o.t : {}) as { limit?: { tif?: unknown }; trigger?: { isMarket?: unknown; triggerPx?: unknown; tpsl?: unknown } };
    const isBuy = o.b === true;
    let how: string;
    if (t.trigger) {
      const kind = t.trigger.tpsl === "tp" ? "take-profit" : "stop-loss";
      how = `${kind} at $${plain(t.trigger.triggerPx)}, then ${t.trigger.isMarket === true ? `at market (${isBuy ? "up to" : "down to"} $${plain(o.p)})` : `limit $${plain(o.p)}`}`;
    } else if (i === 0 && marketOrder) {
      how = `at market, ${isBuy ? "up to" : "down to"} $${plain(o.p)}`;
    } else {
      const tif = t.limit?.tif === "Alo" ? "post-only limit" : t.limit?.tif === "Ioc" ? "limit, fill now or cancel" : "limit";
      how = `at $${plain(o.p)} (${tif})`;
    }
    const notional = orderNotionalUsd(o, registry, markPrices);
    totalUsd += notional;
    const change = action.type === "order" ? "" : "Change an open order to: ";
    const head = `${isBuy ? "Buy" : "Sell"} ${plain(o.s)} ${name}`;
    heads.push(head);
    lines.push(`${change}${head} ${how}${o.r === true ? " · reduce-only" : ""} · about ${usd(notional)}`);
  }
  return { lines, heads, totalUsd, changes: action.type !== "order" };
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
  /** Network of the frame: sets the per-order volume cap on verified spot pairs (mainnet only). Default testnet. */
  network?: "mainnet" | "testnet";
  /** Verified (non-stablecoin) spot pairs in this action's registry: orders on them get the volume cap. */
  verifiedSpotCoins?: readonly string[];
  /** 24 h notional volume (USD) by spot coin, from the frame's own `spotMetaAndAssetCtxs` read. */
  spotDayVolumes?: Readonly<Record<string, number>>;
  /**
   * The account's positions and resting orders on the markets the action touches, as the frame read them from HL
   * itself (never from the parent). Where the policy requires a stop-loss, cancels and modifies may not take stop-loss
   * cover away from a position, and entries must leave the whole position covered (shared `stopCoverage.ts`): without
   * the book they are refused.
   */
  accountBook?: AccountBook;
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
    // Frame rule: spot (conversions and trading) is for the master account only.
    const intent = input.compiled.intent;
    if (intent.kind === "order" && input.registry.get(intent.coin)?.kind === "spot") {
      add({ code: "VAULT_NOT_ALLOWED", message: "Spot orders are for the main account only." });
    }
  }
  // Frame rule (mainnet): one order on a verified spot pair is at most 10% of the pair's 24 h volume.
  for (const leg of spotLegs(input.compiled.action as unknown as Record<string, unknown>, input.registry)) {
    if (!(input.verifiedSpotCoins ?? []).includes(leg.coin)) continue;
    const mark = input.markPrices[leg.coin];
    const px = Math.max(leg.price, typeof mark === "number" && Number.isFinite(mark) ? mark : 0);
    const problem = spotOrderVolumeProblem({
      network: input.network ?? "testnet",
      label: input.registry.get(leg.coin)?.displayName ?? leg.coin,
      notionalUsd: leg.size * px,
      dayVolumeUsd: input.spotDayVolumes?.[leg.coin],
    });
    if (problem) add({ code: "ORDER_NOTIONAL_EXCEEDED", message: problem });
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
    // Stops required: the stop-losses stay in place after an order is placed, read from HL by the frame itself.
    requireStopCoverage: true,
    ...(input.accountBook !== undefined ? { accountBook: input.accountBook } : {}),
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
  /**
   * `vaultTransfer` only: the facts the frame itself read from HL for the master (HLP deposits in the last 24 hours,
   * plus deposits this frame sent that the ledger may not show yet; or the account's equity in the vault it withdraws
   * from) and the frame's network. Missing facts deny.
   */
  vault?: { network: "mainnet" | "testnet"; hlpDepositedLast24hUsd?: number; heldEquityUsd?: number };
  /** `vaultTransfer` only: whether the master's limits leave vault transfers on ({@link vaultTransfersAllowed}). */
  vaultTransfersAllowed?: boolean;
}

/**
 * Evaluates an account action (`setReferrer`, `startFeeTrial`, vault transfers) about to be signed: the shared policy
 * on the exact wire action (no `vaultAddress`: the master account only), plus the frame's "once" rule for
 * `setReferrer`; vault transfers on their own rules (see below).
 */
export function evaluateFrameAccountPolicy(input: FrameAccountPolicyInput): FramePolicyDecision {
  const violations: PolicyViolation[] = [];
  const add = (v: PolicyViolation) => {
    if (!violations.some((x) => x.code === v.code && x.message === v.message)) violations.push(v);
  };
  const wireAction = input.compiled.action as unknown as { type: string } & Record<string, unknown>;
  // Vault transfers are the one fund movement a trading key may sign (HLP deposits within caps, withdrawals from a
  // vault the account holds; shared vaults/hlp.ts). The shared policy denies them for every other path, so they are
  // checked here on their own rules, with the same expiresAfter bounds as everything else.
  if (wireAction.type === "vaultTransfer") {
    const kind = input.compiled.intent.kind;
    if (kind !== "hlpDeposit" && kind !== "vaultWithdraw") add({ code: "VAULT_ACTION_DENIED", message: "Vault transfers come only from an HLP deposit or a vault withdrawal." });
    if (input.vaultTransfersAllowed !== true) add({ code: "ACTION_TYPE_NOT_ALLOWED", message: 'Vault deposits and withdrawals ("vaultTransfer") are not allowed by your limits.' });
    const window = input.policy.maxExpiresAfterWindowMs ?? BASELINE_LIMITS.maxExpiresAfterWindowMs;
    if (input.expiresAfter <= input.now) add({ code: "EXPIRES_AFTER_IN_PAST", message: "expiresAfter is already in the past." });
    else if (input.expiresAfter - input.now > window) add({ code: "EXPIRES_AFTER_TOO_FAR", message: `expiresAfter is more than ${window} ms in the future.` });
    if (!input.vault) add({ code: "VAULT_ACTION_DENIED", message: "The signer could not check the vault transfer." });
    else {
      const problems = vaultTransferProblems({
        network: input.vault.network,
        action: wireAction,
        ...(input.vault.hlpDepositedLast24hUsd !== undefined ? { hlpDepositedLast24hUsd: input.vault.hlpDepositedLast24hUsd } : {}),
        ...(input.vault.heldEquityUsd !== undefined ? { heldEquityUsd: input.vault.heldEquityUsd } : {}),
      });
      for (const p of problems) add({ code: p.code, message: p.message });
    }
    return { allowed: violations.length === 0, violations, actionType: "vaultTransfer" };
  }
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

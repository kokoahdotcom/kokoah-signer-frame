/**
 * The frame's signing policy: a baseline compiled into the frame, optionally tightened (never loosened) by the parent
 * with `setLimits`, and evaluated with `@kokoah/shared` `evaluatePolicy` before anything is signed.
 *
 * Evaluation runs twice on every action:
 * 1. on the **compiled** subject (intent + exact wire action: origin, builder, prices, notional, rate, leverage);
 * 2. on the **wire** subject built from the exact action object that will be hashed and signed (defense in depth: a
 *    compiler bug can't turn an allowed intent into, say, a transfer).
 *
 * The frame adds three things the shared policy has no field for: the per-market leverage cap (baseline = each
 * market's own maximum), a hard "no `vaultAddress`" rule independent of the policy object, and the notional counted
 * against the daily limit.
 *
 * @module
 */
import type { CompiledAction } from "@kokoah/shared/actions";
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

/** Builds the baseline `Policy` (shared schema) for a builder. */
export function createBaselinePolicy(builder: BuilderSetting): Policy {
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

/** Summary of the effective policy for `getStatus`. */
export function summarizeFramePolicy(policy: Policy, userLimits: UserLimits | null): PolicySummary {
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
    expiresAfterMs: EXPIRES_AFTER_MS,
    allowedOrigins: (policy.allowedOrigins ?? ["manual", "ai_ticket"]).filter((o): o is "manual" | "ai_ticket" => o !== "guardian"),
    userLimits: userLimits === null ? null : structuredClone(userLimits),
  };
}

/** Coins an action touches (from the compiled intent). */
export function intentCoins(compiled: Pick<CompiledAction, "intent">): string[] {
  const i = compiled.intent;
  switch (i.kind) {
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

/** Coins of a raw (unvalidated) intent, for fetching market data before compiling. Invalid input yields []. */
export function rawIntentCoins(intent: unknown): string[] {
  if (typeof intent !== "object" || intent === null) return [];
  const i = intent as { kind?: unknown; coin?: unknown; order?: { coin?: unknown }; cancels?: unknown };
  const out = new Set<string>();
  if (typeof i.coin === "string") out.add(i.coin);
  if (typeof i.order === "object" && i.order !== null && typeof i.order.coin === "string") out.add(i.order.coin);
  if (Array.isArray(i.cancels)) for (const c of i.cancels.slice(0, 1000)) if (typeof c === "object" && c !== null && typeof (c as { coin?: unknown }).coin === "string") out.add((c as { coin: string }).coin);
  return [...out];
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
  ordersInLastMinute: number;
  dailyNotionalUsedUsd: number;
  /** The user's current leverage per coin, when known (only fetched when `maxLeverage` was tightened). */
  leverageByCoin?: Readonly<Record<string, number>>;
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
  const policy: Policy = cap === input.policy.maxLeverage ? input.policy : { ...input.policy, maxLeverage: Math.max(1, Math.floor(cap)) };
  const violations: PolicyViolation[] = [];
  const add = (v: PolicyViolation) => {
    if (!violations.some((x) => x.code === v.code && x.message === v.message)) violations.push(v);
  };
  // Frame rule: master account only in v1, regardless of what the policy object says.
  if (input.compiled.vaultAddress !== undefined || input.compiled.intent.vaultAddress !== undefined) {
    add({ code: "VAULT_NOT_ALLOWED", message: "The signer frame acts for the master account only; vaultAddress must be absent." });
  }
  const context = {
    policy,
    now: input.now,
    markPrices: input.markPrices,
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

/**
 * Nonces and signing serialization across tabs.
 *
 * - **Serialization**: every sign-and-submit for an agent runs inside a Web Lock named after the network and agent
 *   (`navigator.locks.request`), so tabs sign one at a time and requests reach HL in nonce order. Without Web Locks the
 *   frame uses an in-tab mutex only (documented best effort for ordering across tabs).
 * - **Uniqueness**: the nonce is reserved in one IndexedDB `readwrite` transaction that reads the last nonce and writes
 *   the new one. IndexedDB runs overlapping `readwrite` transactions of an origin one after the other, even across
 *   tabs, so two tabs can never get the same nonce, with or without Web Locks.
 * - **Formula**: `@kokoah/shared` `MonotonicNonceManager`: `max(now + clockOffset, last + 1)`, where `last` is the
 *   persisted value and the clock offset comes from HL `exchangeStatus` server time.
 *
 * The same record tracks per-minute order counts, today's notional and the last few minutes of HLP deposits, so
 * reloading the frame or using another tab does not reset the rate limit or the HLP cap.
 *
 * @module
 */
import { isNonceInWindow, MonotonicNonceManager, NONCE_MAX_FUTURE_MS } from "@kokoah/shared/signing";
import type { SignerStore, UsageRecord } from "./storage.js";

/** The subset of the Web Locks API the frame uses. */
export interface LockManagerLike {
  request<T>(name: string, options: { mode?: "exclusive" | "shared"; signal?: AbortSignal }, callback: (lock: unknown) => Promise<T> | T): Promise<T>;
}

/** Thrown when the signing lock could not be acquired in time. */
export class SignerBusyError extends Error {
  constructor(message = "Another signature is in progress; try again.") {
    super(message);
    this.name = "SignerBusyError";
  }
}

/** `reserve` for `setReferrer` when this agent already signed one: nothing was reserved or signed. */
export class ReferrerAlreadySignedError extends Error {
  constructor(message = "This trading key already set the referral code once.") {
    super(message);
    this.name = "ReferrerAlreadySignedError";
  }
}

const MINUTE = 60_000;

/**
 * How long an HLP deposit this agent signed counts toward the 24-hour cap on top of Hyperliquid's ledger, which can lag
 * a deposit by a few seconds (counted twice for a moment: stricter).
 */
export const HLP_DEPOSIT_RECENT_MS = 5 * MINUTE;

/** A limit the reservation found exceeded (checked again inside the storage transaction; see {@link SigningCoordinator.reserve}). */
export class UsageLimitError extends Error {
  /** The shared policy code (the action rate reports as ORDER_RATE_EXCEEDED, with its own message). */
  readonly code: "ORDER_RATE_EXCEEDED" | "DAILY_NOTIONAL_EXCEEDED" | "VAULT_DEPOSIT_LIMIT";
  constructor(code: UsageLimitError["code"], message: string) {
    super(message);
    this.name = "UsageLimitError";
    this.code = code;
  }
}

/** The limits a reservation must stay within. */
export interface ReserveLimits {
  maxOrdersPerMinute: number;
  /** Signed actions of any kind (orders, cancels, leverage, noop…) per minute. */
  maxActionsPerMinute: number;
  /** The account's own daily limit (the master's, for sub-accounts without a daily limit of their own). */
  maxDailyNotionalUsd: number;
  /** The agent's daily limit across every account. */
  maxAgentDailyNotionalUsd: number;
}

/** UTC day key. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface Usage {
  /** Orders this agent signed in the last minute, across every account. */
  ordersInLastMinute: number;
  /** Actions of any kind this agent signed in the last minute, across every account. */
  actionsInLastMinute: number;
  /** Notional this agent signed today, across every account. */
  dailyNotionalUsedUsd: number;
  /** Notional signed today for the account asked about (the master when none was given). */
  accountDailyNotionalUsd: number;
}

/** Which account a usage question or reservation is about. */
export interface UsageAccount {
  /** The account (the master or one of its sub-accounts). */
  account: string;
  /** The key's master (records from before sub-accounts count everything for it). */
  master: string;
  /**
   * Sub-accounts with daily limits of their own (`maxDailyNotionalUsd` in their own limits; lowercase). Every other
   * account shares the master's limit, so its notional is counted together with the master's and that of every other
   * account without a daily limit of its own.
   */
  separate?: readonly string[];
}

export interface SigningCoordinatorOptions {
  store: SignerStore;
  /** `navigator.locks`, when available. */
  locks: LockManagerLike | undefined;
  /** Lock name prefix (includes the network). */
  lockPrefix: string;
  /** How long to wait for the lock before failing with SIGNER_BUSY. Default 20 s. */
  lockTimeoutMs?: number;
}

export class SigningCoordinator {
  private readonly store: SignerStore;
  private readonly locks: LockManagerLike | undefined;
  private readonly lockPrefix: string;
  private readonly lockTimeoutMs: number;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(options: SigningCoordinatorOptions) {
    this.store = options.store;
    this.locks = options.locks;
    this.lockPrefix = options.lockPrefix;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 20_000;
  }

  /** True when cross-tab serialization uses Web Locks. */
  get usesWebLocks(): boolean {
    return this.locks !== undefined;
  }

  /** Runs `fn` while holding the agent's signing lock (Web Locks across tabs, else an in-tab mutex). */
  async withAgentLock<T>(agent: string, fn: () => Promise<T>): Promise<T> {
    const name = `${this.lockPrefix}/sign/${agent.toLowerCase()}`;
    if (this.locks) {
      try {
        return await this.locks.request(name, { mode: "exclusive", signal: AbortSignal.timeout(this.lockTimeoutMs) }, async () => await fn());
      } catch (e) {
        if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) throw new SignerBusyError();
        throw e;
      }
    }
    return await this.withLocalMutex(name, fn);
  }

  /** Orders in the last minute and notional used today (corrected clock), from the persisted record. */
  async usage(agent: string, now: number, account?: UsageAccount): Promise<Usage> {
    return usageOf(await this.store.readUsage(agent), now, account);
  }

  /** Whether this agent already signed `setReferrer` (persisted, so a reload or another tab doesn't reset it). */
  async referrerSigned(agent: string): Promise<boolean> {
    return typeof (await this.store.readUsage(agent))?.referrerSignedAt === "number";
  }

  /** HLP deposits (USD) this agent signed for `master` in the last {@link HLP_DEPOSIT_RECENT_MS}, in any tab. */
  async recentHlpDepositsUsd(agent: string, master: string, now: number): Promise<number> {
    return recentHlpDepositsUsd(await this.store.readUsage(agent), master, now);
  }

  /**
   * Reserves the next nonce for `agent` and records the orders and notional this action adds, atomically.
   * `referrer`: this action is `setReferrer`; it is recorded in the same transaction, and the reservation fails with
   * {@link ReferrerAlreadySignedError} when the agent already signed one.
   * `hlpDeposit`: this action is an HLP deposit of `usd` for `master`; it is recorded in the same transaction, which
   * fails with VAULT_DEPOSIT_LIMIT when the recent deposits are more than the `countedUsd` the caller's cap check counted
   * (another tab deposited in between; with Web Locks it can't).
   * Throws if the nonce would fall outside HL's accepted window.
   */
  async reserve(
    agent: string,
    params: {
      now: number;
      orders: number;
      notionalUsd: number;
      account?: UsageAccount;
      referrer?: boolean;
      limits?: ReserveLimits;
      hlpDeposit?: { master: string; usd: number; countedUsd: number };
    },
  ): Promise<number> {
    const now = Math.floor(params.now);
    let already = false;
    let exceeded: UsageLimitError | undefined;
    const record = await this.store.updateUsage(agent, (prev) => {
      if (params.referrer && typeof prev?.referrerSignedAt === "number") {
        already = true;
        // Unchanged: nothing is reserved.
        return prev;
      }
      // The limits again, in the same transaction that records this action: tabs without a shared lock (no Web Locks)
      // can't both pass on the same usage.
      exceeded = (params.limits ? limitProblem(usageOf(prev, now, params.account), params) : undefined) ?? hlpDepositProblem(prev, now, params.hlpDeposit);
      if (exceeded) return prev ?? { agent: agent.toLowerCase(), lastNonce: 0, orderTimes: [], day: utcDay(now), dayNotionalUsd: 0 };
      const next = nextUsage(agent, prev, now, params.orders, params.notionalUsd, params.account, params.hlpDeposit);
      if (params.referrer) next.referrerSignedAt = now;
      return next;
    });
    if (already) throw new ReferrerAlreadySignedError();
    if (exceeded) throw exceeded;
    if (!isNonceInWindow(record.lastNonce, now)) throw new RangeError("Nonce outside Hyperliquid's accepted window; check the device clock");
    return record.lastNonce;
  }

  private async withLocalMutex<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = previous.then(() => mine);
    this.tails.set(name, tail);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        previous,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SignerBusyError()), this.lockTimeoutMs);
        }),
      ]);
    } catch (e) {
      // Our slot still has to be released once the previous holder finishes.
      release();
      throw e;
    } finally {
      clearTimeout(timer);
    }
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(name) === tail) this.tails.delete(name);
    }
  }
}

/** Usage counters of a record at `now`. Without `account`, the account figure is the master's. */
export function usageOf(record: UsageRecord | undefined, now: number, account?: UsageAccount): Usage {
  if (!record) return { ordersInLastMinute: 0, actionsInLastMinute: 0, dailyNotionalUsedUsd: 0, accountDailyNotionalUsd: 0 };
  const today = record.day === utcDay(now);
  const inLastMinute = (t: number) => t > now - MINUTE && t <= now + MINUTE;
  return {
    ordersInLastMinute: record.orderTimes.filter(inLastMinute).length,
    actionsInLastMinute: (record.actionTimes ?? []).filter(inLastMinute).length,
    dailyNotionalUsedUsd: today ? record.dayNotionalUsd : 0,
    accountDailyNotionalUsd: today ? accountNotional(record, account) : 0,
  };
}

function accountNotional(record: UsageRecord, account: UsageAccount | undefined): number {
  const byAccount = record.accountNotionalUsd;
  if (byAccount === undefined) return account === undefined || account.account.toLowerCase() === account.master.toLowerCase() ? record.dayNotionalUsd : 0;
  if (account === undefined) return record.dayNotionalUsd;
  const amount = (a: string) => {
    const value = byAccount[a];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const key = account.account.toLowerCase();
  if (account.separate === undefined) return amount(key);
  const separate = new Set(account.separate.map((a) => a.toLowerCase()));
  if (separate.has(key)) return amount(key);
  // The master's limit is shared by every account without a daily limit of its own.
  return Object.keys(byAccount)
    .filter((a) => !separate.has(a))
    .reduce((sum, a) => sum + amount(a), 0);
}

/** HLP deposits (USD) a record holds for `master` in the last {@link HLP_DEPOSIT_RECENT_MS} before `now`. */
export function recentHlpDepositsUsd(record: UsageRecord | undefined, master: string, now: number): number {
  const key = master.toLowerCase();
  return (record?.hlpDeposits ?? []).filter((d) => d.master === key && d.at > now - HLP_DEPOSIT_RECENT_MS && Number.isFinite(d.usd)).reduce((sum, d) => sum + d.usd, 0);
}

/** An HLP deposit whose cap check didn't count a deposit recorded since. */
function hlpDepositProblem(prev: UsageRecord | undefined, now: number, deposit: { master: string; countedUsd: number } | undefined): UsageLimitError | undefined {
  if (!deposit || recentHlpDepositsUsd(prev, deposit.master, now) <= deposit.countedUsd + 1e-9) return undefined;
  return new UsageLimitError("VAULT_DEPOSIT_LIMIT", "Another HLP deposit was signed in this browser meanwhile; nothing was signed. Try again.");
}

/** The limit this reservation would exceed, if any. */
function limitProblem(usage: Usage, p: { orders: number; notionalUsd: number; limits?: ReserveLimits }): UsageLimitError | undefined {
  const l = p.limits;
  if (!l) return undefined;
  if (usage.actionsInLastMinute + 1 > l.maxActionsPerMinute) return new UsageLimitError("ORDER_RATE_EXCEEDED", `More than ${l.maxActionsPerMinute} signed actions per minute.`);
  if (p.orders > 0 && usage.ordersInLastMinute + p.orders > l.maxOrdersPerMinute) return new UsageLimitError("ORDER_RATE_EXCEEDED", `More than ${l.maxOrdersPerMinute} orders per minute.`);
  const added = Number.isFinite(p.notionalUsd) && p.notionalUsd > 0 ? p.notionalUsd : 0;
  if (added > 0 && usage.accountDailyNotionalUsd + added > l.maxDailyNotionalUsd) return new UsageLimitError("DAILY_NOTIONAL_EXCEEDED", `Daily notional would pass the $${l.maxDailyNotionalUsd} limit.`);
  if (added > 0 && usage.dailyNotionalUsedUsd + added > l.maxAgentDailyNotionalUsd) return new UsageLimitError("DAILY_NOTIONAL_EXCEEDED", `This device's key would pass its daily limit of $${l.maxAgentDailyNotionalUsd} across all accounts.`);
  return undefined;
}

/** Pure update of the usage record (runs inside the IndexedDB transaction). `hlpDeposit`: this action deposits into HLP. */
export function nextUsage(
  agent: string,
  prev: UsageRecord | undefined,
  now: number,
  orders: number,
  notionalUsd: number,
  account?: UsageAccount,
  hlpDeposit?: { master: string; usd: number },
): UsageRecord {
  const mgr = new MonotonicNonceManager({ now: () => now });
  const last = prev?.lastNonce;
  // A persisted nonce beyond HL's future window can only come from a broken clock; it would make every later nonce
  // invalid, so it is ignored (nonces below it were never used by this agent since they would have been rejected).
  if (last !== undefined && Number.isSafeInteger(last) && last > 0 && last < now + NONCE_MAX_FUTURE_MS) mgr.observe(last, agent);
  const nonce = mgr.next(agent);
  const today = utcDay(now);
  const recent = (prev?.orderTimes ?? []).filter((t) => t > now - MINUTE && t <= now + MINUTE);
  for (let i = 0; i < orders; i++) recent.push(now);
  const added = Number.isFinite(notionalUsd) && notionalUsd > 0 ? notionalUsd : 0;
  const sameDay = prev !== undefined && prev.day === today;
  const dayNotionalUsd = (sameDay ? prev.dayNotionalUsd : 0) + added;
  const actions = (prev?.actionTimes ?? []).filter((t) => t > now - MINUTE && t <= now + MINUTE);
  actions.push(now);
  const record: UsageRecord = { agent: agent.toLowerCase(), lastNonce: nonce, orderTimes: recent.slice(-10_000), actionTimes: actions.slice(-10_000), day: today, dayNotionalUsd };
  if (typeof prev?.referrerSignedAt === "number") record.referrerSignedAt = prev.referrerSignedAt;
  const deposits = (prev?.hlpDeposits ?? []).filter((d) => d.at > now - HLP_DEPOSIT_RECENT_MS);
  if (hlpDeposit) deposits.push({ master: hlpDeposit.master.toLowerCase(), at: now, usd: hlpDeposit.usd });
  if (deposits.length > 0) record.hlpDeposits = deposits;
  if (account !== undefined || prev?.accountNotionalUsd !== undefined) {
    const byAccount: Record<string, number> = {};
    if (sameDay) {
      if (prev.accountNotionalUsd !== undefined) {
        for (const [a, n] of Object.entries(prev.accountNotionalUsd)) if (typeof n === "number" && Number.isFinite(n)) byAccount[a] = n;
      } else if (account !== undefined && prev.dayNotionalUsd > 0) {
        // A record from before sub-accounts: everything signed so far today was for the master.
        byAccount[account.master.toLowerCase()] = prev.dayNotionalUsd;
      }
    }
    if (account !== undefined) {
      const key = account.account.toLowerCase();
      byAccount[key] = (byAccount[key] ?? 0) + added;
    }
    record.accountNotionalUsd = byAccount;
  }
  return record;
}

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
 * The same record tracks per-minute order counts and today's notional, so reloading the frame does not reset the
 * rate limit.
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

/** UTC day key. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface Usage {
  /** Orders this agent signed in the last minute, across every account. */
  ordersInLastMinute: number;
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

  /**
   * Reserves the next nonce for `agent` and records the orders and notional this action adds, atomically.
   * `referrer`: this action is `setReferrer`; it is recorded in the same transaction, and the reservation fails with
   * {@link ReferrerAlreadySignedError} when the agent already signed one.
   * Throws if the nonce would fall outside HL's accepted window.
   */
  async reserve(agent: string, params: { now: number; orders: number; notionalUsd: number; account?: UsageAccount; referrer?: boolean }): Promise<number> {
    const now = Math.floor(params.now);
    let already = false;
    const record = await this.store.updateUsage(agent, (prev) => {
      if (params.referrer && typeof prev?.referrerSignedAt === "number") {
        already = true;
        // Unchanged: nothing is reserved.
        return prev;
      }
      const next = nextUsage(agent, prev, now, params.orders, params.notionalUsd, params.account);
      if (params.referrer) next.referrerSignedAt = now;
      return next;
    });
    if (already) throw new ReferrerAlreadySignedError();
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
  if (!record) return { ordersInLastMinute: 0, dailyNotionalUsedUsd: 0, accountDailyNotionalUsd: 0 };
  const today = record.day === utcDay(now);
  return {
    ordersInLastMinute: record.orderTimes.filter((t) => t > now - MINUTE && t <= now + MINUTE).length,
    dailyNotionalUsedUsd: today ? record.dayNotionalUsd : 0,
    accountDailyNotionalUsd: today ? accountNotional(record, account) : 0,
  };
}

function accountNotional(record: UsageRecord, account: UsageAccount | undefined): number {
  const byAccount = record.accountNotionalUsd;
  if (byAccount === undefined) return account === undefined || account.account.toLowerCase() === account.master.toLowerCase() ? record.dayNotionalUsd : 0;
  if (account === undefined) return record.dayNotionalUsd;
  const value = byAccount[account.account.toLowerCase()];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Pure update of the usage record (runs inside the IndexedDB transaction). */
export function nextUsage(agent: string, prev: UsageRecord | undefined, now: number, orders: number, notionalUsd: number, account?: UsageAccount): UsageRecord {
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
  const record: UsageRecord = { agent: agent.toLowerCase(), lastNonce: nonce, orderTimes: recent.slice(-10_000), day: today, dayNotionalUsd };
  if (typeof prev?.referrerSignedAt === "number") record.referrerSignedAt = prev.referrerSignedAt;
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

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

const MINUTE = 60_000;

/** UTC day key. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface Usage {
  ordersInLastMinute: number;
  dailyNotionalUsedUsd: number;
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
  async usage(agent: string, now: number): Promise<Usage> {
    return usageOf(await this.store.readUsage(agent), now);
  }

  /**
   * Reserves the next nonce for `agent` and records the orders and notional this action adds, atomically.
   * Throws if the nonce would fall outside HL's accepted window.
   */
  async reserve(agent: string, params: { now: number; orders: number; notionalUsd: number }): Promise<number> {
    const now = Math.floor(params.now);
    const record = await this.store.updateUsage(agent, (prev) => nextUsage(agent, prev, now, params.orders, params.notionalUsd));
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

/** Usage counters of a record at `now`. */
export function usageOf(record: UsageRecord | undefined, now: number): Usage {
  if (!record) return { ordersInLastMinute: 0, dailyNotionalUsedUsd: 0 };
  return {
    ordersInLastMinute: record.orderTimes.filter((t) => t > now - MINUTE && t <= now + MINUTE).length,
    dailyNotionalUsedUsd: record.day === utcDay(now) ? record.dayNotionalUsd : 0,
  };
}

/** Pure update of the usage record (runs inside the IndexedDB transaction). */
export function nextUsage(agent: string, prev: UsageRecord | undefined, now: number, orders: number, notionalUsd: number): UsageRecord {
  const mgr = new MonotonicNonceManager({ now: () => now });
  const last = prev?.lastNonce;
  // A persisted nonce beyond HL's future window can only come from a broken clock; it would make every later nonce
  // invalid, so it is ignored (nonces below it were never used by this agent since they would have been rejected).
  if (last !== undefined && Number.isSafeInteger(last) && last > 0 && last < now + NONCE_MAX_FUTURE_MS) mgr.observe(last, agent);
  const nonce = mgr.next(agent);
  const today = utcDay(now);
  const recent = (prev?.orderTimes ?? []).filter((t) => t > now - MINUTE && t <= now + MINUTE);
  for (let i = 0; i < orders; i++) recent.push(now);
  const dayNotionalUsd = (prev && prev.day === today ? prev.dayNotionalUsd : 0) + (Number.isFinite(notionalUsd) && notionalUsd > 0 ? notionalUsd : 0);
  return { agent: agent.toLowerCase(), lastNonce: nonce, orderTimes: recent.slice(-10_000), day: today, dayNotionalUsd };
}

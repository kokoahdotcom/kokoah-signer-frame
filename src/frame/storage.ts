/**
 * Persistent storage of the frame (IndexedDB on the signer origin), with an in-memory fallback when IndexedDB is
 * unavailable (then only `session` keys are possible).
 *
 * Object stores:
 * - `keys` (key `slot`): the encrypted agent key record (`device` and `passkey` modes; slot `current`). Never
 *   plaintext. Also the user's limits for each network (slot `limits/<network>`, see {@link StoredLimitsRecord}): kept
 *   in this store so the schema version stays 1 and an older frame build still opens the database.
 * - `usage` (key `agent`): last nonce, recent order times and today's notional, per agent address. Updated in a single
 *   `readwrite` transaction per signature, which IndexedDB serializes across tabs of the origin.
 * - `agents` (key `address`): every agent address this origin ever generated, so an address is never reused.
 *
 * @module
 */
import type { NetworkName, UserLimits } from "../protocol/index.js";

export const DB_NAME = "kokoah-signer";
export const DB_VERSION = 1;
const KEYS = "keys";
const USAGE = "usage";
const AGENTS = "agents";
const SLOT = "current";

/** Ciphertext of the 32-byte agent private key. */
export interface WrappedSecret {
  alg: "AES-GCM";
  iv: Uint8Array;
  data: Uint8Array;
}

/** Stored key record (device or passkey mode). Contains no plaintext key material. */
export interface StoredKeyRecord {
  slot: typeof SLOT;
  v: 1;
  network: NetworkName;
  storageMode: "device" | "passkey";
  agentAddress: `0x${string}`;
  agentName: string;
  userAddress: `0x${string}`;
  validUntil: number;
  keyState: "pending" | "active";
  createdAt: number;
  confirmedAt?: number;
  wrapped: WrappedSecret;
  /** Device mode: the non-extractable AES-GCM key that wraps the secret. */
  deviceKey?: CryptoKey;
  /** Passkey mode: what is needed to re-derive the wrapping key with a WebAuthn PRF assertion. */
  passkey?: { credentialId: Uint8Array; prfSalt: Uint8Array; hkdfSalt: Uint8Array; rpId: string };
}

/**
 * The user's limits on one network (`setLimits`), stored on the signer origin so the parent can't drop them by
 * reloading the frame. Per network, not per key or wallet: they exist before a key does and outlive it.
 */
export interface StoredLimitsRecord {
  slot: `limits/${NetworkName}`;
  v: 1;
  network: NetworkName;
  /** Bumped by every write; a write based on an older read is refused (see {@link SignerStore.replaceLimits}). */
  rev: number;
  /** The master's limits (null: the baseline). */
  master: UserLimits | null;
  /** Sub-accounts' own limits, by lowercase address. */
  accounts: Record<string, UserLimits>;
  updatedAt: number;
}

/** Slot of a network's limits record in the `keys` store. */
export function limitsSlot(network: NetworkName): StoredLimitsRecord["slot"] {
  return `limits/${network}`;
}

/** Per-agent usage and nonce state. */
export interface UsageRecord {
  agent: string;
  /** Highest nonce issued for this agent on this origin. */
  lastNonce: number;
  /** Times (ms, corrected clock) of orders signed in roughly the last minute, one entry per order. */
  orderTimes: number[];
  /** Times (ms, corrected clock) of every action signed in roughly the last minute (missing in older records). */
  actionTimes?: number[];
  /** UTC day (YYYY-MM-DD) of `dayNotionalUsd` and `accountNotionalUsd`. */
  day: string;
  /** Notional signed on `day` across every account. */
  dayNotionalUsd: number;
  /**
   * Notional signed on `day` per account (lowercase address: the master or a sub-account). Missing in records written
   * before sub-accounts: then all of `dayNotionalUsd` belongs to the master.
   */
  accountNotionalUsd?: Record<string, number>;
  /**
   * When this agent signed `setReferrer` (corrected clock, ms). The frame signs it at most once per key; Hyperliquid
   * itself accepts a referrer once per account.
   */
  referrerSignedAt?: number;
}

/** Storage used by the frame. */
export interface SignerStore {
  /** False for the in-memory fallback. */
  readonly persistent: boolean;
  getKeyRecord(): Promise<StoredKeyRecord | undefined>;
  putKeyRecord(record: StoredKeyRecord): Promise<void>;
  deleteKeyRecord(): Promise<void>;
  /** Records an agent address; returns false if it was already recorded (reuse). */
  claimAgentAddress(address: string, now: number): Promise<boolean>;
  readUsage(agent: string): Promise<UsageRecord | undefined>;
  /**
   * Atomically reads, updates and writes the usage record of `agent`. `update` runs synchronously inside one
   * `readwrite` transaction; IndexedDB serializes such transactions across tabs, so two tabs can never read the same
   * `lastNonce`.
   */
  updateUsage(agent: string, update: (previous: UsageRecord | undefined) => UsageRecord): Promise<UsageRecord>;
  getLimits(network: NetworkName): Promise<StoredLimitsRecord | undefined>;
  /**
   * Writes `record` only while the stored record's `rev` is still `expectedRev` (0: none stored), in one `readwrite`
   * transaction (serialized across tabs). Returns false, writing nothing, when another write came first.
   */
  replaceLimits(record: StoredLimitsRecord, expectedRev: number): Promise<boolean>;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** IndexedDB-backed store. */
export class IdbSignerStore implements SignerStore {
  readonly persistent = true;
  private readonly db: IDBDatabase;
  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  /** Opens (and creates or upgrades) the database. */
  static async open(factory: IDBFactory, name: string = DB_NAME): Promise<IdbSignerStore> {
    const open = factory.open(name, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS, { keyPath: "slot" });
      if (!db.objectStoreNames.contains(USAGE)) db.createObjectStore(USAGE, { keyPath: "agent" });
      if (!db.objectStoreNames.contains(AGENTS)) db.createObjectStore(AGENTS, { keyPath: "address" });
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error("IndexedDB open failed"));
      open.onblocked = () => reject(new Error("IndexedDB open blocked"));
    });
    // Another tab upgrading the schema: close so it isn't blocked (this tab then falls back to reload).
    db.onversionchange = () => db.close();
    return new IdbSignerStore(db);
  }

  async getKeyRecord(): Promise<StoredKeyRecord | undefined> {
    const tx = this.db.transaction(KEYS, "readonly");
    return (await req(tx.objectStore(KEYS).get(SLOT))) as StoredKeyRecord | undefined;
  }

  async putKeyRecord(record: StoredKeyRecord): Promise<void> {
    const tx = this.db.transaction(KEYS, "readwrite");
    tx.objectStore(KEYS).put(record);
    await done(tx);
  }

  async deleteKeyRecord(): Promise<void> {
    const tx = this.db.transaction(KEYS, "readwrite");
    tx.objectStore(KEYS).delete(SLOT);
    await done(tx);
  }

  async claimAgentAddress(address: string, now: number): Promise<boolean> {
    const key = address.toLowerCase();
    const tx = this.db.transaction(AGENTS, "readwrite");
    const store = tx.objectStore(AGENTS);
    let fresh = false;
    const get = store.get(key);
    get.onsuccess = () => {
      if (get.result === undefined) {
        fresh = true;
        store.put({ address: key, createdAt: now });
      }
    };
    await done(tx);
    return fresh;
  }

  async readUsage(agent: string): Promise<UsageRecord | undefined> {
    const tx = this.db.transaction(USAGE, "readonly");
    return (await req(tx.objectStore(USAGE).get(agent.toLowerCase()))) as UsageRecord | undefined;
  }

  async updateUsage(agent: string, update: (previous: UsageRecord | undefined) => UsageRecord): Promise<UsageRecord> {
    const key = agent.toLowerCase();
    const tx = this.db.transaction(USAGE, "readwrite");
    const store = tx.objectStore(USAGE);
    let next: UsageRecord | undefined;
    let failure: unknown;
    const get = store.get(key);
    get.onsuccess = () => {
      try {
        next = { ...update(get.result as UsageRecord | undefined), agent: key };
        store.put(next);
      } catch (e) {
        failure = e;
        tx.abort();
      }
    };
    try {
      await done(tx);
    } catch (e) {
      throw failure ?? e;
    }
    if (next === undefined) throw new Error("usage update produced nothing");
    return next;
  }

  async getLimits(network: NetworkName): Promise<StoredLimitsRecord | undefined> {
    const tx = this.db.transaction(KEYS, "readonly");
    return (await req(tx.objectStore(KEYS).get(limitsSlot(network)))) as StoredLimitsRecord | undefined;
  }

  async replaceLimits(record: StoredLimitsRecord, expectedRev: number): Promise<boolean> {
    const tx = this.db.transaction(KEYS, "readwrite");
    const store = tx.objectStore(KEYS);
    let written = false;
    const get = store.get(record.slot);
    get.onsuccess = () => {
      if (limitsRev(get.result) !== expectedRev) return;
      store.put(record);
      written = true;
    };
    await done(tx);
    return written;
  }
}

/** A stored limits record's revision (0: none, or unreadable). */
export function limitsRev(record: unknown): number {
  const rev = (record as { rev?: unknown } | undefined)?.rev;
  return typeof rev === "number" && Number.isSafeInteger(rev) && rev > 0 ? rev : 0;
}

/** In-memory fallback (nothing survives a reload; nothing is shared across tabs). */
export class MemorySignerStore implements SignerStore {
  readonly persistent = false;
  private record: StoredKeyRecord | undefined;
  private readonly usage = new Map<string, UsageRecord>();
  private readonly agents = new Set<string>();
  private readonly limits = new Map<string, StoredLimitsRecord>();

  async getKeyRecord(): Promise<StoredKeyRecord | undefined> {
    return this.record;
  }
  async putKeyRecord(record: StoredKeyRecord): Promise<void> {
    this.record = record;
  }
  async deleteKeyRecord(): Promise<void> {
    this.record = undefined;
  }
  async claimAgentAddress(address: string): Promise<boolean> {
    const key = address.toLowerCase();
    if (this.agents.has(key)) return false;
    this.agents.add(key);
    return true;
  }
  async readUsage(agent: string): Promise<UsageRecord | undefined> {
    const r = this.usage.get(agent.toLowerCase());
    return r === undefined ? undefined : structuredClone(r);
  }
  async updateUsage(agent: string, update: (previous: UsageRecord | undefined) => UsageRecord): Promise<UsageRecord> {
    const key = agent.toLowerCase();
    const next = { ...update(this.usage.get(key)), agent: key };
    this.usage.set(key, next);
    return structuredClone(next);
  }
  async getLimits(network: NetworkName): Promise<StoredLimitsRecord | undefined> {
    const r = this.limits.get(network);
    return r === undefined ? undefined : structuredClone(r);
  }
  async replaceLimits(record: StoredLimitsRecord, expectedRev: number): Promise<boolean> {
    if (limitsRev(this.limits.get(record.network)) !== expectedRev) return false;
    this.limits.set(record.network, structuredClone(record));
    return true;
  }
}

/** Opens IndexedDB, or returns the in-memory store when it is unavailable. */
export async function openSignerStore(factory: IDBFactory | undefined, name?: string): Promise<SignerStore> {
  if (factory === undefined) return new MemorySignerStore();
  try {
    return await IdbSignerStore.open(factory, name);
  } catch {
    return new MemorySignerStore();
  }
}

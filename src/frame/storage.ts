/**
 * Persistent storage of the frame (IndexedDB on the signer origin), with an in-memory fallback when IndexedDB is
 * unavailable (then only `session` keys are possible).
 *
 * Object stores:
 * - `keys` (key `slot`): the encrypted agent key record (`device` and `passkey` modes). Never plaintext.
 * - `usage` (key `agent`): last nonce, recent order times and today's notional, per agent address. Updated in a single
 *   `readwrite` transaction per signature, which IndexedDB serializes across tabs of the origin.
 * - `agents` (key `address`): every agent address this origin ever generated, so an address is never reused.
 *
 * @module
 */
import type { NetworkName } from "../protocol/index.js";

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

/** Per-agent usage and nonce state. */
export interface UsageRecord {
  agent: string;
  /** Highest nonce issued for this agent on this origin. */
  lastNonce: number;
  /** Times (ms, corrected clock) of orders signed in roughly the last minute, one entry per order. */
  orderTimes: number[];
  /** UTC day (YYYY-MM-DD) of `dayNotionalUsd`. */
  day: string;
  dayNotionalUsd: number;
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
}

/** In-memory fallback (nothing survives a reload; nothing is shared across tabs). */
export class MemorySignerStore implements SignerStore {
  readonly persistent = false;
  private record: StoredKeyRecord | undefined;
  private readonly usage = new Map<string, UsageRecord>();
  private readonly agents = new Set<string>();

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

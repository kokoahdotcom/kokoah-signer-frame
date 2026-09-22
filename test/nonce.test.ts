import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { nextUsage, SignerBusyError, SigningCoordinator, usageOf } from "../src/frame/nonces.js";
import { IdbSignerStore, MemorySignerStore } from "../src/frame/storage.js";
import { Clock, FakeLocks, FrameHarness, limitOrder, MockHl, T0 } from "./helpers.js";

const harnesses: FrameHarness[] = [];
async function frame(o: Parameters<typeof FrameHarness.create>[0] = {}): Promise<FrameHarness> {
  const h = await FrameHarness.create(o);
  harnesses.push(h);
  return h;
}
afterEach(() => {
  for (const h of harnesses.splice(0)) h.destroy();
});

function strictlyIncreasing(xs: number[]): boolean {
  return xs.every((x, i) => i === 0 || x > (xs[i - 1] as number));
}

describe("nonces in one tab", () => {
  it("are strictly increasing across concurrent signAndSubmit calls (same millisecond)", async () => {
    const h = await frame();
    await h.activeAgent("device");
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => h.ok("signAndSubmit", { requestId: `c${i}`, intent: limitOrder() })));
    const sent = h.hl.exchangeCalls.map((c) => c.body.nonce);
    expect(sent).toHaveLength(12);
    expect(strictlyIncreasing(sent)).toBe(true);
    expect(sent[0]).toBe(T0);
    expect(new Set(results.map((r) => r.nonce)).size).toBe(12);
  });

  it("stay above the last persisted nonce after a reload even if the clock went backwards", async () => {
    const h = await frame();
    await h.activeAgent("device");
    await h.ok("signAndSubmit", { requestId: "a", intent: limitOrder() });
    const first = h.hl.exchangeCalls[0]!.body.nonce;
    h.destroy();
    h.clock.advance(-60_000);
    const again = await frame({ idb: h.idb, clock: h.clock, hl: h.hl });
    await again.ok("hello", { protocolVersion: 1 });
    await again.ok("signAndSubmit", { requestId: "b", intent: limitOrder() });
    expect(again.hl.exchangeCalls.at(-1)!.body.nonce).toBe(first + 1);
  });
});

describe("nonces across two tabs sharing IndexedDB", () => {
  async function twoTabs(locks: "shared" | "none") {
    const clock = new Clock();
    const hl = new MockHl(clock);
    const idb = new IDBFactory();
    const shared = new FakeLocks();
    const a = await frame({ clock, hl, idb, locks: locks === "shared" ? shared : "none" });
    await a.activeAgent("device");
    const b = await frame({ clock, hl, idb, locks: locks === "shared" ? shared : "none" });
    await b.ok("hello", { protocolVersion: 1 });
    expect((await b.ok("getStatus")).keyState).toBe("active");
    return { a, b, hl, shared };
  }

  it("with Web Locks: unique, and strictly increasing in the order HL receives them", async () => {
    const { a, b, hl, shared } = await twoTabs("shared");
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => [a.ok("signAndSubmit", { requestId: `a${i}`, intent: limitOrder() }), b.ok("signAndSubmit", { requestId: `b${i}`, intent: limitOrder() })]).flat(),
    );
    const sent = hl.exchangeCalls.map((c) => c.body.nonce);
    expect(sent).toHaveLength(16);
    expect(new Set(sent).size).toBe(16);
    expect(strictlyIncreasing(sent)).toBe(true);
    expect(shared.requests.every((n) => n.startsWith("kokoah-signer/v1/testnet/sign/0x"))).toBe(true);
  });

  it("without Web Locks: still unique (the IndexedDB readwrite transaction serializes reservations)", async () => {
    const { a, b, hl } = await twoTabs("none");
    expect((await a.ok("hello", { protocolVersion: 1 })).capabilities.webLocks).toBe(false);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => [a.ok("signAndSubmit", { requestId: `a${i}`, intent: limitOrder() }), b.ok("signAndSubmit", { requestId: `b${i}`, intent: limitOrder() })]).flat(),
    );
    const sent = hl.exchangeCalls.map((c) => c.body.nonce);
    expect(sent).toHaveLength(16);
    expect(new Set(sent).size).toBe(16);
  });

  it("IndexedDB reservations from two connections never collide (unit)", async () => {
    const idb = new IDBFactory();
    const s1 = await IdbSignerStore.open(idb);
    const s2 = await IdbSignerStore.open(idb);
    const c1 = new SigningCoordinator({ store: s1, locks: undefined, lockPrefix: "t" });
    const c2 = new SigningCoordinator({ store: s2, locks: undefined, lockPrefix: "t" });
    const nonces = await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? c1 : c2).reserve("0xabc", { now: T0, orders: 1, notionalUsd: 10 })));
    expect(new Set(nonces).size).toBe(50);
    expect(Math.min(...nonces)).toBe(T0);
    expect(Math.max(...nonces)).toBe(T0 + 49);
    const usage = usageOf(await s1.readUsage("0xabc"), T0);
    expect(usage).toEqual({ ordersInLastMinute: 50, dailyNotionalUsedUsd: 500 });
  });
});

describe("SigningCoordinator", () => {
  it("fails with SIGNER_BUSY when the lock isn't granted in time (Web Locks)", async () => {
    const locks = new FakeLocks();
    const c = new SigningCoordinator({ store: new MemorySignerStore(), locks, lockPrefix: "t", lockTimeoutMs: 30 });
    let release!: () => void;
    const holder = c.withAgentLock("0xa", () => new Promise<void>((r) => (release = r)));
    await expect(c.withAgentLock("0xa", async () => 1)).rejects.toBeInstanceOf(SignerBusyError);
    release();
    await holder;
    await expect(c.withAgentLock("0xa", async () => 2)).resolves.toBe(2);
  });

  it("fails with SIGNER_BUSY in the in-tab fallback too, and recovers", async () => {
    const c = new SigningCoordinator({ store: new MemorySignerStore(), locks: undefined, lockPrefix: "t", lockTimeoutMs: 30 });
    let release!: () => void;
    const holder = c.withAgentLock("0xa", () => new Promise<void>((r) => (release = r)));
    await expect(c.withAgentLock("0xa", async () => 1)).rejects.toBeInstanceOf(SignerBusyError);
    release();
    await holder;
    await expect(c.withAgentLock("0xa", async () => 3)).resolves.toBe(3);
    // Different agents don't block each other.
    const other = c.withAgentLock("0xb", async () => "b");
    await expect(other).resolves.toBe("b");
  });

  it("nextUsage: max(now, last + 1), windowed order times, daily reset, ignores a corrupt future nonce", () => {
    const first = nextUsage("0xA", undefined, T0, 2, 100);
    expect(first).toMatchObject({ agent: "0xa", lastNonce: T0, orderTimes: [T0, T0], dayNotionalUsd: 100 });
    const second = nextUsage("0xa", first, T0, 1, 50);
    expect(second.lastNonce).toBe(T0 + 1);
    expect(second.dayNotionalUsd).toBe(150);
    const later = nextUsage("0xa", second, T0 + 61_000, 1, 0);
    expect(later.lastNonce).toBe(T0 + 61_000);
    expect(later.orderTimes).toEqual([T0 + 61_000]);
    const nextDay = nextUsage("0xa", later, T0 + 86_400_000, 0, 10);
    expect(nextDay.dayNotionalUsd).toBe(10);
    const corrupt = nextUsage("0xa", { ...first, lastNonce: T0 + 3 * 86_400_000 }, T0, 0, 0);
    expect(corrupt.lastNonce).toBe(T0);
  });
});

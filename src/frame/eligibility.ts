/**
 * Kokoah's region check, read by the frame itself before it signs anything that adds risk (`core.ts`).
 *
 * The app already stops a visitor whose region Kokoah blocks from opening positions; this makes the frame refuse it
 * too, so a changed or compromised app page can't trade around the block with the trading key. What only lowers risk
 * (cancels, reduce-only orders, a vault withdrawal) never asks.
 *
 * - The frame asks Kokoah's API (`VITE_ELIGIBILITY_URL`, `GET /v1/eligibility`, no cookies) itself: the answer goes by
 *   the visitor's own connection, and the parent can't supply or change it. Answers are reused for
 *   {@link ELIGIBILITY_TTL_MS}.
 * - It can only refuse, never allow anything the policy wouldn't: a compromised API can stop trading, not widen it.
 * - "Not allowed" is kept on the signer origin until a later answer allows ({@link StoredRegionRecord}), so blocking the
 *   check's request doesn't lift it. Without any "not allowed" on record, a check that fails (Kokoah's API down) lets
 *   trading go on: the frame keeps working through a backend outage, as before.
 * - No URL configured (development and test builds): no check.
 *
 * @module
 */
import type { NetworkName } from "../protocol/index.js";
import type { FetchLike } from "./hl.js";
import type { SignerStore } from "./storage.js";
import { regionSlot } from "./storage.js";

/** How long an answer is reused before the frame asks again. */
export const ELIGIBILITY_TTL_MS = 5 * 60_000;
/** How long the frame waits for an answer. */
export const ELIGIBILITY_TIMEOUT_MS = 5_000;

export type RegionDecision = { allowed: true } | { allowed: false; reason: "region" | "blocked" };

export interface RegionGateOptions {
  /** `GET /v1/eligibility` on Kokoah's API, or null for no check. */
  url: string | null;
  network: NetworkName;
  fetch: FetchLike;
  store: SignerStore;
  now: () => number;
}

export class RegionGate {
  private readonly o: RegionGateOptions;
  private cached: { at: number; decision: RegionDecision } | null = null;
  private asking: Promise<RegionDecision> | null = null;

  constructor(o: RegionGateOptions) {
    this.o = o;
  }

  /** Whether this visitor may add risk now. Never throws. */
  async check(): Promise<RegionDecision> {
    if (this.o.url === null) return { allowed: true };
    if (this.cached && this.o.now() - this.cached.at < ELIGIBILITY_TTL_MS) return this.cached.decision;
    this.asking ??= this.ask().finally(() => {
      this.asking = null;
    });
    return await this.asking;
  }

  private async ask(): Promise<RegionDecision> {
    const answer = await this.fetchAnswer();
    if (answer === null) {
      // No answer: the last one on record decides, and none means the API is down for everyone (trading goes on).
      const stored = await this.o.store.getRegion(this.o.network).catch(() => undefined);
      return stored?.allowed === false ? { allowed: false, reason: "blocked" } : { allowed: true };
    }
    const decision: RegionDecision = answer.allowed ? { allowed: true } : { allowed: false, reason: answer.blockedReason === "region" ? "region" : "blocked" };
    this.cached = { at: this.o.now(), decision };
    await this.o.store.putRegion({ slot: regionSlot(this.o.network), v: 1, allowed: answer.allowed, at: this.o.now() }).catch(() => undefined);
    return decision;
  }

  /** Kokoah's answer, or null when there is none (network error, timeout, an answer that isn't one). */
  private async fetchAnswer(): Promise<{ allowed: boolean; blockedReason: string | null } | null> {
    try {
      const res = await this.o.fetch(this.o.url!, { method: "GET", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(ELIGIBILITY_TIMEOUT_MS) });
      if (!res.ok) return null;
      const body = (await res.json()) as { allowed?: unknown; blockedReason?: unknown };
      if (typeof body?.allowed !== "boolean") return null;
      return { allowed: body.allowed, blockedReason: typeof body.blockedReason === "string" ? body.blockedReason : null };
    } catch {
      return null;
    }
  }
}

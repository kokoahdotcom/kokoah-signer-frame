/**
 * The account's positions and resting orders, read by the frame itself from Hyperliquid (never from the parent), for
 * the stop-loss check where the user's limits require a stop-loss (shared `stopCoverage.ts`): `clearinghouseState` and
 * `frontendOpenOrders` on each perp dex the action names, and `orderStatus` for each order it names that isn't among
 * them (at most {@link MAX_ORDER_LOOKUPS}): one that is closed (filled, canceled, never placed), or open but not a perp
 * stop-loss, takes nothing away. Read strictly: anything malformed, or a trigger order of a type the frame doesn't
 * know, throws {@link AccountBookError}, and nothing is signed.
 *
 * @module
 */
import type { ActionIntent } from "@kokoah/shared/intents";
import { parseCoin } from "@kokoah/shared/markets";
import type { AccountBook, AccountOrder, AccountPosition } from "@kokoah/shared/policy";

/** Most orders an action names outside the books read that are looked up one by one. */
export const MAX_ORDER_LOOKUPS = 10;

/** An order as the frame reads it: also whether a trigger executes at market, and its limit price (always set). */
export type BookOrder = AccountOrder & { isMarket: boolean; limitPrice: number | undefined };

/** The book as the frame reads it, with the orders it named that can't be a stop-loss (`notStops`). */
export type FrameAccountBook = AccountBook & { orders: BookOrder[]; notStops?: Array<number | string> };

/** The account's positions and orders couldn't be read or trusted. Never carries a response body. */
export class AccountBookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountBookError";
  }
}

/** Hyperliquid's trigger order types: the kind of exit each is, and whether it executes at market when it fires. */
const TRIGGER_TYPES: Readonly<Record<string, { tpsl: "tp" | "sl"; isMarket: boolean }>> = {
  "Stop Market": { tpsl: "sl", isMarket: true },
  "Stop Limit": { tpsl: "sl", isMarket: false },
  "Take Profit Market": { tpsl: "tp", isMarket: true },
  "Take Profit Limit": { tpsl: "tp", isMarket: false },
};
/**
 * Whether an `orderStatus` status is final (the order is off the book): `filled`, `canceled`, `rejected`,
 * `scheduledCancel`, and the `…Canceled` / `…Rejected` family. Any other status, a new one included, counts as open,
 * so an order the frame can't place is never taken for a closed one.
 */
export function isFinalOrderStatus(status: string): boolean {
  return status === "filled" || status === "canceled" || status === "rejected" || status === "scheduledCancel" || /^[a-z][A-Za-z]*(Canceled|Rejected)$/.test(status);
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function num(x: unknown, what: string): number {
  const n = typeof x === "string" && x.trim() !== "" ? Number(x) : Number.NaN;
  if (!Number.isFinite(n)) throw new AccountBookError(`Hyperliquid sent an unreadable ${what}`);
  return n;
}

/** One `frontendOpenOrders` entry, strictly. */
function order(o: unknown): BookOrder {
  if (!isRecord(o) || typeof o.coin !== "string" || (o.side !== "A" && o.side !== "B") || !Number.isSafeInteger(o.oid) || (o.oid as number) < 0) {
    throw new AccountBookError("Hyperliquid sent an unreadable open order");
  }
  if (typeof o.isTrigger !== "boolean" || typeof o.reduceOnly !== "boolean" || typeof o.isPositionTpsl !== "boolean" || typeof o.orderType !== "string") {
    throw new AccountBookError("Hyperliquid sent an unreadable open order");
  }
  if (o.cloid !== undefined && o.cloid !== null && typeof o.cloid !== "string") throw new AccountBookError("Hyperliquid sent an unreadable open order");
  const trigger = o.isTrigger ? TRIGGER_TYPES[o.orderType] : null;
  if (trigger === undefined) throw new AccountBookError("Hyperliquid sent a trigger order of an unknown type");
  return {
    coin: o.coin,
    oid: o.oid as number,
    ...(typeof o.cloid === "string" ? { cloid: o.cloid.toLowerCase() } : {}),
    isBuy: o.side === "B",
    size: num(o.sz, "order size"),
    isTrigger: o.isTrigger,
    ...(trigger !== null ? { triggerPrice: num(o.triggerPx, "trigger price"), tpsl: trigger.tpsl } : {}),
    isMarket: trigger?.isMarket ?? false,
    limitPrice: num(o.limitPx, "limit price"),
    reduceOnly: o.reduceOnly,
    positionTpsl: o.isPositionTpsl,
  };
}

function positions(state: unknown): AccountPosition[] {
  if (!isRecord(state) || !Array.isArray(state.assetPositions)) throw new AccountBookError("Hyperliquid sent unreadable positions");
  return state.assetPositions.map((a: unknown) => {
    const p = isRecord(a) ? a.position : undefined;
    if (!isRecord(p) || typeof p.coin !== "string") throw new AccountBookError("Hyperliquid sent an unreadable position");
    return { coin: p.coin, size: num(p.szi, "position size"), entryPrice: num(p.entryPx, "entry price") };
  });
}

/** Whether the order `ref` names (as `orderStatus` answered for it) is open, and could be a perp stop-loss. */
function orderState(r: unknown, ref: number | string): { open: boolean; mayBeStop: boolean } {
  if (isRecord(r) && r.status === "unknownOid") return { open: false, mayBeStop: false };
  if (!isRecord(r) || r.status !== "order" || !isRecord(r.order) || typeof r.order.status !== "string") throw new AccountBookError("Hyperliquid sent an unreadable order status");
  const o = order(r.order.order);
  // An answer about another order must never stand in for this one.
  if (typeof ref === "number" ? o.oid !== ref : o.cloid !== ref) throw new AccountBookError("Hyperliquid answered for another order");
  const parsed = parseCoin(o.coin);
  // A name the frame can't read might be a perp's.
  const perp = parsed === null || parsed.kind === "perp" || parsed.kind === "hip3";
  return { open: !isFinalOrderStatus(r.order.status), mayBeStop: perp && o.isTrigger && o.tpsl === "sl" && (o.reduceOnly || o.positionTpsl) };
}

/** Reads the book of `account` for `intent` (see the module notes) with `info` (the frame's own `POST /info`). */
export async function readAccountBook(info: (body: Record<string, unknown>) => Promise<unknown>, account: `0x${string}`, intent: ActionIntent): Promise<FrameAccountBook> {
  const coins = intent.kind === "cancel" ? intent.cancels.map((c) => c.coin) : intent.kind === "modify" ? [intent.order.coin] : intent.kind === "order" ? [intent.coin] : [];
  const dexes = new Set<string>();
  for (const c of coins) {
    // Spot and outcome orders can't protect a perp position.
    const parsed = parseCoin(c);
    if (parsed?.kind === "perp" || parsed?.kind === "hip3") dexes.add(parsed.kind === "hip3" ? parsed.dex : "");
  }
  const book: FrameAccountBook = { positions: [], orders: [] };
  const all: AccountPosition[] = [];
  for (const dex of dexes) {
    const at = dex === "" ? {} : { dex };
    const [state, open] = await Promise.all([info({ type: "clearinghouseState", user: account, ...at }), info({ type: "frontendOpenOrders", user: account, ...at })]);
    if (!Array.isArray(open)) throw new AccountBookError("Hyperliquid sent unreadable open orders");
    all.push(...positions(state));
    for (const o of open) book.orders.push(order(o));
  }
  book.positions = all;
  const refs: Array<number | string> =
    intent.kind === "cancel"
      ? intent.cancels.map((c) => ("oid" in c ? c.oid : c.cloid.toLowerCase()))
      : intent.kind === "modify"
        ? ["oid" in intent.target ? intent.target.oid : intent.target.cloid.toLowerCase()]
        : [];
  const inBook = (ref: number | string) => book.orders.some((o) => (typeof ref === "number" ? o.oid === ref : o.cloid === ref));
  const notStops: Array<number | string> = [];
  for (const ref of [...new Set(refs.filter((r) => !inBook(r)))].slice(0, MAX_ORDER_LOOKUPS)) {
    const state = orderState(await info({ type: "orderStatus", user: account, oid: ref }), ref);
    if (!state.open || !state.mayBeStop) notStops.push(ref);
  }
  if (notStops.length > 0) book.notStops = notStops;
  return book;
}

/**
 * DEV ONLY (kokoah-dev-harness). A stand-in for the Hyperliquid API used by the dev harness and the browser smoke test.
 *
 * - `/hl/info`: canned market data (mode "mock"), or a read-only proxy to HL **testnet** `/info` (mode "testnet").
 *   `extraAgents` is always served from local state, because agent approvals are simulated.
 * - `/hl/exchange`: **never forwarded anywhere.** Verifies the L1 signature with `@kokoah/shared` `recoverL1Signer`,
 *   checks the signer is a (simulated) approved agent, `expiresAfter` and nonce reuse, and answers like HL.
 * - `/hl/_dev/approve`: the harness's throwaway "main wallet" posts `{ typedData, signature }` of the frame's
 *   `approveAgent` (or `revokeAgent`); the signer is recovered and the agent registered (or removed).
 *
 * Only addresses are logged, never signatures or bodies.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseAgentName, recoverL1Signer, recoverUserSignedSigner, type UserSignedTypedData } from "@kokoah/shared/signing";

export type MockMode = "mock" | "testnet";

const TESTNET_INFO = "https://api.hyperliquid-testnet.xyz/info";

const META0 = {
  universe: [
    { name: "BTC", szDecimals: 5, maxLeverage: 40 },
    { name: "ETH", szDecimals: 4, maxLeverage: 25 },
    { name: "SOL", szDecimals: 2, maxLeverage: 20 },
  ],
  marginTables: [],
};
const META_XYZ = { universe: [{ name: "xyz:GOLD", szDecimals: 4, maxLeverage: 10 }], marginTables: [], collateralToken: 0 };
const PERP_DEXS = [null, { name: "xyz", fullName: "XYZ (mock)", deployer: "0x2222222222222222222222222222222222222222", assetToStreamingOiCap: [], assetToFundingMultiplier: [] }];

export interface MockHlState {
  mark: Record<string, string>;
  agents: Map<string, Array<{ address: string; name: string; validUntil: number | null }>>;
  /** agent address → user */
  agentUser: Map<string, string>;
  usedNonces: Map<string, Set<number>>;
  exchangeCount: number;
}

async function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

/** Creates the mock. `handle` returns false for paths it doesn't serve. */
export function createMockHl(options: { mode: MockMode; log?: (line: string) => void }) {
  const log = options.log ?? ((l: string) => console.log(`[mock-hl] ${l}`));
  const state: MockHlState = {
    mark: { BTC: "100000", ETH: "2000", SOL: "150", "xyz:GOLD": "3000" },
    agents: new Map(),
    agentUser: new Map(),
    usedNonces: new Map(),
    exchangeCount: 0,
  };
  const ctxs = (meta: { universe: Array<{ name: string }> }) => meta.universe.map((u) => ({ markPx: state.mark[u.name] ?? "1", midPx: state.mark[u.name] ?? null, oraclePx: state.mark[u.name] ?? "1", funding: "0.0000125", openInterest: "100" }));

  function info(body: Record<string, unknown>): unknown {
    switch (body.type) {
      case "metaAndAssetCtxs":
        return body.dex === "xyz" ? [META_XYZ, ctxs(META_XYZ)] : body.dex ? [{ universe: [] }, []] : [META0, ctxs(META0)];
      case "perpDexs":
        return PERP_DEXS;
      case "exchangeStatus":
        return { time: Date.now(), specialStatuses: null };
      case "extraAgents":
        return state.agents.get(String(body.user).toLowerCase()) ?? [];
      case "activeAssetData":
        return { user: body.user, coin: body.coin, leverage: { type: "cross", value: 10 }, maxTradeSzs: ["1", "1"], availableToTrade: ["1", "1"], markPx: state.mark[String(body.coin)] ?? "1" };
      default:
        return null;
    }
  }

  async function exchange(body: { action: Record<string, unknown> & { type: string }; nonce: number; signature: never; vaultAddress?: `0x${string}`; expiresAfter?: number }): Promise<unknown> {
    const signer = (await recoverL1Signer({ action: body.action, nonce: body.nonce, network: { isTestnet: true }, vaultAddress: body.vaultAddress, expiresAfter: body.expiresAfter, signature: body.signature })).toLowerCase();
    const user = state.agentUser.get(signer);
    if (!user) return { status: "err", response: `User or API Wallet ${signer} does not exist.` };
    const entry = state.agents.get(user)?.find((a) => a.address === signer);
    if (entry?.validUntil !== null && entry?.validUntil !== undefined && entry.validUntil < Date.now()) return { status: "err", response: `User or API Wallet ${signer} does not exist.` };
    if (body.expiresAfter !== undefined && body.expiresAfter < Date.now()) return { status: "err", response: "Action already expired" };
    const used = state.usedNonces.get(signer) ?? new Set<number>();
    if (used.has(body.nonce)) return { status: "err", response: "Invalid nonce: duplicate nonce" };
    used.add(body.nonce);
    state.usedNonces.set(signer, used);
    state.exchangeCount++;
    log(`exchange ${body.action.type} signed by agent ${signer} for user ${user}`);
    const a = body.action;
    if (a.type === "order") return { status: "ok", response: { type: "order", data: { statuses: (a.orders as Array<{ c?: string }>).map((o, i) => ({ resting: { oid: 5000 + state.exchangeCount * 10 + i, ...(o.c ? { cloid: o.c } : {}) } })) } } };
    if (a.type === "cancel" || a.type === "cancelByCloid") return { status: "ok", response: { type: "cancel", data: { statuses: (a.cancels as unknown[]).map(() => "success") } } };
    return { status: "ok", response: { type: "default" } };
  }

  async function approve(body: { typedData: UserSignedTypedData; signature: never }): Promise<unknown> {
    const user = (await recoverUserSignedSigner({ typedData: body.typedData, signature: body.signature })).toLowerCase();
    const m = body.typedData.message as { agentAddress: string; agentName: string };
    const { name, validUntil } = parseAgentName(m.agentName);
    const list = (state.agents.get(user) ?? []).filter((a) => a.name !== name);
    if (/^0x0{40}$/.test(m.agentAddress)) {
      log(`revoked agent "${name}" of user ${user}`);
    } else {
      list.push({ address: m.agentAddress.toLowerCase(), name, validUntil: validUntil ?? null });
      state.agentUser.set(m.agentAddress.toLowerCase(), user);
      log(`approved agent ${m.agentAddress.toLowerCase()} "${name}" for user ${user}`);
    }
    state.agents.set(user, list);
    return { status: "ok", response: { type: "default" } };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = req.url ?? "";
    if (!url.startsWith("/hl/")) return false;
    // The frame is on another origin: CORS as HL itself does (access-control-allow-origin: *).
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return true;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "POST only" });
      return true;
    }
    try {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      if (url === "/hl/info") {
        if (options.mode === "testnet" && body.type !== "extraAgents") {
          const r = await fetch(TESTNET_INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          res.statusCode = r.status;
          res.setHeader("content-type", "application/json");
          res.end(await r.text());
        } else send(res, 200, info(body));
      } else if (url === "/hl/exchange") send(res, 200, await exchange(body as never));
      else if (url === "/hl/_dev/approve") send(res, 200, await approve(body as never));
      else if (url === "/hl/_dev/mark") {
        Object.assign(state.mark, body as Record<string, string>);
        send(res, 200, { mark: state.mark });
      } else send(res, 404, { error: "unknown path" });
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.name : "error" });
    }
    return true;
  }

  return { handle, state };
}

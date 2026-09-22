/**
 * DEV ONLY (kokoah-dev-harness). A stand-in for the Kokoah frontend that embeds the signer frame through
 * KokoahSignerClient and exercises every protocol message. Never part of the production build.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { KokoahSignerClient, SignerRequestError, EVENTS, type CreateAgentResult, type PreparedUserSignedAction } from "../src/client/index.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $<HTMLPreElement>("log");

function log(title: string, data?: unknown): void {
  const time = new Date().toISOString().slice(11, 23);
  logEl.textContent = `[${time}] ${title}${data === undefined ? "" : `\n${JSON.stringify(data, null, 2)}`}\n\n${logEl.textContent ?? ""}`;
}

// Throwaway "main wallet". Real apps use the user's wallet (wagmi/Privy signTypedData).
const mainWallet = privateKeyToAccount(generatePrivateKey());
$("main-wallet").textContent = mainWallet.address;

let requestId = crypto.randomUUID();
$("request-id").textContent = requestId;
let lastCreate: CreateAgentResult | null = null;

const templates: Record<string, unknown> = {
  "limit buy ETH": { kind: "order", coin: "ETH", side: "buy", orderType: "limit", size: "0.01", price: "1990", origin: "manual" },
  "market buy ETH (1% slippage)": { kind: "order", coin: "ETH", side: "buy", orderType: "market", size: "0.01", slippageBps: 100, origin: "manual" },
  "limit + TP/SL": { kind: "order", coin: "ETH", side: "buy", orderType: "limit", size: "0.01", price: "1990", takeProfit: { triggerPrice: "2200" }, stopLoss: { triggerPrice: "1900" }, origin: "manual" },
  "HIP-3 limit xyz:GOLD": { kind: "order", coin: "xyz:GOLD", side: "buy", orderType: "limit", size: "0.01", price: "3000", origin: "manual" },
  "cancel by oid": { kind: "cancel", cancels: [{ coin: "ETH", oid: 5010 }], origin: "manual" },
  "update leverage 5x cross": { kind: "updateLeverage", coin: "ETH", leverage: 5, marginMode: "cross", origin: "manual" },
  "add isolated margin": { kind: "updateIsolatedMargin", coin: "ETH", amountUsd: "10", origin: "manual" },
  "schedule cancel (+60 s)": { kind: "scheduleCancel", time: Date.now() + 60_000, origin: "manual" },
  noop: { kind: "noop", origin: "manual" },
  "DENIED: price 50% from mark": { kind: "order", coin: "ETH", side: "buy", orderType: "limit", size: "0.01", price: "3000", origin: "manual" },
  "DENIED: vault address": { kind: "order", coin: "ETH", side: "buy", orderType: "limit", size: "0.01", price: "1990", origin: "manual", vaultAddress: "0x3333333333333333333333333333333333333333" },
  "REJECTED: not an intent (vaultTransfer)": { kind: "vaultTransfer", origin: "manual" },
};
const templateSelect = $<HTMLSelectElement>("template");
for (const name of Object.keys(templates)) {
  const o = document.createElement("option");
  o.textContent = name;
  templateSelect.append(o);
}
const intentArea = $<HTMLTextAreaElement>("intent");
const showTemplate = () => (intentArea.value = JSON.stringify(templates[templateSelect.value], null, 2));
templateSelect.addEventListener("change", showTemplate);
showTemplate();

async function postToMock(prepared: PreparedUserSignedAction): Promise<unknown> {
  const signature = await mainWallet.signTypedData(prepared.typedData as never);
  const r = await fetch("/hl/_dev/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ typedData: prepared.typedData, signature: { r: `0x${signature.slice(2, 66)}`, s: `0x${signature.slice(66, 130)}`, v: parseInt(signature.slice(130, 132), 16) } }),
  });
  return await r.json();
}

async function start(): Promise<void> {
  const cfg = (await (await fetch("/_dev/config")).json()) as { frameUrl: string; hlMode: string };
  $("env").textContent = `frame ${cfg.frameUrl} · HL mode ${cfg.hlMode}`;
  const client = new KokoahSignerClient({ frameUrl: cfg.frameUrl, container: $("frame-slot"), clientInfo: { name: "kokoah-dev-harness", version: "dev" } });
  for (const e of EVENTS) client.on(e, (data) => log(`event ${e}`, data));
  $<HTMLInputElement>("always-show").addEventListener("change", (ev) => client.setFrameVisible((ev.target as HTMLInputElement).checked));

  const actions: Record<string, () => Promise<unknown>> = {
    hello: () => client.hello(),
    getStatus: () => client.getStatus(),
    createAgent: async () => {
      lastCreate = await client.createAgent({
        userAddress: mainWallet.address,
        validForDays: Number($<HTMLInputElement>("valid-days").value),
        storageMode: $<HTMLSelectElement>("storage-mode").value as "device",
        replaceExisting: $<HTMLInputElement>("replace-existing").checked,
      });
      return lastCreate;
    },
    approve: async () => {
      if (!lastCreate) throw new Error("call createAgent first");
      return await postToMock(lastCreate.approveAgent);
    },
    confirmAgent: () => client.confirmAgent({ timeoutMs: 5_000 }),
    unlock: () => client.unlock(),
    lock: () => client.lock(),
    revoke: async () => {
      const r = await client.revoke();
      return { revoke: r, mock: await postToMock(r.revokeAgent) };
    },
    signAndSubmit: async () => client.signAndSubmit({ requestId, intent: JSON.parse(intentArea.value) }),
    newRequestId: async () => {
      requestId = crypto.randomUUID();
      $("request-id").textContent = requestId;
      return requestId;
    },
    setLimits: () => client.setLimits(JSON.parse($<HTMLTextAreaElement>("limits").value)),
    resetLimits: () => client.setLimits({}),
    setTheme: () => client.setTheme(JSON.parse($<HTMLTextAreaElement>("theme").value)),
    setMark: async () => (await fetch("/hl/_dev/mark", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ETH: $<HTMLInputElement>("eth-mark").value }) })).json(),
    clearLog: async () => {
      logEl.textContent = "";
    },
  };

  document.body.addEventListener("click", (ev) => {
    const name = (ev.target as HTMLElement).closest("button")?.dataset.action;
    const fn = name ? actions[name] : undefined;
    if (!name || !fn) return;
    fn().then(
      (r) => name !== "clearLog" && log(`${name} → ok`, r),
      (e: unknown) => log(`${name} → ${e instanceof SignerRequestError ? e.code : "error"}`, e instanceof SignerRequestError ? { code: e.code, message: e.message, details: e.details } : String(e)),
    );
  });
  log("harness ready", { mainWallet: mainWallet.address, frameUrl: cfg.frameUrl });
}

void start();

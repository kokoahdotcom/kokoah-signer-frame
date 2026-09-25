#!/usr/bin/env node
/**
 * Real-browser smoke test (headless Chromium over the DevTools protocol, no extra dependencies).
 *
 * What it verifies that jsdom can't:
 * - the built frame runs under its real CSP (header from public/_headers + the <meta> policy), Trusted Types
 *   (`trusted-types 'none'`) and SRI, with no violations or console errors during the flows;
 * - HTML sinks, eval and fetches to other hosts are blocked inside the frame;
 * - `frame-ancestors` stops an unlisted origin from embedding the frame;
 * - the parent ↔ frame protocol across two real origins (cross-site iframe), IndexedDB persistence of the device key
 *   (non-extractable CryptoKey) across a reload, Web Locks, and the client's re-handshake (`reconnected`) when only the
 *   iframe reloads;
 * - the signer's real `public/_headers` Permissions-Policy (served unchanged) allows WebAuthn: the full passkey flow
 *   with a **virtual authenticator that supports PRF**: create → sign → lock → unlock (passkey assertion) → sign; after
 *   a reload the key is locked;
 * - when the app doesn't delegate WebAuthn (its own Permissions-Policy disables it), passkeys are reported unavailable
 *   and `passkey` falls back to `device`;
 * - Link phone: `createLinkedAgent` in the real frame returns the matching code the computer computes, and the key
 *   signs once another wallet's `approveAgent` for its address is on the (mock) exchange.
 *
 * The frame is served with `public/_headers` as built; the only changes are origins: `frame-ancestors` and
 * `connect-src` name the local test origins instead of the production placeholders (and HSTS is dropped on http).
 *
 * Nothing talks to Hyperliquid: the frame is built with its HL API pointed at a local mock (dev/mock-hl.ts) that
 * verifies signatures. All servers listen on ephemeral 127.0.0.1/localhost ports and are closed at the end.
 *
 * Usage: pnpm build:client && node scripts/smoke-browser.ts   (CHROME_PATH=/path/to/chrome to override)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { deviceLinkCode, generateLinkSecret } from "@kokoah/shared/link";
import { getNetworkConfig } from "@kokoah/shared/network";
import { buildApproveAgent } from "@kokoah/shared/signing";
import { createMockHl } from "../dev/mock-hl.ts";
import { addSri } from "./postbuild.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BUILDER = "0x00000000000000000000000000000000000b0b1d";
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json" };

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}
const checks: Check[] = [];
/** Browser notes that are not frame problems (e.g. header features this Chrome build doesn't know). */
const notes = new Set<string>();
const INFORMATIONAL = /Error with Permissions-Policy header: Unrecognized feature/;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks.push({ name, ok, ...(detail !== undefined ? { detail: typeof detail === "string" ? detail : JSON.stringify(detail) } : {}) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined && !ok ? `  — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

function findChrome(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(process.env.HOME ?? "/root", ".cache/ms-playwright");
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      const p = join(cache, d, "chrome-linux64", "chrome");
      if (existsSync(p)) return p;
    }
  }
  throw new Error("Chromium not found; set CHROME_PATH");
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void, host: string): Promise<{ server: Server; origin: string }> {
  return new Promise((ok) => {
    const server = createServer(handler);
    server.listen(0, host, () => {
      const port = (server.address() as { port: number }).port;
      ok({ server, origin: `http://${host === "127.0.0.1" ? "127.0.0.1" : "localhost"}:${port}` });
    });
  });
}

/** Headers of the `/*` rule of a Cloudflare `_headers` file. */
function rootHeaders(file: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let inRoot = false;
  for (const line of file.split(/\r?\n/)) {
    if (line.startsWith("#") || line.trim() === "") continue;
    if (/^\S/.test(line)) {
      inRoot = line.trim() === "/*";
      continue;
    }
    const m = /^\s+([^:]+):\s*(.*)$/.exec(line);
    if (inRoot && m) out.push([m[1] as string, m[2] as string]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Minimal CDP client
// ---------------------------------------------------------------------------------------------

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string }; sessionId?: string };

class Cdp {
  private readonly ws: WebSocket;
  private id = 0;
  private readonly pending = new Map<number, { ok: (r: Record<string, unknown>) => void; fail: (e: Error) => void }>();
  private readonly handlers: Array<(m: Msg) => void> = [];
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as Msg;
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.fail(new Error(m.error.message));
        else p?.ok(m.result ?? {});
      } else for (const h of this.handlers) h(m);
    };
  }
  static connect(url: string): Promise<Cdp> {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(url);
      ws.onopen = () => ok(new Cdp(ws));
      ws.onerror = () => fail(new Error("CDP connection failed"));
    });
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((ok, fail) => this.pending.set(id, { ok, fail }));
  }
  on(h: (m: Msg) => void): void {
    this.handlers.push(h);
  }
  close(): void {
    this.ws.close();
  }
}

async function main(): Promise<number> {
  const tmp = mkdtempSync(join(process.env.SMOKE_TMPDIR ?? tmpdir(), "kokoah-signer-smoke-"));
  const servers: Server[] = [];
  let chrome: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  const emergency = () => {
    chrome?.kill("SIGKILL");
    rmSync(tmp, { recursive: true, force: true });
  };
  process.once("uncaughtException", (e) => {
    emergency();
    console.error(e);
    process.exit(2);
  });
  process.once("unhandledRejection", (e) => {
    emergency();
    console.error(e);
    process.exit(2);
  });
  try {
    if (!existsSync(join(root, "dist-client/client/index.js"))) throw new Error("dist-client is missing: run pnpm build:client first");

    // Parent (app stand-in) + mock HL on 127.0.0.1; frames on localhost (another site → out-of-process iframe).
    const mock = createMockHl({ mode: "mock", log: () => {} });
    const parentFiles: Record<string, [string, string]> = {
      "/": ["text/html; charset=utf-8", '<!doctype html><html><head><meta charset="utf-8"><title>smoke parent</title><script type="module" src="/parent.js"></script></head><body><div id="slot"></div></body></html>'],
      "/parent.js": [
        "text/javascript",
        'import { KokoahSignerClient } from "/client/index.js";\nconst frameUrl = new URL(location.href).searchParams.get("frame");\nwindow.signer = new KokoahSignerClient({ frameUrl, container: document.getElementById("slot"), helloTimeoutMs: 20000 });\nwindow.reconnects = [];\nwindow.signer.on("reconnected", (h) => window.reconnects.push(h));\nwindow.smokeReady = true;\n',
      ],
      "/evil": ["text/html; charset=utf-8", "<!doctype html><html><body><iframe id=f></iframe><script type=module src=/evil.js></script></body></html>"],
    };
    const parent = await listen((req, res) => {
      void mock.handle(req, res).then((handled) => {
        if (handled) return;
        const path = (req.url ?? "/").split("?")[0] as string;
        const known = parentFiles[path];
        if (known) {
          // An app that doesn't delegate WebAuthn to the signer (the fallback case): its own policy disables it.
          if (path === "/" && new URL(req.url ?? "/", "http://x").searchParams.has("nowebauthn")) {
            res.setHeader("permissions-policy", "publickey-credentials-create=(), publickey-credentials-get=()");
          }
          res.setHeader("content-type", known[0]);
          res.end(known[1]);
          return;
        }
        const m = /^\/(client|protocol)\/([\w.-]+\.js)$/.exec(path);
        if (m) {
          res.setHeader("content-type", "text/javascript");
          res.end(readFileSync(join(root, "dist-client", m[1] as string, m[2] as string)));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
    }, "127.0.0.1");
    servers.push(parent.server);

    // Build the frame for these origins (development-mode config: http loopback origins + HL API override).
    let frameDist = "";
    const frameHandler = (req: IncomingMessage, res: ServerResponse) => {
      const path = (req.url ?? "/").split("?")[0] as string;
      const file = join(frameDist, path === "/" ? "index.html" : path);
      if (!file.startsWith(frameDist) || !existsSync(file) || path.includes("..") || path.endsWith("_headers")) {
        res.statusCode = 404;
        res.end();
        return;
      }
      for (const [k, v0] of rootHeaders(readFileSync(join(frameDist, "_headers"), "utf8"))) {
        let v = v0;
        if (k.toLowerCase() === "content-security-policy") {
          // Only substitutions: the smoke origins instead of the production placeholders.
          v = v.replace(/frame-ancestors [^;]+/, `frame-ancestors ${parent.origin}`).replace(/connect-src ([^;]+)/, `connect-src $1 ${parent.origin}`);
        }
        // Every other header (Permissions-Policy included) is served exactly as public/_headers has it.
        if (k.toLowerCase() === "strict-transport-security") continue; // meaningless on http://localhost
        res.setHeader(k, v);
      }
      res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
      res.end(readFileSync(file));
    };
    const frameA = await listen(frameHandler, "localhost");
    const frameB = await listen(frameHandler, "localhost");
    servers.push(frameA.server, frameB.server);
    const evil = await listen((req, res) => {
      const path = (req.url ?? "/").split("?")[0] as string;
      if (path === "/evil.js") {
        res.setHeader("content-type", "text/javascript");
        res.end(`document.getElementById("f").src = ${JSON.stringify(`${frameA.origin}/`)};`);
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(parentFiles["/evil"]?.[1]);
    }, "127.0.0.1");
    servers.push(evil.server);

    frameDist = join(tmp, "frame-dist");
    Object.assign(process.env, {
      VITE_HL_NETWORK: "testnet",
      VITE_ALLOW_MAINNET_WRITES: "false",
      VITE_ALLOWED_PARENT_ORIGINS: parent.origin,
      VITE_HL_API_URL_OVERRIDE: `${parent.origin}/hl`,
      VITE_BUILDER_ADDRESS: BUILDER,
      VITE_BUILDER_FEE_TENTHS_BPS: "25",
    });
    await build({ root, configFile: join(root, "vite.config.ts"), mode: "smoke", logLevel: "warn", build: { outDir: frameDist, emptyOutDir: true } });
    const indexPath = join(frameDist, "index.html");
    const sri = addSri(readFileSync(indexPath, "utf8"), (p) => {
      const f = join(frameDist, p);
      return existsSync(f) ? new Uint8Array(readFileSync(f)) : undefined;
    });
    if (sri.problems.length > 0) throw new Error(`SRI: ${sri.problems.join("; ")}`);
    writeFileSync(indexPath, sri.html);

    // Chrome.
    const userData = join(tmp, "profile");
    chrome = spawn(findChrome(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${userData}`, "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--site-per-process", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const wsUrl = await new Promise<string>((ok, fail) => {
      let buf = "";
      const t = setTimeout(() => fail(new Error("Chrome did not start")), 20_000);
      chrome?.stderr?.on("data", (d: Buffer) => {
        buf += d.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
        if (m?.[1]) {
          clearTimeout(t);
          ok(m[1]);
        }
      });
    });
    cdp = await Cdp.connect(wsUrl);
    const c = cdp;

    // Session bookkeeping: console errors, exceptions and log entries from every page and iframe.
    const problems: string[] = [];
    const iframeSessions = new Set<string>();
    const authenticatorSessions = new Set<string>();
    c.on((m) => {
      const p = m.params ?? {};
      if (m.method === "Runtime.exceptionThrown") problems.push(`exception: ${JSON.stringify((p.exceptionDetails as { exception?: { description?: string } })?.exception?.description ?? p.exceptionDetails).slice(0, 300)}`);
      if (m.method === "Runtime.consoleAPICalled" && (p.type === "error" || p.type === "warning")) problems.push(`console.${String(p.type)}: ${JSON.stringify(p.args).slice(0, 300)}`);
      if (m.method === "Log.entryAdded") {
        const e = p.entry as { level: string; text: string; source: string };
        if (INFORMATIONAL.test(e.text)) notes.add(e.text.slice(0, 200));
        else if (e.level === "error" || e.level === "warning") problems.push(`log(${e.source}): ${e.text.slice(0, 300)}`);
      }
      if (m.method === "Target.attachedToTarget") {
        const info = p.targetInfo as { type: string };
        const sessionId = p.sessionId as string;
        void (async () => {
          await c.send("Runtime.enable", {}, sessionId);
          await c.send("Log.enable", {}, sessionId);
          if (info.type === "iframe") iframeSessions.add(sessionId);
          await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => {});
          await c.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
        })().catch(() => {});
      }
      if (m.method === "Target.detachedFromTarget") iframeSessions.delete(p.sessionId as string);
    });

    const { targetId } = (await c.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const { sessionId: page } = (await c.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    await c.send("Page.enable", {}, page);
    await c.send("Runtime.enable", {}, page);
    await c.send("Log.enable", {}, page);
    await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, page);

    const evaluate = async <T>(expression: string, sessionId = page, userGesture = false): Promise<T> => {
      const r = (await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId)) as { result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluation failed");
      return r.result.value;
    };
    const waitUntil = async (expression: string, sessionId = page, timeoutMs = 15_000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          if (await evaluate<boolean>(expression, sessionId)) return;
        } catch {
          // not ready
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`timeout waiting for ${expression}`);
    };
    const open = async (frameUrl: string, options: { delegateWebAuthn?: boolean } = {}) => {
      problems.length = 0;
      const nowebauthn = options.delegateWebAuthn === false ? "&nowebauthn=1" : "";
      await c.send("Page.navigate", { url: `${parent.origin}/?frame=${encodeURIComponent(frameUrl)}${nowebauthn}` }, page);
      await waitUntil("window.smokeReady === true");
    };
    const waitFrameSession = async (origin: string): Promise<string> => {
      const start = Date.now();
      while (Date.now() - start < 15_000) {
        for (const sid of [...iframeSessions]) {
          const o = await evaluate<string>("location.origin", sid).catch(() => "");
          if (o !== origin) continue;
          if (origin === frameB.origin && !authenticatorSessions.has(sid)) {
            await c.send("WebAuthn.enable", { enableUI: false }, sid);
            await c.send(
              "WebAuthn.addVirtualAuthenticator",
              { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } },
              sid,
            );
            authenticatorSessions.add(sid);
          }
          return sid;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`no iframe session for ${origin}`);
    };
    const mainWallet = privateKeyToAccount(generatePrivateKey());
    const approve = async (prepared: { typedData: unknown }) => {
      const sig = await mainWallet.signTypedData(prepared.typedData as never);
      const r = await fetch(`${parent.origin}/hl/_dev/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ typedData: prepared.typedData, signature: { r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}`, v: parseInt(sig.slice(130, 132), 16) } }),
      });
      return (await r.json()) as unknown;
    };
    const intent = (price = "1990") => JSON.stringify({ kind: "order", coin: "ETH", side: "buy", orderType: "limit", size: "0.01", price, origin: "manual" });

    // ---------------------------------------------------------------- Frame A: an app that doesn't delegate WebAuthn.
    const servedPolicy = (await fetch(`${frameA.origin}/`)).headers.get("permissions-policy") ?? "";
    const filePolicy = /^\s+Permissions-Policy:\s*(.+)$/m.exec(readFileSync(join(root, "public", "_headers"), "utf8"))?.[1]?.trim() ?? "";
    check(
      "the signer serves public/_headers' Permissions-Policy unchanged, WebAuthn allowed for self",
      servedPolicy === filePolicy && /publickey-credentials-create=\(self\)/.test(servedPolicy) && /publickey-credentials-get=\(self\)/.test(servedPolicy),
      servedPolicy,
    );
    await open(`${frameA.origin}/`, { delegateWebAuthn: false });
    const hello = await evaluate<{ network: string; builder: { address: string }; frameOrigin: string; capabilities: { passkey: { available: boolean; reason?: string }; webLocks: boolean; indexedDB: boolean; storageModes: string[] } }>("signer.hello()");
    check("hello over a real cross-site iframe (network, builder, origin)", hello.network === "testnet" && hello.builder.address === BUILDER && hello.frameOrigin === frameA.origin, hello);
    check("Web Locks and IndexedDB available in the frame", hello.capabilities.webLocks && hello.capabilities.indexedDB, hello.capabilities);
    check("app Permissions-Policy without WebAuthn → passkey reported unavailable", !hello.capabilities.passkey.available && /Permissions-Policy/.test(hello.capabilities.passkey.reason ?? ""), hello.capabilities.passkey);
    const createdA = await evaluate<{ agentAddress: string; storageMode: string; storageFallbackReason?: string; approveAgent: { typedData: unknown } }>(
      `signer.createAgent({ userAddress: ${JSON.stringify(mainWallet.address)}, validForDays: 30, storageMode: "passkey" })`,
    );
    check("passkey request falls back to device storage", createdA.storageMode === "device" && /passkey unavailable/.test(createdA.storageFallbackReason ?? ""), createdA.storageFallbackReason);
    await approve(createdA.approveAgent);
    const confirmed = await evaluate<{ keyState: string }>("signer.confirmAgent({ timeoutMs: 3000 })");
    check("confirmAgent finds the agent via extraAgents", confirmed.keyState === "active", confirmed);
    const signed = await evaluate<{ status: string; cloids: string[] }>(`signer.signAndSubmit({ requestId: crypto.randomUUID(), intent: ${intent()} })`);
    check("signAndSubmit: mock HL verified the agent signature", signed.status === "ok" && mock.state.exchangeCount === 1, signed);
    // Account actions (PHASE3 REV): the fee trial goes through the same path; without a configured referral code,
    // setReferrer is refused before anything is signed.
    const trial = await evaluate<{ status: string; actionType: string }>('signer.signAndSubmit({ requestId: crypto.randomUUID(), intent: { kind: "startFeeTrial", origin: "manual", tier: 1 } })');
    check("startFeeTrial: mock HL verified the agent signature", trial.status === "ok" && trial.actionType === "startFeeTrial" && mock.state.exchangeCount === 2, trial);
    const referral = await evaluate<{ code?: string; violations?: string }>(
      'signer.signAndSubmit({ requestId: crypto.randomUUID(), intent: { kind: "setReferrer", origin: "manual" } }).then(() => ({}), (e) => ({ code: e.code, violations: JSON.stringify(e.details?.violations ?? []) }))',
    );
    check("setReferrer without a configured code is POLICY_DENIED, nothing sent", referral.code === "POLICY_DENIED" && /REFERRER_ACTION_DENIED/.test(referral.violations ?? "") && mock.state.exchangeCount === 2, referral);
    const denied = await evaluate<{ code: string }>(`signer.signAndSubmit({ requestId: crypto.randomUUID(), intent: ${intent("3000")} }).then(() => ({ code: "none" }), (e) => ({ code: e.code }))`);
    check("policy denial surfaces as POLICY_DENIED", denied.code === "POLICY_DENIED", denied);
    const theme = await evaluate<{ applied: string[] }>(`signer.setTheme({ variables: { "--ks-accent": "#123456" }, colorScheme: "dark" })`);
    const fa = await waitFrameSession(frameA.origin);
    const accent = await evaluate<string>("getComputedStyle(document.documentElement).getPropertyValue('--ks-accent').trim()", fa);
    check("setTheme applies CSS variables under style-src 'self' (CSSOM)", theme.applied.length === 1 && accent === "#123456", accent);
    const probes = await evaluate<Record<string, string>>(
      `(async () => {
        const out = {};
        try { document.body.innerHTML = "<b>x</b>"; out.innerHTML = "allowed"; } catch (e) { out.innerHTML = e.name; }
        try { const s = document.createElement("script"); s.src = "https://evil.example/x.js"; out.scriptSrc = "allowed"; } catch (e) { out.scriptSrc = e.name; }
        try { await fetch("https://example.com/"); out.fetch = "allowed"; } catch (e) { out.fetch = e.name; }
        try { setTimeout("1"); out.stringTimer = "allowed"; } catch (e) { out.stringTimer = e.name; }
        out.cryptoKeyInIdb = await new Promise((ok) => { const r = indexedDB.open("kokoah-signer"); r.onsuccess = () => { const tx = r.result.transaction("keys"); const g = tx.objectStore("keys").get("current"); g.onsuccess = () => ok(String(g.result && g.result.deviceKey && g.result.deviceKey.extractable)); }; r.onerror = () => ok("error"); });
        return out;
      })()`,
      fa,
    );
    check("Trusted Types blocks innerHTML and script.src in the frame", probes.innerHTML === "TypeError" && probes.scriptSrc === "TypeError", probes);
    check("CSP connect-src blocks fetches to other hosts", probes.fetch === "TypeError", probes);
    check("device key's CryptoKey in IndexedDB is non-extractable", probes.cryptoKeyInIdb === "false", probes);
    const cspErrorsExpected = problems.filter((p) => /Content Security Policy|Trusted Type|TrustedScript|require-trusted-types/i.test(p));
    check("the probes themselves were reported as CSP/TT violations", cspErrorsExpected.length >= 2, cspErrorsExpected.length);

    // Reload: device key restored from IndexedDB.
    problems.length = 0;
    await open(`${frameA.origin}/`, { delegateWebAuthn: false });
    await evaluate("signer.hello()");
    const afterReload = await evaluate<{ hasKey: boolean; keyState: string; locked: boolean; agentAddress: string }>("signer.getStatus()");
    check("device key survives a reload (IndexedDB) and stays unlocked", afterReload.hasKey && afterReload.keyState === "active" && !afterReload.locked && afterReload.agentAddress === createdA.agentAddress, afterReload);
    const signed2 = await evaluate<{ status: string }>(`signer.signAndSubmit({ requestId: crypto.randomUUID(), intent: ${intent()} })`);
    check("signing after reload", signed2.status === "ok" && mock.state.exchangeCount === 3, signed2);
    // Reload only the iframe: the client re-handshakes on the new ready and emits reconnected (never on the first ready).
    const before = await evaluate<number>("window.reconnects.length");
    await evaluate("signer.iframe.src = signer.iframe.src; true");
    await waitUntil("window.reconnects.length === 1");
    const reconnected = await evaluate<{ status: { agentAddress: string; keyState: string } }>("window.reconnects[0]");
    const afterFrameReload = await evaluate<{ agentAddress: string; locked: boolean }>("signer.getStatus()");
    check(
      "an iframe reload triggers one reconnected (new hello) and requests keep working",
      before === 0 && reconnected.status.agentAddress === createdA.agentAddress && reconnected.status.keyState === "active" && afterFrameReload.agentAddress === createdA.agentAddress,
      { before, reconnected: reconnected.status, afterFrameReload },
    );
    // Link phone: the phone's own key, the matching code computed inside the real frame, the computer's approveAgent.
    const link = { pairingId: "0b7f1a52-3c3d-4c1e-9d0e-6a1b2c3d4e5f", secret: generateLinkSecret() };
    const linked = await evaluate<{ agentAddress: `0x${string}`; agentName: string; validUntil: number; keyState: string; matchCode: string; approveAgent?: unknown }>(
      `signer.createLinkedAgent({ userAddress: ${JSON.stringify(mainWallet.address)}, agentName: "kokoah-ph12", validForDays: 30, storageMode: "device", replaceExisting: true, link: ${JSON.stringify(link)} })`,
    );
    const computerCode = deviceLinkCode({ ...link, userAddress: mainWallet.address, agentAddress: linked.agentAddress, agentName: "kokoah-ph12", validUntil: linked.validUntil });
    check(
      "createLinkedAgent: a new pending key and the same matching code the computer computes",
      linked.keyState === "pending" && linked.agentAddress !== createdA.agentAddress && linked.matchCode === computerCode && linked.approveAgent === undefined,
      { keyState: linked.keyState, same: linked.matchCode === computerCode },
    );
    await approve(buildApproveAgent({ agentAddress: linked.agentAddress, agentName: "kokoah-ph12", validUntil: linked.validUntil, nonce: Date.now(), network: getNetworkConfig("testnet") }));
    const linkedActive = await evaluate<{ keyState: string; agentAddress: string }>("signer.confirmAgent({ timeoutMs: 3000 })");
    const signed3 = await evaluate<{ status: string }>(`signer.signAndSubmit({ requestId: crypto.randomUUID(), intent: ${intent()} })`);
    check("the linked key signs after the computer's approveAgent", linkedActive.keyState === "active" && linkedActive.agentAddress === linked.agentAddress && signed3.status === "ok", { linkedActive, signed3 });
    check("no CSP/SRI/console errors during normal operation (frame A)", problems.length === 0, problems);

    // ---------------------------------------------------------------- frame-ancestors.
    problems.length = 0;
    const { targetId: evilTarget } = (await c.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const { sessionId: evilPage } = (await c.send("Target.attachToTarget", { targetId: evilTarget, flatten: true })) as { sessionId: string };
    await c.send("Runtime.enable", {}, evilPage);
    await c.send("Log.enable", {}, evilPage);
    await c.send("Page.enable", {}, evilPage);
    await c.send("Page.navigate", { url: `${evil.origin}/evil` }, evilPage);
    await new Promise((r) => setTimeout(r, 2_000));
    check("frame-ancestors refuses an unlisted embedding origin", problems.some((p) => /frame-ancestors/.test(p)), problems);
    await c.send("Target.closeTarget", { targetId: evilTarget });

    // ---------------------------------------------------------------- Frame B: the real headers, WebAuthn delegated by the app.
    problems.length = 0;
    await open(`${frameB.origin}/`);
    const helloB = await evaluate<{ capabilities: { passkey: { available: boolean; prf: string }; storageModes: string[] } }>("signer.hello()");
    check("with the real signer headers, passkey is available", helloB.capabilities.passkey.available && helloB.capabilities.storageModes[0] === "passkey", helloB.capabilities.passkey);
    const fb = await waitFrameSession(frameB.origin);
    await evaluate(`window.creating = signer.createAgent({ userAddress: ${JSON.stringify(mainWallet.address)}, validForDays: 30, storageMode: "passkey" }).then((r) => ({ ok: r }), (e) => ({ err: e.code + ": " + e.message })); true`);
    await waitUntil("!signer.iframe.hidden");
    check("promptChanged makes the client show the iframe", true);
    // A real click inside the frame (user activation), then maybe a second one for the PRF assertion.
    await evaluate("document.querySelector('.ks-primary').click(); true", fb, true);
    for (let i = 0; i < 50; i++) {
      const state = await evaluate<{ done: boolean; title: string; busy: boolean }>(
        "({ done: false, title: document.querySelector('.ks-title')?.textContent ?? '', busy: document.querySelector('.ks-primary')?.disabled ?? false, hidden: document.querySelector('.ks-prompt')?.hidden })",
        fb,
      );
      const finished = await evaluate<boolean>("signer.iframe.hidden");
      if (finished) break;
      if (state.title === "Confirm your passkey" && !state.busy) await evaluate("document.querySelector('.ks-primary').click(); true", fb, true);
      await new Promise((r) => setTimeout(r, 100));
    }
    const createdB = await evaluate<{ ok?: { storageMode: string; agentAddress: string; approveAgent: { typedData: unknown } }; err?: string }>("window.creating");
    check("passkey create with a PRF-capable virtual authenticator", createdB.ok?.storageMode === "passkey", createdB);
    if (createdB.ok) {
      await approve(createdB.ok.approveAgent);
      await evaluate("signer.confirmAgent({ timeoutMs: 3000 })");
      const s1 = await evaluate<{ status: string }>(`signer.signAndSubmit({ requestId: crypto.randomUUID(), intent: ${intent()} })`);
      check("signing with the passkey-protected key", s1.status === "ok", s1);
      const locked = await evaluate<{ locked: boolean }>("signer.lock()");
      await evaluate("window.unlocking = signer.unlock().then((r) => ({ ok: r }), (e) => ({ err: e.code + ': ' + e.message })); true");
      await waitUntil("!signer.iframe.hidden");
      await evaluate("document.querySelector('.ks-primary').click(); true", fb, true);
      await waitUntil("signer.iframe.hidden");
      const unlocked = await evaluate<{ ok?: { locked: boolean }; err?: string }>("window.unlocking");
      check("lock, then unlock with a passkey assertion (PRF → HKDF → AES-GCM)", locked.locked && unlocked.ok?.locked === false, unlocked);
      const s2 = await evaluate<{ status: string }>(`signer.signAndSubmit({ requestId: crypto.randomUUID(), intent: ${intent()} })`);
      check("signing after passkey unlock", s2.status === "ok", s2);
      await open(`${frameB.origin}/`);
      await evaluate("signer.hello()");
      const st = await evaluate<{ locked: boolean; storageMode: string; hasKey: boolean }>("signer.getStatus()");
      check("after a reload the passkey key is locked (needs user verification)", st.hasKey && st.locked && st.storageMode === "passkey", st);
    }
    check("no CSP/SRI/console errors during the passkey flow (frame B)", problems.length === 0, problems);
  } catch (e) {
    check("smoke test ran to completion", false, e instanceof Error ? e.message : String(e));
  } finally {
    try {
      await cdp?.send("Browser.close");
    } catch {
      // ignore
    }
    cdp?.close();
    chrome?.kill("SIGKILL");
    for (const s of servers) s.close();
    rmSync(tmp, { recursive: true, force: true });
  }
  for (const n of notes) console.log(`note: ${n}`);
  const failed = checks.filter((x) => !x.ok);
  console.log(`\nsmoke-browser: ${checks.length - failed.length}/${checks.length} checks passed`);
  return failed.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));

/**
 * Browser entry point of the signer frame. Validates the build-time configuration, opens storage, creates the core
 * and wires `message` events. The listener is attached synchronously, before any `await`, and buffers messages until
 * the core is ready, so a parent that sends `hello` right after the iframe's `load` event is never missed.
 *
 * @module
 */
import "./frame.css";
import { FrameConfigError, parseFrameConfig } from "./config.js";
import { FrameCore, type BroadcastLike, type IncomingMessage } from "./core.js";
import { consoleLogger } from "./log.js";
import type { LockManagerLike } from "./nonces.js";
import { WebAuthnPasskeyProvider } from "./passkey.js";
import { openSignerStore } from "./storage.js";

const MAX_BUFFERED = 32;

function showFatal(root: HTMLElement | null, text: string): void {
  if (!root) return;
  const p = document.createElement("p");
  p.className = "ks-fatal";
  p.setAttribute("role", "alert");
  p.textContent = text;
  root.replaceChildren(p);
}

async function start(): Promise<void> {
  const root = document.getElementById("ks-root");
  let core: FrameCore | null = null;
  const buffered: IncomingMessage[] = [];
  window.addEventListener("message", (ev: MessageEvent) => {
    const msg: IncomingMessage = { data: ev.data, origin: ev.origin, source: ev.source };
    if (core) void core.handleMessage(msg);
    else if (buffered.length < MAX_BUFFERED) buffered.push(msg);
  });

  let config;
  try {
    config = parseFrameConfig(import.meta.env, { production: import.meta.env.MODE === "production" });
  } catch (e) {
    consoleLogger("frame.config_invalid", { reason: e instanceof FrameConfigError ? `${e.problems.length} problem(s)` : "error" });
    if (e instanceof FrameConfigError) console.error(e.message);
    showFatal(root, "The Kokoah signer is misconfigured and will not run.");
    return;
  }

  const framed = window.parent !== window;
  const store = await openSignerStore(typeof indexedDB === "undefined" ? undefined : indexedDB);
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
  const broadcast = typeof BroadcastChannel === "function" ? (new BroadcastChannel(`kokoah-signer/v1/${config.network.name}`) as unknown as BroadcastLike) : null;
  core = await FrameCore.create({
    config,
    frameVersion: __KOKOAH_FRAME_VERSION__,
    frameOrigin: location.origin,
    parent: framed ? window.parent : null,
    document,
    uiRoot: root,
    fetch: (input, init) => window.fetch(input, init),
    crypto: window.crypto,
    store,
    locks,
    passkeys: new WebAuthnPasskeyProvider(window),
    broadcast,
    logger: consoleLogger,
  });
  if (!framed) showFatal(root, "This page only works inside the Kokoah app.");
  for (const msg of buffered.splice(0)) void core.handleMessage(msg);
  core.announceReady();
}

void start();

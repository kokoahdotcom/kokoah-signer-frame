#!/usr/bin/env node
/**
 * DEV ONLY (kokoah-dev-harness). Starts the dev harness: two Vite dev servers on two origins, like production.
 *
 * - Harness (parent app stand-in): http://localhost:${DEV_HARNESS_PORT:-47801}, serves dev/ and the mock HL API
 *   under /hl (dev/mock-hl.ts). `/hl/exchange` is never forwarded to Hyperliquid.
 * - Frame: http://localhost:${DEV_FRAME_PORT:-47802}, the signer frame in development mode, configured to accept
 *   only the harness origin and to use the harness's /hl as its HL API.
 *
 * `DEV_HL_MODE=testnet` makes /hl/info a read-only proxy to HL testnet /info (market data only).
 * Ports 0 pick free ports (used by automated smoke runs).
 */
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { createMockHl, type MockMode } from "./mock-hl.ts";

const root = new URL("..", import.meta.url).pathname;
const mode: MockMode = process.env.DEV_HL_MODE === "testnet" ? "testnet" : "mock";
const harnessPort = Number(process.env.DEV_HARNESS_PORT ?? 47801);
const framePort = Number(process.env.DEV_FRAME_PORT ?? 47802);

const mock = createMockHl({ mode });
let frameUrl = "";

const harnessPlugin: Plugin = {
  name: "kokoah-dev-harness-mock-hl",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url === "/_dev/config") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ frameUrl, hlMode: mode }));
        return;
      }
      mock.handle(req, res).then((handled) => {
        if (!handled) next();
      }, next);
    });
  },
};

async function main(): Promise<void> {
  const harness: ViteDevServer = await createServer({
    configFile: false,
    root: `${root}dev`,
    envDir: root,
    mode: "development",
    define: { __KOKOAH_FRAME_VERSION__: JSON.stringify("dev") },
    resolve: { dedupe: ["viem", "valibot"] },
    server: { host: "localhost", port: harnessPort, strictPort: harnessPort !== 0, fs: { allow: [root] } },
    plugins: [harnessPlugin],
    logLevel: "warn",
  });
  await harness.listen();
  const harnessOrigin = `http://localhost:${(harness.httpServer?.address() as { port: number }).port}`;

  // The frame reads these through import.meta.env (process.env overrides .env.development).
  process.env.VITE_ALLOWED_PARENT_ORIGINS = harnessOrigin;
  process.env.VITE_HL_API_URL_OVERRIDE = `${harnessOrigin}/hl`;
  process.env.VITE_HL_NETWORK = "testnet";
  const frame: ViteDevServer = await createServer({
    configFile: `${root}vite.config.ts`,
    root,
    mode: "development",
    server: { host: "localhost", port: framePort, strictPort: framePort !== 0 },
    logLevel: "warn",
  });
  await frame.listen();
  frameUrl = `http://localhost:${(frame.httpServer?.address() as { port: number }).port}/`;

  console.log(`kokoah-dev-harness: harness ${harnessOrigin}/  (HL mode: ${mode}; /exchange is always mocked)`);
  console.log(`kokoah-dev-harness: frame   ${frameUrl}`);
  const stop = async () => {
    await Promise.allSettled([harness.close(), frame.close()]);
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

void main();

/**
 * Production build of the signer frame (static, content-hashed, no inline scripts). `scripts/postbuild.ts` then adds
 * SRI attributes, runs the safety checks and writes the release manifest. The dev harness in `dev/` has its own
 * config and is never part of this build.
 */
import { readFileSync } from "node:fs";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { buildMetaCsp, parseFrameConfig } from "./src/frame/config.ts";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  // Only `vite build` in production mode is a production build (strict origins, no API override).
  const production = command === "build" && mode === "production";
  // Throws (and fails the build) on any invalid value, e.g. mainnet without VITE_ALLOW_MAINNET_WRITES=true.
  const config = parseFrameConfig(env, { production });
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
  const csp = buildMetaCsp(config);

  const cspMeta: Plugin = {
    name: "kokoah-signer-csp-meta",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: csp }, injectTo: "head-prepend" }],
    },
  };

  return {
    appType: "mpa",
    publicDir: "public",
    envPrefix: "VITE_",
    define: { __KOKOAH_FRAME_VERSION__: JSON.stringify(pkg.version) },
    // The linked @kokoah/shared resolves its own copies of these; use one copy (same exact versions).
    resolve: { dedupe: ["viem", "valibot"] },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      target: "es2022",
      // The preload polyfill would add code we don't need; there are no dynamic imports.
      modulePreload: { polyfill: false },
      // Never inline assets as data: URIs (img-src 'self' only).
      assetsInlineLimit: 0,
      cssCodeSplit: false,
      sourcemap: false,
      reportCompressedSize: false,
      rolldownOptions: { input: "index.html" },
    },
    server: {
      host: "localhost",
      port: Number(process.env.DEV_FRAME_PORT ?? 47802),
      strictPort: true,
    },
    plugins: [cspMeta],
  };
});

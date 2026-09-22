import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __KOKOAH_FRAME_VERSION__: JSON.stringify("0.0.0-test") },
  resolve: { dedupe: ["viem", "valibot"] },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "jsdom",
    testTimeout: 30_000,
    // Unit tests never touch the network: fetch is mocked. Read-only testnet tests live in test/integration and are
    // skipped unless HL_INTEGRATION=testnet.
  },
});

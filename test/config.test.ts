import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMetaCsp, FrameConfigError, parseFrameConfig } from "../src/frame/config.js";
import { addSri, checkHeaders, headersCsp, serializeManifest, sri, validateManifest, type ReleaseManifest } from "../scripts/postbuild.js";
import { BUILDER, testConfig } from "./helpers.js";

const base = { VITE_ALLOWED_PARENT_ORIGINS: "https://app.kokoah.example", VITE_BUILDER_ADDRESS: BUILDER, VITE_BUILDER_FEE_TENTHS_BPS: "25" };
const problems = (env: Record<string, string>, production = true): string[] => {
  try {
    parseFrameConfig({ ...base, ...env }, { production });
    return [];
  } catch (e) {
    if (e instanceof FrameConfigError) return [...e.problems];
    throw e;
  }
};

describe("build-time configuration", () => {
  it("defaults to testnet with writes to testnet only", () => {
    const c = parseFrameConfig(base, { production: true });
    expect(c.network.name).toBe("testnet");
    expect(c.network.exchangeUrl).toBe("https://api.hyperliquid-testnet.xyz/exchange");
    expect(c.network.allowMainnetWrites).toBe(false);
    expect(c.defaultAgentName).toBe("kokoah-web");
  });

  it("a mainnet build requires VITE_ALLOW_MAINNET_WRITES=true", () => {
    expect(problems({ VITE_HL_NETWORK: "mainnet" }).join()).toMatch(/requires VITE_ALLOW_MAINNET_WRITES=true/);
    expect(problems({ VITE_HL_NETWORK: "mainnet", VITE_ALLOW_MAINNET_WRITES: "yes" }).join()).toMatch(/must be "true" or "false"/);
    const c = parseFrameConfig({ ...base, VITE_HL_NETWORK: "mainnet", VITE_ALLOW_MAINNET_WRITES: "true" }, { production: true });
    expect(c.network).toMatchObject({ name: "mainnet", allowMainnetWrites: true, exchangeUrl: "https://api.hyperliquid.xyz/exchange" });
    expect(problems({ VITE_HL_NETWORK: "mainet" }).join()).toMatch(/VITE_HL_NETWORK/);
  });

  it("parent origins must be exact https origins (no wildcards, paths or http outside development)", () => {
    expect(problems({ VITE_ALLOWED_PARENT_ORIGINS: "*" })).toHaveLength(1);
    expect(problems({ VITE_ALLOWED_PARENT_ORIGINS: "null" })).toHaveLength(1);
    expect(problems({ VITE_ALLOWED_PARENT_ORIGINS: "https://app.kokoah.example/" })).toHaveLength(1);
    expect(problems({ VITE_ALLOWED_PARENT_ORIGINS: "https://app.kokoah.example/trade" })).toHaveLength(1);
    expect(problems({ VITE_ALLOWED_PARENT_ORIGINS: "http://app.kokoah.example" })).toHaveLength(1);
    expect(problems({ VITE_ALLOWED_PARENT_ORIGINS: "http://localhost:47801" })).toHaveLength(1);
    expect(problems({ VITE_ALLOWED_PARENT_ORIGINS: "http://localhost:47801" }, false)).toHaveLength(0);
    expect(problems({ VITE_ALLOWED_PARENT_ORIGINS: "" }).join()).toMatch(/required/);
    expect(parseFrameConfig({ ...base, VITE_ALLOWED_PARENT_ORIGINS: " https://a.example , https://b.example " }, { production: true }).allowedParentOrigins).toEqual(["https://a.example", "https://b.example"]);
  });

  it("validates the builder and refuses the API override in production", () => {
    expect(problems({ VITE_BUILDER_ADDRESS: "0x123" })).toHaveLength(1);
    expect(problems({ VITE_BUILDER_ADDRESS: `0x${"0".repeat(40)}` })).toHaveLength(1);
    expect(problems({ VITE_BUILDER_FEE_TENTHS_BPS: "101" })).toHaveLength(1);
    expect(problems({ VITE_BUILDER_FEE_TENTHS_BPS: "2.5" })).toHaveLength(1);
    expect(problems({ VITE_HL_API_URL_OVERRIDE: "http://localhost:47801/hl" }).join()).toMatch(/only allowed in development/);
    expect(problems({ VITE_HL_API_URL_OVERRIDE: "http://evil.example/hl" }, false)).toHaveLength(1);
    const dev = parseFrameConfig({ ...base, VITE_HL_API_URL_OVERRIDE: "http://localhost:47801/hl/" }, { production: false });
    expect(dev.network.infoUrl).toBe("http://localhost:47801/hl/info");
    expect(parseFrameConfig({ ...base, VITE_BUILDER_ADDRESS: BUILDER.toUpperCase().replace("0X", "0x") }, { production: true }).builder.address).toBe(BUILDER);
  });
});

describe("CSP consistency with kokoah-infra/headers", () => {
  const headers = readFileSync(join(process.cwd(), "public", "_headers"), "utf8");
  const header = headersCsp(headers);

  it("public/_headers is the infra signer policy", () => {
    expect(header?.get("script-src")).toEqual(["'self'"]);
    expect(header?.get("style-src")).toEqual(["'self'"]);
    expect(header?.get("frame-ancestors")).toEqual(["https://app.kokoah.example"]);
    expect(header?.get("trusted-types")).toEqual(["'none'"]);
  });

  it("the meta CSP is never looser than the header CSP (each directive a subset)", () => {
    for (const network of ["testnet", "mainnet"] as const) {
      const cfg = testConfig(network === "mainnet" ? { VITE_HL_NETWORK: "mainnet", VITE_ALLOW_MAINNET_WRITES: "true" } : {});
      const meta = new Map(buildMetaCsp(cfg).split("; ").map((d) => { const [k, ...v] = d.split(" "); return [k as string, v]; }));
      expect(meta.has("frame-ancestors")).toBe(false); // ignored in <meta>; enforced by the header
      for (const [directive, values] of meta) {
        const allowed = header?.get(directive);
        expect(allowed, directive).toBeDefined();
        for (const v of values) expect(allowed, `${directive} ${v}`).toContain(v);
      }
      expect(meta.get("connect-src")).toEqual([network === "mainnet" ? "https://api.hyperliquid.xyz" : "https://api.hyperliquid-testnet.xyz"]);
    }
  });

  it("checkHeaders catches a frame-ancestors / allowlist mismatch", () => {
    expect(checkHeaders(headers, parseFrameConfig(base, { production: true }))).toEqual([]);
    const other = parseFrameConfig({ ...base, VITE_ALLOWED_PARENT_ORIGINS: "https://staging.kokoah.example" }, { production: true });
    expect(checkHeaders(headers, other).join()).toMatch(/does not allow https:\/\/staging/);
  });
});

describe("post-build SRI and release manifest", () => {
  const js = new TextEncoder().encode("console.log(1)");
  const css = new TextEncoder().encode("body{}");
  const read = (p: string) => (p === "/assets/a.js" ? js : p === "/assets/a.css" ? css : undefined);

  it("adds integrity to scripts and stylesheets", () => {
    const r = addSri('<head><script type="module" crossorigin src="/assets/a.js"></script><link rel="stylesheet" href="/assets/a.css"></head>', read);
    expect(r.problems).toEqual([]);
    expect(r.html).toContain(`src="/assets/a.js" integrity="${sri(js)}"`);
    expect(r.html).toContain(`href="/assets/a.css" integrity="${sri(css)}"`);
  });

  it("fails on inline scripts, inline styles, third-party or missing resources", () => {
    expect(addSri("<script>alert(1)</script>", read).problems.join()).toMatch(/inline <script>/);
    expect(addSri("<style>body{}</style>", read).problems.join()).toMatch(/inline <style>/);
    expect(addSri('<p style="color:red">x</p>', read).problems.join()).toMatch(/style= attribute/);
    expect(addSri('<script src="https://cdn.example/x.js"></script>', read).problems.join()).toMatch(/another origin/);
    expect(addSri('<script src="//cdn.example/x.js"></script>', read).problems.join()).toMatch(/another origin/);
    expect(addSri('<script src="/assets/missing.js"></script>', read).problems.join()).toMatch(/not in the build output/);
    expect(addSri('<script src="/assets/a.js" integrity="sha384-AAAA"></script>', read).problems.join()).toMatch(/does not match/);
  });

  it("writes a valid kokoah.release-manifest/v1", () => {
    const m: ReleaseManifest = {
      schema: "kokoah.release-manifest/v1",
      site: "https://signer.kokoah.example",
      version: "v0.1.0",
      gitCommit: "0123456789abcdef0123456789abcdef01234567",
      builtAt: "2026-09-22T00:00:00.000Z",
      entrypoint: "/index.html",
      files: { "/z.js": sri(js), "/index.html": sri(css) },
      inlineScripts: [],
    };
    expect(validateManifest(m)).toEqual([]);
    const text = serializeManifest(m);
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text).files)).toEqual(["/index.html", "/z.js"]);
    expect(validateManifest({ ...m, site: "https://signer.kokoah.example/" }).length).toBeGreaterThan(0);
    expect(validateManifest({ ...m, entrypoint: "/nope.html" }).length).toBeGreaterThan(0);
  });
});

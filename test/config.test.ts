import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMetaCsp, FrameConfigError, parseFrameConfig } from "../src/frame/config.js";
import { addSri, checkHeaders, headersCsp, headersDrift, linkedSharedCommit, parsePermissionsPolicy, serializeManifest, sri, validateManifest, type ReleaseManifest } from "../scripts/postbuild.js";
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

  it("reads an optional builder-fee promotion", () => {
    expect(parseFrameConfig(base, { production: true }).builder.promo).toBeNull();
    const promo = (env: Record<string, string>) => parseFrameConfig({ ...base, ...env }, { production: true }).builder.promo;
    expect(promo({ VITE_BUILDER_FEE_PROMO_UNTIL: "2026-12-01T00:00:00Z" })).toEqual({ feeTenthsBps: 0, until: Date.UTC(2026, 11, 1) });
    expect(promo({ VITE_BUILDER_FEE_PROMO_UNTIL: "2026-12-01T00:00:00Z", VITE_BUILDER_FEE_PROMO_TENTHS_BPS: "10" })).toEqual({ feeTenthsBps: 10, until: Date.UTC(2026, 11, 1) });
    expect(problems({ VITE_BUILDER_FEE_PROMO_UNTIL: "December 1" })).toHaveLength(1);
    expect(problems({ VITE_BUILDER_FEE_PROMO_UNTIL: "2026-12-01T00:00:00Z", VITE_BUILDER_FEE_PROMO_TENTHS_BPS: "30" }).join()).toMatch(/must not exceed/);
    expect(problems({ VITE_BUILDER_FEE_PROMO_TENTHS_BPS: "0" }).join()).toMatch(/needs VITE_BUILDER_FEE_PROMO_UNTIL/);
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

  it("public/_headers allows WebAuthn on the signer origin (passkeys), and checkHeaders fails when it doesn't", () => {
    const pp = /^\s+Permissions-Policy:\s*(.+)$/m.exec(headers)?.[1] ?? "";
    const features = parsePermissionsPolicy(pp);
    expect(features.get("publickey-credentials-create")).toEqual(["self"]);
    expect(features.get("publickey-credentials-get")).toEqual(["self"]);
    expect(features.get("camera")).toEqual([]);
    const disabled = headers.replace("publickey-credentials-create=(self)", "publickey-credentials-create=()").replace("publickey-credentials-get=(self)", "publickey-credentials-get=()");
    expect(disabled).not.toBe(headers);
    const p = checkHeaders(disabled, parseFrameConfig(base, { production: true }));
    expect(p).toHaveLength(2);
    expect(p.join()).toMatch(/publickey-credentials-create=\(self\)/);
    expect(p.join()).toMatch(/publickey-credentials-get=\(self\)/);
  });

  const infraPath = join(process.cwd(), "..", "kokoah-infra", "headers", "cloudflare", "signer", "_headers");
  it.skipIf(!existsSync(infraPath))("public/_headers matches kokoah-infra's signer _headers", () => {
    const infra = readFileSync(infraPath, "utf8");
    expect(headersDrift(headers, infra)).toEqual([]);
    expect(headers).toBe(infra);
  });

  it("headersDrift fails on any difference that matters and ignores deployment-specific origins and comments", () => {
    expect(headersDrift(headers, headers)).toEqual([]);
    // A staging copy: other app origin and report endpoint, other comments.
    const staging = headers
      .replace("frame-ancestors https://app.kokoah.example", "frame-ancestors https://staging.kokoah.example")
      .replaceAll("https://api.kokoah.example/v1/csp-reports", "https://api.staging.kokoah.example/v1/csp-reports")
      .replace(/^# .*$/m, "# staging copy");
    expect(staging).not.toBe(headers);
    expect(headersDrift(staging, headers)).toEqual([]);
    // WebAuthn disabled again (the 0.1.0 frame copy): must fail.
    const noPasskeys = headers.replace("publickey-credentials-get=(self)", "publickey-credentials-get=()");
    expect(headersDrift(noPasskeys, headers).join()).toMatch(/permissions-policy differs/);
    // A loosened CSP directive, a dropped header, an extra header, an extra rule.
    expect(headersDrift(headers.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"), headers).join()).toMatch(/CSP script-src differs/);
    expect(headersDrift(headers.replace(/^\s+X-Content-Type-Options: nosniff\n/m, ""), headers).join()).toMatch(/x-content-type-options is missing/);
    expect(headersDrift(headers.replace("  X-XSS-Protection: 0", "  X-XSS-Protection: 0\n  X-Extra: 1"), headers).join()).toMatch(/x-extra is not set by kokoah-infra/);
    expect(headersDrift(`${headers}\n/other\n  X-Frame-Options: DENY\n`, headers).join()).toMatch(/rule \/other is not in/);
  });

  it("headersDrift lets this deployment's API origin stand for kokoah-infra's placeholder in connect-src, and nothing else", () => {
    const live = headers.replaceAll("https://api.kokoah.example", "https://api.kokoah.com");
    expect(headersDrift(live, headers, "https://api.kokoah.com")).toEqual([]);
    expect(headersDrift(live, headers).join()).toMatch(/CSP connect-src differs/);
    expect(headersDrift(live, headers, "https://api.other.example").join()).toMatch(/CSP connect-src differs/);
    const extra = headers.replace("connect-src https://api.hyperliquid.xyz", "connect-src https://evil.example https://api.hyperliquid.xyz");
    expect(headersDrift(extra, headers, "https://evil.example").join()).toMatch(/CSP connect-src differs/);
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
    expect(JSON.parse(text)).not.toHaveProperty("sharedCommit");
  });

  it("records the kokoah-shared commit the build linked", () => {
    const shared = "89abcdef0123456789abcdef0123456789abcdef";
    const m: ReleaseManifest = {
      schema: "kokoah.release-manifest/v1",
      site: "https://signer.kokoah.example",
      version: "v0.1.0",
      gitCommit: "0123456789abcdef0123456789abcdef01234567",
      sharedCommit: shared,
      builtAt: "2026-09-22T00:00:00.000Z",
      entrypoint: "/index.html",
      files: { "/index.html": sri(css) },
      inlineScripts: [],
    };
    expect(validateManifest(m)).toEqual([]);
    expect(Object.keys(JSON.parse(serializeManifest(m)))).toEqual(["schema", "site", "version", "gitCommit", "sharedCommit", "builtAt", "entrypoint", "files", "inlineScripts"]);
    expect(validateManifest({ ...m, sharedCommit: "main" })).toEqual(["sharedCommit must be 40 lowercase hex"]);
    // kokoah-infra's build passes it (its copy of kokoah-shared has no git history); otherwise the linked checkout's HEAD.
    const root = process.cwd();
    expect(linkedSharedCommit(root, { COMMIT_SHARED: shared.toUpperCase() })).toEqual({ sha: shared, dirty: false });
    const local = linkedSharedCommit(root, {});
    if (local) expect(local.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

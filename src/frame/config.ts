/**
 * Build-time configuration of the signer frame.
 *
 * Every value comes from a `VITE_*` variable, is baked into the bundle at build time, and is validated twice: by
 * `vite.config.ts` (the build fails on a bad value) and again by the frame at startup (it refuses to run).
 * `VITE_*` values are public: never put a secret in them.
 *
 * This module must stay self-contained (no relative imports): `vite.config.ts` and the Node post-build script import
 * it directly.
 *
 * @module
 */
import { getNetworkConfig, type NetworkConfig } from "@kokoah/shared/network";

/** Raw environment (e.g. `import.meta.env` or Vite's `loadEnv`). */
export type RawEnv = Readonly<Record<string, string | boolean | undefined>>;

/** Validated configuration. */
export interface FrameConfig {
  /** Hyperliquid network, from `@kokoah/shared` `getNetworkConfig` (testnet unless explicitly mainnet). */
  readonly network: NetworkConfig;
  /** Exact parent origins allowed to talk to the frame (and to embed it: keep `frame-ancestors` in sync). */
  readonly allowedParentOrigins: readonly string[];
  /** Builder code attached to every order. */
  readonly builder: { readonly address: `0x${string}`; readonly feeTenthsBps: number };
  /** Default agent name for `createAgent`. */
  readonly defaultAgentName: string;
  /**
   * Kokoah's own Hyperliquid referral code, or null. It is the only code `setReferrer` may carry; the parent never
   * supplies it. Null: `setReferrer` stays denied.
   */
  readonly referralCode: string | null;
  /** Development only: base URL that replaces the HL API (the dev harness mock/read-only proxy). */
  readonly hlApiUrlOverride: string | null;
  /** True for production builds (stricter origin rules, no overrides). */
  readonly production: boolean;
}

/** Thrown with every problem found. */
export class FrameConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Invalid signer frame configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "FrameConfigError";
    this.problems = problems;
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const AGENT_NAME_RE = /^[A-Za-z0-9._-]{1,16}$/;
const REFERRAL_CODE_RE = /^[A-Za-z0-9_-]{1,20}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function str(env: RawEnv, key: string): string | undefined {
  const v = env[key];
  if (v === undefined || v === false) return undefined;
  if (v === true) return "true";
  const t = v.trim();
  return t === "" ? undefined : t;
}

/**
 * Parses and validates the frame configuration.
 *
 * Variables:
 * - `VITE_HL_NETWORK`: `testnet` (default when unset) or `mainnet`. Anything else is an error.
 * - `VITE_ALLOW_MAINNET_WRITES`: must be exactly `true` for a mainnet build; `false`/unset otherwise.
 * - `VITE_ALLOWED_PARENT_ORIGINS`: comma-separated exact origins (required). HTTPS only in production builds;
 *   `http://localhost`/`127.0.0.1` are accepted in development builds.
 * - `VITE_BUILDER_ADDRESS`: the Kokoah builder address (required).
 * - `VITE_BUILDER_FEE_TENTHS_BPS`: builder fee in tenths of a basis point, integer 0–100 (required).
 * - `VITE_AGENT_NAME`: default agent name (default `kokoah-web`), 1–16 of `A–Z a–z 0–9 . _ -`.
 * - `VITE_HL_REFERRAL_CODE`: optional, Kokoah's Hyperliquid referral code (1–20 of `A–Z a–z 0–9 _ -`); keep it equal
 *   to the backend's `HL_REFERRAL_CODE`. Unset: the frame never signs `setReferrer`.
 * - `VITE_HL_API_URL_OVERRIDE`: development builds only (dev harness proxy). Rejected in production builds.
 */
export function parseFrameConfig(env: RawEnv, options: { production: boolean }): FrameConfig {
  const problems: string[] = [];
  const production = options.production;

  // Network.
  const netRaw = str(env, "VITE_HL_NETWORK")?.toLowerCase() ?? "testnet";
  if (netRaw !== "testnet" && netRaw !== "mainnet") problems.push(`VITE_HL_NETWORK must be "testnet" or "mainnet" (got "${netRaw}")`);
  const writesRaw = str(env, "VITE_ALLOW_MAINNET_WRITES")?.toLowerCase() ?? "false";
  if (writesRaw !== "true" && writesRaw !== "false") problems.push(`VITE_ALLOW_MAINNET_WRITES must be "true" or "false" (got "${writesRaw}")`);
  const isMainnet = netRaw === "mainnet";
  if (isMainnet && writesRaw !== "true") {
    problems.push("A mainnet build requires VITE_ALLOW_MAINNET_WRITES=true (explicit opt-in to signing and submitting mainnet actions)");
  }

  // API override (development only).
  let hlApiUrlOverride: string | null = null;
  const overrideRaw = str(env, "VITE_HL_API_URL_OVERRIDE");
  if (overrideRaw !== undefined) {
    if (production) problems.push("VITE_HL_API_URL_OVERRIDE is only allowed in development builds");
    else {
      try {
        const u = new URL(overrideRaw);
        if (u.protocol !== "http:" && u.protocol !== "https:") problems.push("VITE_HL_API_URL_OVERRIDE must be an http(s) URL");
        else if (u.protocol === "http:" && !LOOPBACK_HOSTS.has(u.hostname)) problems.push("VITE_HL_API_URL_OVERRIDE over http must point at localhost");
        else if (u.search !== "" || u.hash !== "") problems.push("VITE_HL_API_URL_OVERRIDE must not have a query or fragment");
        else hlApiUrlOverride = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
      } catch {
        problems.push("VITE_HL_API_URL_OVERRIDE is not a valid URL");
      }
    }
  }

  // Parent origins.
  const originsRaw = str(env, "VITE_ALLOWED_PARENT_ORIGINS");
  const allowedParentOrigins: string[] = [];
  if (originsRaw === undefined) problems.push("VITE_ALLOWED_PARENT_ORIGINS is required (comma-separated exact origins)");
  else {
    for (const part of originsRaw.split(",").map((s) => s.trim()).filter((s) => s !== "")) {
      const problem = originProblem(part, production);
      if (problem) problems.push(`VITE_ALLOWED_PARENT_ORIGINS: ${problem}`);
      else if (!allowedParentOrigins.includes(part)) allowedParentOrigins.push(part);
    }
    if (allowedParentOrigins.length === 0 && !problems.some((p) => p.startsWith("VITE_ALLOWED_PARENT_ORIGINS"))) {
      problems.push("VITE_ALLOWED_PARENT_ORIGINS lists no origin");
    }
    if (allowedParentOrigins.length > 8) problems.push("VITE_ALLOWED_PARENT_ORIGINS lists more than 8 origins");
  }

  // Builder.
  const builderRaw = str(env, "VITE_BUILDER_ADDRESS");
  let builderAddress: `0x${string}` = "0x0000000000000000000000000000000000000000";
  if (builderRaw === undefined) problems.push("VITE_BUILDER_ADDRESS is required");
  else if (!ADDRESS_RE.test(builderRaw)) problems.push("VITE_BUILDER_ADDRESS must be a 0x-prefixed 20-byte hex address");
  else if (/^0x0{40}$/i.test(builderRaw)) problems.push("VITE_BUILDER_ADDRESS must not be the zero address");
  else builderAddress = builderRaw.toLowerCase() as `0x${string}`;
  const feeRaw = str(env, "VITE_BUILDER_FEE_TENTHS_BPS");
  let feeTenthsBps = 0;
  if (feeRaw === undefined) problems.push("VITE_BUILDER_FEE_TENTHS_BPS is required (tenths of a basis point, e.g. 25 = 0.025%)");
  else if (!/^\d{1,3}$/.test(feeRaw) || Number(feeRaw) > 100) problems.push("VITE_BUILDER_FEE_TENTHS_BPS must be an integer between 0 and 100 (the perps cap, 0.1%)");
  else feeTenthsBps = Number(feeRaw);

  // Agent name.
  const nameRaw = str(env, "VITE_AGENT_NAME") ?? "kokoah-web";
  if (!AGENT_NAME_RE.test(nameRaw) || /valid_until/.test(nameRaw)) problems.push("VITE_AGENT_NAME must be 1-16 of A-Z a-z 0-9 . _ - (no \"valid_until\")");

  // Referral code (optional).
  const referralRaw = str(env, "VITE_HL_REFERRAL_CODE");
  if (referralRaw !== undefined && !REFERRAL_CODE_RE.test(referralRaw)) problems.push("VITE_HL_REFERRAL_CODE must be 1-20 of A-Z a-z 0-9 _ -");

  if (problems.length > 0) throw new FrameConfigError(problems);

  const network = getNetworkConfig(isMainnet ? "mainnet" : "testnet", {
    allowMainnetWrites: isMainnet && writesRaw === "true",
    ...(hlApiUrlOverride !== null ? { apiUrl: hlApiUrlOverride } : {}),
  });
  return Object.freeze({
    network,
    allowedParentOrigins: Object.freeze([...allowedParentOrigins]),
    builder: Object.freeze({ address: builderAddress, feeTenthsBps }),
    defaultAgentName: nameRaw,
    referralCode: referralRaw ?? null,
    hlApiUrlOverride,
    production,
  });
}

function originProblem(value: string, production: boolean): string | null {
  if (value === "*" || value === "null") return `"${value}" is not allowed; list exact origins`;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return `"${value}" is not a valid origin`;
  }
  if (u.origin !== value) return `"${value}" must be an exact origin like https://app.kokoah.example (no path, no trailing slash)`;
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) {
    return production ? `"${value}": plain http origins are only allowed in development builds` : null;
  }
  return `"${value}" must use https`;
}

/** Origin the frame talks to for `/info` and `/exchange` (the only `connect-src` entry it needs). */
export function hlApiOrigin(config: FrameConfig): string {
  return new URL(config.network.apiUrl).origin;
}

/**
 * The Content-Security-Policy the frame's HTML carries in a `<meta>` tag. It is the infra header policy
 * (kokoah-infra/headers/cloudflare/signer/_headers) minus the directives a meta tag cannot carry (`frame-ancestors`,
 * `report-to`, `report-uri`), with `connect-src` narrowed to this build's network. Browsers enforce both the header
 * and the meta policy, so the effective policy is their intersection.
 */
export function buildMetaCsp(config: FrameConfig): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    `connect-src ${hlApiOrigin(config)}`,
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join("; ");
}

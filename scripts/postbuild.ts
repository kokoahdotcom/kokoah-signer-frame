#!/usr/bin/env node
/**
 * Post-build step of the signer frame (run by `pnpm build:frame` after `vite build`):
 *
 * 1. Adds a SHA-384 `integrity` attribute to every `<script src>`, stylesheet and module preload in `dist/index.html`.
 * 2. Checks the build and fails on any problem:
 *    - no inline scripts, no inline styles, no `style=` attributes, no third-party resources;
 *    - the CSP `<meta>` is the first element of `<head>` and equals `buildMetaCsp(config)`;
 *    - `dist/_headers` (copied from public/) sets `frame-ancestors` to exactly the allowed parent origins, and its
 *      `connect-src` covers the HL API origin; it is compared with kokoah-infra's copy when that repo is next to this one;
 *    - no `eval(`/`new Function(` in the JavaScript, no source maps, nothing from the dev harness;
 *    - a mainnet build never uses the placeholder builder address.
 * 3. Writes `release-manifest.json` (kokoah.release-manifest/v1, kokoah-infra/docs/RELEASE_MANIFEST.md) next to
 *    `dist/`: SHA-384 of every deployed file, excluding Cloudflare config files.
 *
 * Usage: node scripts/postbuild.ts [--mode production] [--dist dist] [--out release-manifest.json]
 * Env: SIGNER_SITE_ORIGIN, RELEASE, GIT_COMMIT (or GITHUB_SHA), SOURCE_DATE_EPOCH.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadEnv } from "vite";
import { buildMetaCsp, hlApiOrigin, parseFrameConfig, type FrameConfig } from "../src/frame/config.ts";

export const MANIFEST_SCHEMA = "kokoah.release-manifest/v1";
const EXCLUDED = new Set(["_headers", "_redirects", "_routes.json"]);
const PLACEHOLDER_BUILDER = "0x0000000000000000000000000000000000000001";
export const HARNESS_MARKER = "kokoah-dev-harness";

export interface ReleaseManifest {
  schema: typeof MANIFEST_SCHEMA;
  site: string;
  version: string;
  gitCommit: string;
  builtAt: string;
  entrypoint: string;
  files: Record<string, string>;
  inlineScripts: string[];
}

export function sri(bytes: Uint8Array): string {
  return `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", "#39": "'", "#34": '"' };

function attrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = (m[1] ?? "").toLowerCase();
    const raw = m[2] ?? m[3] ?? m[4] ?? "";
    if (name !== "" && !(name in out)) out[name] = raw.replace(/&(amp|quot|apos|lt|gt|#39|#34);/g, (e, k: string) => ENTITIES[k] ?? e);
  }
  return out;
}

/** Adds integrity attributes; returns the new HTML and the problems found. */
export function addSri(html: string, readAsset: (urlPath: string) => Uint8Array | undefined): { html: string; problems: string[] } {
  const problems: string[] = [];
  const doc = html.replace(/<!--[\s\S]*?-->/g, "");
  if (/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(doc)) problems.push("index.html has an inline <script> (the CSP allows none)");
  if (/<style\b/i.test(doc)) problems.push("index.html has an inline <style> (style-src 'self' only)");
  if (/\sstyle\s*=/i.test(doc)) problems.push("index.html has a style= attribute (style-src 'self' only)");
  const out = html.replace(/<(script|link)\b([^>]*)>/gi, (tag, name: string, rest: string) => {
    const a = attrs(rest);
    const isScript = name.toLowerCase() === "script";
    const rel = (a.rel ?? "").toLowerCase().split(/\s+/);
    const ref = isScript ? a.src : rel.includes("stylesheet") || rel.includes("modulepreload") || (rel.includes("preload") && (a.as === "script" || a.as === "style")) ? a.href : undefined;
    if (ref === undefined) return tag;
    if (!ref.startsWith("/") || ref.startsWith("//")) {
      problems.push(`${tag}: loads from another origin or a relative URL; only same-origin absolute paths are allowed`);
      return tag;
    }
    const bytes = readAsset(decodeURIComponent(ref.split(/[?#]/)[0] ?? ref));
    if (!bytes) {
      problems.push(`${tag}: ${ref} is not in the build output`);
      return tag;
    }
    const token = sri(bytes);
    if (a.integrity !== undefined) {
      if (a.integrity !== token) problems.push(`${tag}: integrity attribute does not match the file`);
      return tag;
    }
    return tag.replace(/\s*\/?>$/, (end) => ` integrity="${token}"${end.includes("/") ? " />" : ">"}`);
  });
  return { html: out, problems };
}

/** Parses the CSP of the `/*` rule of a Cloudflare `_headers` file. */
export function headersCsp(headers: string): Map<string, string[]> | null {
  let inRoot = false;
  for (const line of headers.split(/\r?\n/)) {
    if (/^\S/.test(line) && !line.startsWith("#")) inRoot = line.trim() === "/*";
    const m = /^\s+Content-Security-Policy:\s*(.+)$/i.exec(line);
    if (inRoot && m?.[1]) {
      const map = new Map<string, string[]>();
      for (const d of m[1].split(";")) {
        const [k, ...v] = d.trim().split(/\s+/);
        if (k) map.set(k.toLowerCase(), v);
      }
      return map;
    }
  }
  return null;
}

export function checkHeaders(headers: string, config: FrameConfig): string[] {
  const problems: string[] = [];
  const csp = headersCsp(headers);
  if (!csp) return ["_headers has no Content-Security-Policy for /*"];
  const ancestors = csp.get("frame-ancestors") ?? [];
  for (const o of config.allowedParentOrigins) {
    if (!ancestors.includes(o)) problems.push(`_headers frame-ancestors does not allow ${o} (VITE_ALLOWED_PARENT_ORIGINS); the app could not embed the frame`);
  }
  for (const a of ancestors) {
    if (!config.allowedParentOrigins.includes(a)) problems.push(`_headers frame-ancestors allows ${a}, which is not in VITE_ALLOWED_PARENT_ORIGINS`);
  }
  if (!(csp.get("connect-src") ?? []).includes(hlApiOrigin(config))) problems.push(`_headers connect-src does not include ${hlApiOrigin(config)}`);
  if ((csp.get("script-src") ?? []).join(" ") !== "'self'") problems.push("_headers script-src must be exactly 'self'");
  return problems;
}

export function validateManifest(m: ReleaseManifest): string[] {
  const p: string[] = [];
  if (m.schema !== MANIFEST_SCHEMA) p.push("schema");
  try {
    if (new URL(m.site).origin !== m.site) p.push("site must be an origin");
  } catch {
    p.push("site must be a URL origin");
  }
  if (m.version === "") p.push("version must not be empty");
  if (!/^[0-9a-f]{40}$/.test(m.gitCommit)) p.push("gitCommit must be 40 lowercase hex");
  if (Number.isNaN(Date.parse(m.builtAt))) p.push("builtAt must be ISO 8601");
  if (Object.keys(m.files).length === 0) p.push("files must not be empty");
  for (const [k, v] of Object.entries(m.files)) {
    if (!k.startsWith("/") || k.includes("\\") || k.split("/").includes("..")) p.push(`bad files key ${k}`);
    if (!/^sha384-[A-Za-z0-9+/]+={0,2}$/.test(v)) p.push(`bad hash for ${k}`);
  }
  if (!(m.entrypoint in m.files)) p.push("entrypoint not in files");
  return p;
}

/** Same serialization as kokoah-infra's generator: sorted keys, two-space indent, trailing newline. */
export function serializeManifest(m: ReleaseManifest): string {
  const files: Record<string, string> = {};
  for (const k of Object.keys(m.files).sort()) files[k] = m.files[k] as string;
  return `${JSON.stringify({ schema: m.schema, site: m.site, version: m.version, gitCommit: m.gitCommit, builtAt: m.builtAt, entrypoint: m.entrypoint, files, inlineScripts: [...m.inlineScripts].sort() }, null, 2)}\n`;
}

function gitCommit(root: string): { sha: string; real: boolean } {
  const env = process.env.GIT_COMMIT ?? process.env.GITHUB_SHA;
  if (env && /^[0-9a-fA-F]{40}$/.test(env)) return { sha: env.toLowerCase(), real: true };
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return { sha, real: true };
  } catch {
    // No commit yet.
  }
  return { sha: "0".repeat(40), real: false };
}

function main(): number {
  const { values } = parseArgs({ options: { mode: { type: "string", default: "production" }, dist: { type: "string", default: "dist" }, out: { type: "string", default: "release-manifest.json" } } });
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const mode = values.mode ?? "production";
  const dist = resolve(root, values.dist ?? "dist");
  const config = parseFrameConfig(loadEnv(mode, root, "VITE_"), { production: mode === "production" });
  const problems: string[] = [];
  const warnings: string[] = [];

  if (config.builder.address === PLACEHOLDER_BUILDER) {
    if (config.network.name === "mainnet") problems.push("mainnet build with the placeholder VITE_BUILDER_ADDRESS");
    else warnings.push("VITE_BUILDER_ADDRESS is the placeholder from .env.production; set the real builder for deploys");
  }

  // 1. SRI + HTML checks.
  const indexPath = join(dist, "index.html");
  const html = readFileSync(indexPath, "utf8");
  const sriResult = addSri(html, (urlPath) => {
    const p = join(dist, ...urlPath.split("/").filter((s) => s !== ""));
    return p.startsWith(dist + sep) && existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined;
  });
  problems.push(...sriResult.problems);
  const expectedCsp = buildMetaCsp(config);
  const head = /<head[^>]*>\s*([\s\S]*?)<\/head>/i.exec(sriResult.html)?.[1] ?? "";
  const first = /^<meta\b([^>]*)>/i.exec(head.trim());
  const firstAttrs = first ? attrs(first[1] ?? "") : {};
  if (firstAttrs["http-equiv"]?.toLowerCase() !== "content-security-policy") problems.push("the CSP <meta> must be the first element of <head>");
  else if (firstAttrs.content !== expectedCsp) problems.push("the CSP <meta> differs from buildMetaCsp(config)");
  if (/<script\b[^>]*\bsrc=/i.test(sriResult.html) && !/integrity="sha384-/.test(sriResult.html)) problems.push("scripts without integrity");

  // 2. Files.
  const files = walk(dist);
  for (const f of files) {
    const rel = relative(dist, f).split(sep).join("/");
    if (rel.endsWith(".map")) problems.push(`source map in the build output: ${rel}`);
    if (rel.startsWith("dev/") || /harness/i.test(rel)) problems.push(`dev harness file in the build output: ${rel}`);
    if (/\.(js|mjs|css|html)$/.test(rel)) {
      const text = readFileSync(f, "utf8");
      if (text.includes(HARNESS_MARKER)) problems.push(`dev harness code in ${rel}`);
      if (/\.m?js$/.test(rel)) {
        if (/(^|[^.\w$])eval\s*\(/.test(text)) problems.push(`eval( in ${rel}`);
        if (/new\s+Function\s*\(/.test(text)) problems.push(`new Function( in ${rel}`);
        if (/\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/.test(text)) warnings.push(`${rel} references an HTML sink (blocked at runtime by trusted-types 'none')`);
      }
    }
  }
  const headersPath = join(dist, "_headers");
  if (!existsSync(headersPath)) problems.push("dist/_headers is missing (copy kokoah-infra/headers/cloudflare/signer/_headers to public/_headers)");
  else {
    const headers = readFileSync(headersPath, "utf8");
    problems.push(...checkHeaders(headers, config));
    const infraCopy = resolve(root, "../kokoah-infra/headers/cloudflare/signer/_headers");
    if (existsSync(infraCopy) && readFileSync(infraCopy, "utf8") !== headers) warnings.push("public/_headers differs from kokoah-infra/headers/cloudflare/signer/_headers");
  }

  if (problems.length > 0) {
    process.stderr.write(`postbuild: ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
    return 1;
  }
  writeFileSync(indexPath, sriResult.html);

  // 3. Release manifest.
  const manifestFiles: Record<string, string> = {};
  for (const f of walk(dist)) {
    const rel = relative(dist, f).split(sep).join("/");
    const base = rel.split("/").at(-1) ?? rel;
    if (EXCLUDED.has(base) || statSync(f).isSymbolicLink()) continue;
    manifestFiles[`/${rel}`] = sri(new Uint8Array(readFileSync(f)));
  }
  const commit = gitCommit(root);
  if (!commit.real) warnings.push("no git commit (repo has no commits): gitCommit is all zeros; CI sets GITHUB_SHA");
  const epoch = process.env.SOURCE_DATE_EPOCH;
  const site = process.env.SIGNER_SITE_ORIGIN ?? "https://signer.kokoah.example";
  const manifest: ReleaseManifest = {
    schema: MANIFEST_SCHEMA,
    site,
    version: process.env.RELEASE ?? commit.sha,
    gitCommit: commit.sha,
    builtAt: epoch !== undefined && /^\d+$/.test(epoch) ? new Date(Number(epoch) * 1000).toISOString() : new Date().toISOString(),
    entrypoint: "/index.html",
    files: manifestFiles,
    inlineScripts: [],
  };
  const manifestProblems = validateManifest(manifest);
  if (manifestProblems.length > 0) {
    process.stderr.write(`postbuild: invalid manifest: ${manifestProblems.join("; ")}\n`);
    return 1;
  }
  const out = resolve(root, values.out ?? "release-manifest.json");
  writeFileSync(out, serializeManifest(manifest));
  for (const w of warnings) process.stdout.write(`postbuild: warning: ${w}\n`);
  process.stdout.write(
    `postbuild: ok — network ${config.network.name}, ${Object.keys(manifestFiles).length} files, SRI on every script/style, CSP meta checked; wrote ${relative(root, out)}\n`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());

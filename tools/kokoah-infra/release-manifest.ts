#!/usr/bin/env node
// release-manifest: hash a static build directory into a release manifest
// (docs/RELEASE_MANIFEST.md) and enforce SRI on the entrypoint HTML.
// Reads the build directory; writes only the --out file.
//
// Designed to be vendored into site repos together with ./lib/ (see ci/README.md).
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { EXIT_CHECK_FAILED, EXIT_OK, UsageError, parseCli, runCli } from './lib/cli.ts';
import { extractResources, isExecutableInline, requiresSri } from './lib/html.ts';
import { MANIFEST_SCHEMA, decodePath, parseManifest, serializeManifest, type ReleaseManifest } from './lib/manifest.ts';
import { integrityMatches, sriDigest } from './lib/sri.ts';

export const USAGE = `Usage: release-manifest --dir <build-dir> --site <origin> --release <version> --commit <git-sha> [options]

Hashes every file in a static build directory with SHA-384 and writes a release
manifest (docs/RELEASE_MANIFEST.md). It also enforces the Kokoah SRI rules on the
entrypoint HTML and exits 1 (writing nothing) if any rule is broken:
  - every <script src>, stylesheet, modulepreload and preload(as=script|style)
    has an integrity attribute that matches the file in the build directory
  - no script or style is loaded from another origin
  - executable inline <script> elements are recorded in inlineScripts (their
    sha384 tokens can be added to the CSP); pass --no-inline to forbid them

Options:
  --dir <path>          Build output directory (e.g. dist)
  --site <origin>       Origin the release is served from (e.g. https://app.kokoah.example)
  --release <version>   Release version string
  --commit <sha>        Full 40-character git commit SHA (in CI: $GITHUB_SHA)
  --entrypoint <path>   HTML entrypoint as a URL path (default /index.html)
  --out <file>          Where to write the manifest (default release-manifest.json)
  --built-at <iso>      Build timestamp (default: $SOURCE_DATE_EPOCH if set, else now)
  --exclude <name>      File name to leave out (repeatable). Always excluded: _headers,
                        _redirects, _routes.json (Cloudflare config, never served)
  --no-inline           Fail if the entrypoint has any executable inline <script>
  -h, --help            Show this help

Exit codes: 0 manifest written, 1 SRI rule broken, 2 usage or fatal error.`;

const ALWAYS_EXCLUDED = new Set(['_headers', '_redirects', '_routes.json']);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else if (entry.isFile()) out.push(p);
    // Symlinks and other types are skipped on purpose: they are not deployable content.
  }
  return out;
}

export interface BuildManifestOptions {
  dir: string;
  site: string;
  version: string;
  gitCommit: string;
  builtAt: string;
  entrypoint: string;
  exclude: string[];
  forbidInline: boolean;
}

export interface BuildResult {
  manifest: ReleaseManifest | null;
  problems: string[];
}

export async function buildManifest(opts: BuildManifestOptions): Promise<BuildResult> {
  const excluded = new Set([...ALWAYS_EXCLUDED, ...opts.exclude]);
  const files: Record<string, string> = {};
  const bytesByKey = new Map<string, Uint8Array>();
  for (const abs of await walk(opts.dir)) {
    const rel = relative(opts.dir, abs).split(sep).join('/');
    const base = rel.split('/').at(-1) ?? rel;
    if (excluded.has(base) || excluded.has(rel)) continue;
    const bytes = new Uint8Array(await readFile(abs));
    const key = `/${rel}`;
    files[key] = sriDigest(bytes, 'sha384');
    bytesByKey.set(key, bytes);
  }

  const problems: string[] = [];
  const html = bytesByKey.get(opts.entrypoint);
  if (html === undefined) {
    return { manifest: null, problems: [`entrypoint ${opts.entrypoint} not found in ${opts.dir}`] };
  }
  const pageUrl = new URL(opts.entrypoint, opts.site).href;
  const resources = extractResources(new TextDecoder().decode(html), pageUrl);
  const inlineScripts: string[] = [];

  for (const r of resources) {
    if (isExecutableInline(r)) {
      const token = sriDigest(new TextEncoder().encode(r.inlineContent ?? ''), 'sha384');
      if (opts.forbidInline) problems.push(`inline <script> found (${token}); inline scripts are forbidden`);
      inlineScripts.push(token);
      continue;
    }
    if (!requiresSri(r)) continue;
    const what = `${r.kind} ${r.ref}`;
    if (r.url === null) {
      problems.push(`${what}: unparseable URL`);
      continue;
    }
    const u = new URL(r.url);
    if (u.origin !== opts.site) {
      problems.push(`${what}: loaded from another origin (${u.origin}); self-host it`);
      continue;
    }
    if (r.integrity === null || r.integrity.trim() === '') {
      problems.push(`${what}: missing integrity attribute`);
      continue;
    }
    const key = decodePath(u.pathname);
    const bytes = bytesByKey.get(key);
    if (bytes === undefined) problems.push(`${what}: ${key} is not in the build directory`);
    else if (!integrityMatches(r.integrity, bytes)) problems.push(`${what}: integrity attribute does not match the built file`);
  }

  if (problems.length > 0) return { manifest: null, problems };
  const manifest = parseManifest({
    schema: MANIFEST_SCHEMA,
    site: opts.site,
    version: opts.version,
    gitCommit: opts.gitCommit,
    builtAt: opts.builtAt,
    entrypoint: opts.entrypoint,
    files,
    inlineScripts: [...new Set(inlineScripts)],
  });
  return { manifest, problems };
}

function defaultBuiltAt(): string {
  const epoch = process.env['SOURCE_DATE_EPOCH'];
  if (epoch !== undefined && /^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000).toISOString();
  return new Date().toISOString();
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseCli<{
    dir?: string;
    site?: string;
    release?: string;
    commit?: string;
    entrypoint?: string;
    out?: string;
    'built-at'?: string;
    exclude?: string[];
    'no-inline'?: boolean;
  }>(argv, {
    dir: { type: 'string' },
    site: { type: 'string' },
    release: { type: 'string' },
    commit: { type: 'string' },
    entrypoint: { type: 'string' },
    out: { type: 'string' },
    'built-at': { type: 'string' },
    exclude: { type: 'string', multiple: true },
    'no-inline': { type: 'boolean' },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_OK;
  }
  for (const k of ['dir', 'site', 'release', 'commit'] as const) {
    if (values[k] === undefined || values[k] === '') throw new UsageError(`--${k} is required`);
  }
  let siteOrigin: string | null = null;
  try {
    siteOrigin = new URL(values.site as string).origin;
  } catch {
    // reported below
  }
  if (siteOrigin !== values.site) throw new UsageError('--site must be an origin such as https://app.kokoah.example (no path, no trailing slash)');
  if (!/^[0-9a-fA-F]{40}$/.test(values.commit as string)) throw new UsageError('--commit must be a full 40-character git SHA');
  const result = await buildManifest({
    dir: values.dir as string,
    site: values.site as string,
    version: values.release as string,
    gitCommit: (values.commit as string).toLowerCase(),
    builtAt: values['built-at'] ?? defaultBuiltAt(),
    entrypoint: values.entrypoint ?? '/index.html',
    exclude: values.exclude ?? [],
    forbidInline: values['no-inline'] === true,
  });
  if (result.manifest === null) {
    process.stderr.write(`release-manifest: ${result.problems.length} problem(s):\n${result.problems.map((p) => `  - ${p}`).join('\n')}\n`);
    return EXIT_CHECK_FAILED;
  }
  const out = values.out ?? 'release-manifest.json';
  await writeFile(out, serializeManifest(result.manifest));
  const m = result.manifest;
  process.stdout.write(
    `release-manifest: wrote ${out}: ${Object.keys(m.files).length} file(s), ${m.inlineScripts.length} inline script(s), ` +
      `release ${m.version} @ ${m.gitCommit.slice(0, 12)}\n`,
  );
  return EXIT_OK;
}

if (import.meta.main) {
  await runCli(USAGE, () => main(process.argv.slice(2)));
}

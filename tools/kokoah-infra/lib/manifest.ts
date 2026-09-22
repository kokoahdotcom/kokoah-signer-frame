// Release manifest format "kokoah.release-manifest/v1".
// The human-readable spec is docs/RELEASE_MANIFEST.md; keep both in sync.
import { isSriToken } from './sri.ts';

export const MANIFEST_SCHEMA = 'kokoah.release-manifest/v1';

export interface ReleaseManifest {
  schema: typeof MANIFEST_SCHEMA;
  /** Origin the release is served from, e.g. "https://app.kokoah.example". No path. */
  site: string;
  /** Release version, e.g. "1.4.2" or "2026.09.21-1". */
  version: string;
  /** Full 40-character git commit SHA the release was built from. */
  gitCommit: string;
  /** ISO 8601 UTC timestamp of the build. */
  builtAt: string;
  /** Manifest key of the HTML document served for "/" and SPA routes. */
  entrypoint: string;
  /** Every deployed file: URL path (starting with "/") -> "sha384-<base64>". */
  files: Record<string, string>;
  /** sha384 SRI tokens of inline <script> elements in the entrypoint (ideally empty). */
  inlineScripts: string[];
}

export class ManifestError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid release manifest:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate untrusted JSON and return a typed manifest, or throw ManifestError. */
export function parseManifest(input: unknown): ReleaseManifest {
  const p: string[] = [];
  if (!isObject(input)) throw new ManifestError(['manifest must be a JSON object']);
  const m = input;

  if (m['schema'] !== MANIFEST_SCHEMA) p.push(`schema must be "${MANIFEST_SCHEMA}"`);

  const site = m['site'];
  if (typeof site !== 'string') p.push('site must be a string');
  else {
    try {
      const u = new URL(site);
      if (u.origin !== site) p.push('site must be an origin such as "https://app.kokoah.example" (no path or trailing slash)');
    } catch {
      p.push('site must be a valid URL origin');
    }
  }

  if (typeof m['version'] !== 'string' || m['version'] === '') p.push('version must be a non-empty string');
  if (typeof m['gitCommit'] !== 'string' || !/^[0-9a-f]{40}$/.test(m['gitCommit'])) {
    p.push('gitCommit must be a full 40-character lowercase hex git SHA');
  }
  if (typeof m['builtAt'] !== 'string' || Number.isNaN(Date.parse(m['builtAt']))) {
    p.push('builtAt must be an ISO 8601 timestamp');
  }

  const files = m['files'];
  if (!isObject(files) || Object.keys(files).length === 0) p.push('files must be a non-empty object');
  else {
    for (const [path, hash] of Object.entries(files)) {
      if (!path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
        p.push(`files key ${JSON.stringify(path)} must be an absolute URL path starting with "/"`);
      }
      if (typeof hash !== 'string' || !isSriToken(hash, 'sha384')) {
        p.push(`files[${JSON.stringify(path)}] must be a single "sha384-<base64>" token`);
      }
    }
  }

  const entrypoint = m['entrypoint'];
  if (typeof entrypoint !== 'string') p.push('entrypoint must be a string');
  else if (isObject(files) && !(entrypoint in files)) p.push(`entrypoint ${JSON.stringify(entrypoint)} is not listed in files`);

  const inline = m['inlineScripts'];
  if (!Array.isArray(inline)) p.push('inlineScripts must be an array (use [] when there are none)');
  else {
    for (const h of inline) {
      if (typeof h !== 'string' || !isSriToken(h, 'sha384')) p.push(`inlineScripts entry ${JSON.stringify(h)} must be a "sha384-<base64>" token`);
    }
  }

  if (p.length > 0) throw new ManifestError(p);
  return m as unknown as ReleaseManifest;
}

/**
 * Map an absolute URL to its manifest key, or null if it is not on the site origin.
 * Query strings and fragments are ignored; "/" maps to the entrypoint.
 */
export function manifestKeyFor(url: string, manifest: ReleaseManifest): string | null {
  const u = new URL(url);
  if (u.origin !== manifest.site) return null;
  const path = decodePath(u.pathname);
  return path === '/' ? manifest.entrypoint : path;
}

/**
 * Percent-decode a URL path. Malformed encoding (possible in hostile HTML) is
 * returned as-is, so it simply fails to match a manifest key instead of throwing.
 */
export function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/** Stable JSON: keys of `files` sorted, two-space indent, trailing newline. */
export function serializeManifest(m: ReleaseManifest): string {
  const files: Record<string, string> = {};
  for (const k of Object.keys(m.files).sort()) files[k] = m.files[k] as string;
  const ordered: ReleaseManifest = {
    schema: m.schema,
    site: m.site,
    version: m.version,
    gitCommit: m.gitCommit,
    builtAt: m.builtAt,
    entrypoint: m.entrypoint,
    files,
    inlineScripts: [...m.inlineScripts].sort(),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

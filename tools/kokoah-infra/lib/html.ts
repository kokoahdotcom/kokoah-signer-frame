// Minimal, dependency-free extraction of <script>, <link> and <base> tags from
// HTML. It targets build output (Vite index.html), not arbitrary web pages, but
// it tolerates quoted/unquoted attributes, comments and upper-case tag names.

export type ResourceKind = 'script' | 'inline-script' | 'stylesheet' | 'modulepreload' | 'preload' | 'other-link';

export interface HtmlResource {
  kind: ResourceKind;
  /** Absolute URL for external resources, null for inline scripts. */
  url: string | null;
  /** The raw src/href attribute. */
  ref: string | null;
  integrity: string | null;
  /** Script `type` attribute or link `as` attribute. */
  type: string | null;
  /** Content of an inline script, exactly as it appears between the tags. */
  inlineContent: string | null;
  attrs: Record<string, string>;
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', '#39': "'", '#34': '"' };

function decodeEntities(v: string): string {
  return v.replace(/&(amp|quot|apos|lt|gt|#39|#34);/g, (_, e: string) => ENTITIES[e] ?? _);
}

export function parseAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of attrText.matchAll(re)) {
    const name = (m[1] ?? '').toLowerCase();
    if (name === '' || name in attrs) continue; // first occurrence wins, as in browsers
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function resolve(ref: string, base: string): string | null {
  try {
    return new URL(ref, base).href;
  } catch {
    return null;
  }
}

/** Only these link relations can carry integrity that browsers enforce for scripts/styles. */
function linkKind(rel: string, as: string | undefined): ResourceKind {
  const rels = rel.toLowerCase().split(/\s+/);
  if (rels.includes('stylesheet')) return 'stylesheet';
  if (rels.includes('modulepreload')) return 'modulepreload';
  if (rels.includes('preload') && (as === 'script' || as === 'style')) return 'preload';
  return 'other-link';
}

/**
 * Extract script and link resources. `pageUrl` is the URL the HTML was served
 * from; a <base href> in the document takes precedence for resolving relatives.
 */
export function extractResources(html: string, pageUrl: string): HtmlResource[] {
  const doc = stripComments(html);
  let base = pageUrl;
  const baseTag = /<base\b([^>]*)>/i.exec(doc);
  if (baseTag !== null) {
    const href = parseAttributes(baseTag[1] ?? '')['href'];
    if (href !== undefined) base = resolve(href, pageUrl) ?? pageUrl;
  }

  const out: { index: number; res: HtmlResource }[] = [];

  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const m of doc.matchAll(scriptRe)) {
    const attrs = parseAttributes(m[1] ?? '');
    const src = attrs['src'];
    if (src !== undefined) {
      out.push({
        index: m.index,
        res: {
          kind: 'script',
          url: resolve(src, base),
          ref: src,
          integrity: attrs['integrity'] ?? null,
          type: attrs['type'] ?? null,
          inlineContent: null,
          attrs,
        },
      });
    } else {
      out.push({
        index: m.index,
        res: {
          kind: 'inline-script',
          url: null,
          ref: null,
          integrity: null,
          type: attrs['type'] ?? null,
          inlineContent: m[2] ?? '',
          attrs,
        },
      });
    }
  }

  const linkRe = /<link\b([^>]*)>/gi;
  for (const m of doc.matchAll(linkRe)) {
    const attrs = parseAttributes(m[1] ?? '');
    const href = attrs['href'];
    if (href === undefined) continue;
    out.push({
      index: m.index,
      res: {
        kind: linkKind(attrs['rel'] ?? '', attrs['as']),
        url: resolve(href, base),
        ref: href,
        integrity: attrs['integrity'] ?? null,
        type: attrs['as'] ?? null,
        inlineContent: null,
        attrs,
      },
    });
  }

  return out.sort((a, b) => a.index - b.index).map((o) => o.res);
}

/** Resources whose integrity browsers enforce and that Kokoah requires SRI on. */
export function requiresSri(r: HtmlResource): boolean {
  return r.kind === 'script' || r.kind === 'stylesheet' || r.kind === 'modulepreload' || r.kind === 'preload';
}

/**
 * Inline <script> elements that execute or steer script loading (import maps).
 * JSON data blocks such as application/ld+json are not executed and are excluded.
 */
export function isExecutableInline(r: HtmlResource): boolean {
  if (r.kind !== 'inline-script') return false;
  const t = (r.type ?? '').trim().toLowerCase();
  return t === '' || t === 'module' || t === 'text/javascript' || t === 'application/javascript' || t === 'importmap';
}

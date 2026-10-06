// Build-time helper for hash-mode CSP (see buildCsp `scriptHashes`): finds every INLINE <script> in prerendered HTML and returns the
// CSP hash sources that would allow exactly those. Node-only (node:crypto): import from "@cnote/security/csp-hashes", never from an
// edge/proxy module. Used by scripts/csp-hashes.ts (`pnpm csp:hashes`) over `apps/web/.next/server/app/**/*.html`.
import { createHash } from "node:crypto";

export type HashAlgorithm = "sha256" | "sha384" | "sha512";

/** `'sha256-<base64>'` of the exact text between <script> and </script> (browsers hash the raw bytes, whitespace included). */
export function cspHash(source: string, algorithm: HashAlgorithm = "sha256"): string {
  return `'${algorithm}-${createHash(algorithm).update(source, "utf8").digest("base64")}'`;
}

export interface InlineScript {
  /** raw text between the tags */
  text: string;
  /** `type="…"` if any (data blocks such as application/ld+json are not executed and need no hash) */
  type: string | null;
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi;
const ATTR_SRC = /\ssrc\s*=/i;
const ATTR_TYPE = /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
/** MIME types a browser treats as script. Anything else (ld+json, importmap, speculationrules...) is a data block: CSP does not apply to it. */
const EXECUTABLE = /^(?:|module|(?:text|application)\/(?:javascript|ecmascript|x-javascript|x-ecmascript))$/i;

/** Inline (no `src`) scripts of an HTML document, in document order. */
export function inlineScripts(html: string): InlineScript[] {
  const out: InlineScript[] = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    const attrs = ` ${m[1] ?? ""}`;
    if (ATTR_SRC.test(attrs)) continue;
    const t = ATTR_TYPE.exec(attrs);
    out.push({ text: m[2] ?? "", type: t ? (t[1] ?? t[2] ?? t[3] ?? "") : null });
  }
  return out;
}

/** Unique hash sources a CSP needs so every EXECUTABLE inline script of the page runs. Empty inline bodies need none. */
export function pageScriptHashes(html: string, algorithm: HashAlgorithm = "sha256"): string[] {
  const hs = inlineScripts(html)
    .filter((s) => s.text.length > 0 && EXECUTABLE.test(s.type ?? ""))
    .map((s) => cspHash(s.text, algorithm));
  return [...new Set(hs)];
}

export interface HashManifest {
  /** hashes that appear on (almost) every page: framework bootstrap and the pre-paint rail script */
  shared: string[];
  /** route -> every hash that page needs (shared ones included) */
  routes: Record<string, string[]>;
  stats: { pages: number; distinctHashes: number; sharedHashes: number; pagesWithPageSpecificScripts: number; maxPerPage: number };
}

/** Builds the manifest from `route -> html`. A hash is "shared" when it appears on at least `sharedShare` of the pages. */
export function buildManifest(pages: Record<string, string>, opts: { algorithm?: HashAlgorithm; sharedShare?: number } = {}): HashManifest {
  const routes: Record<string, string[]> = {};
  const count = new Map<string, number>();
  for (const [route, html] of Object.entries(pages)) {
    const hs = pageScriptHashes(html, opts.algorithm);
    routes[route] = hs;
    for (const h of hs) count.set(h, (count.get(h) ?? 0) + 1);
  }
  const n = Object.keys(pages).length;
  const share = opts.sharedShare ?? 0.9;
  const shared = [...count].filter(([, c]) => n > 0 && c / n >= share).map(([h]) => h).sort();
  const sharedSet = new Set(shared);
  const specific = Object.values(routes).filter((hs) => hs.some((h) => !sharedSet.has(h))).length;
  return {
    shared,
    routes,
    stats: { pages: n, distinctHashes: count.size, sharedHashes: shared.length, pagesWithPageSpecificScripts: specific, maxPerPage: Math.max(0, ...Object.values(routes).map((h) => h.length)) },
  };
}

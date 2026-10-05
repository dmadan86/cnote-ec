// `pnpm csp:hashes [distDir] [out]`: hash every inline <script> of the buyer web's prerendered HTML after `next build` and write a
// per-route CSP hash manifest (default apps/web/.next -> apps/web/.next/csp-hashes.json).
//
// Why: static/ISR pages cannot carry a nonce, so they ship `script-src 'self' 'unsafe-inline'`. Hash mode (buildCsp `scriptHashes`)
// removes 'unsafe-inline' for a page whose COMPLETE inline-script set is known. Next's inline scripts (the RSC flight chunks
// `self.__next_f.push(...)`) differ per page, so the manifest is page-specific by nature and is meant for an EDGE layer that sets the
// header per route (Cloudflare Transform Rules / a Worker, see docs/security/security-architecture.md "Static pages and CSP").
// The printed stats say how much of the site could be strict today. Exit code is always 0: this is a report/generator, not a gate.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { buildManifest } from "../packages/security/src/csp-hashes";

const dist = resolve(process.argv[2] ?? "apps/web/.next");
const out = resolve(process.argv[3] ?? join(dist, "csp-hashes.json"));
const root = join(dist, "server", "app");

function* htmlFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* htmlFiles(p);
    else if (name.endsWith(".html")) yield p;
  }
}

try {
  statSync(root);
} catch {
  console.error(`csp:hashes: ${root} not found. Run \`pnpm --filter @cnote/web build\` first.`);
  process.exit(0);
}

const pages: Record<string, string> = {};
for (const f of htmlFiles(root)) {
  const rel = relative(root, f).replace(/\.html$/, "").split("\\").join("/");
  const route = rel === "index" ? "/" : `/${rel.replace(/\/index$/, "")}`;
  pages[route] = readFileSync(f, "utf8");
}
const manifest = buildManifest(pages);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
const s = manifest.stats;
console.log(`csp:hashes: ${s.pages} prerendered pages, ${s.distinctHashes} distinct inline scripts (${s.sharedHashes} shared by >=90% of pages).`);
console.log(`csp:hashes: ${s.pagesWithPageSpecificScripts} pages carry page-specific inline scripts (max ${s.maxPerPage} per page); the rest could use the shared set alone.`);
console.log(`csp:hashes: wrote ${relative(process.cwd(), out)}`);

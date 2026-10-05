// Module boundary guard (ADR-006: "boundaries enforced via build rules"). Run: pnpm check:boundaries
//
// 1. Declared dependencies: every @cnote/* import in packages/*/src and apps/*/src is declared in that
//    workspace's package.json (pnpm only fails at runtime; this gives a clear CI message).
// 2. Allowed graph: declared @cnote/* edges between packages are a subset of ALLOWED_DEPS below, the graph
//    has no cycles, and domain packages never import next/* or react (only FRAMEWORK_PACKAGES may).
//    Apps may import any package (they still must declare it).
// 3. Model ownership: each prisma schema file names its owning package in a header comment
//    ("// Owned by @cnote/x"); a package may only touch (prisma.<accessor> / tx.<accessor> / raw SQL table)
//    the models of schema files it owns. Sanctioned exceptions live in ALLOWLIST with a reason.
//
// Exit code 1 (with file:line messages) on any violation. Known gaps: relation traversal through
// include/select on a foreign model, and dynamic accessors (prisma[x]) are not detected.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------------------------
// Policy (edit deliberately: each change is an architecture decision)
// ---------------------------------------------------------------------------------------------

/**
 * Allowed @cnote/* dependencies per package (snapshot of the reviewed graph; ADR-006 + CLAUDE.md).
 * Adding an edge here is the review step; anything declared in a package.json but missing here fails.
 * Apps are not listed: "apps may import anything".
 */
export const ALLOWED_DEPS: Record<string, string[]> = {
  "@cnote/db": [],
  "@cnote/core": ["@cnote/db"],
  "@cnote/security": ["@cnote/core"],
  "@cnote/media": [],
  "@cnote/live-db": [],
  "@cnote/observability": [],
  "@cnote/ui": [],
  // Framework-free cookie-consent core shared by every app (state, registry, browser logic, snapshots): depends on nothing.
  "@cnote/consent": [],
  "@cnote/identity": ["@cnote/core", "@cnote/db", "@cnote/security"],
  // + identity (30 Sep 2026): GST invoices snapshot the recipient's legal name/GSTIN/address via getBusinessBillingProfile.
  // + media: rendered invoice PDFs cached in the private bucket (invoices/ keys are private-only).
  "@cnote/billing": ["@cnote/core", "@cnote/db", "@cnote/identity", "@cnote/media"],
  // ADR-024 sponsored placements: reads live listings/trust, spends via billing's ad wallet, merges after organic search.
  "@cnote/ads": ["@cnote/billing", "@cnote/catalogue", "@cnote/core", "@cnote/db", "@cnote/identity", "@cnote/search"],
  // ADR-025 promotions/offers/coupons/referrals: price history via catalogue, rewards via billing.
  "@cnote/promotions": ["@cnote/billing", "@cnote/catalogue", "@cnote/core", "@cnote/db", "@cnote/identity", "@cnote/media"],
  // Phase 2 (ADR-012..017), each behind a flag. Escrow attaches to enquiry's Order; disputes sit above escrow + quality.
  "@cnote/escrow": ["@cnote/billing", "@cnote/core", "@cnote/db", "@cnote/enquiry", "@cnote/identity", "@cnote/media"],
  "@cnote/quality": ["@cnote/ai", "@cnote/catalogue", "@cnote/core", "@cnote/db", "@cnote/enquiry", "@cnote/identity", "@cnote/media"],
  "@cnote/disputes": ["@cnote/ai", "@cnote/core", "@cnote/db", "@cnote/enquiry", "@cnote/escrow", "@cnote/identity", "@cnote/media", "@cnote/quality"],
  "@cnote/negotiation": ["@cnote/ai", "@cnote/catalogue", "@cnote/core", "@cnote/db", "@cnote/enquiry", "@cnote/identity"],
  "@cnote/verticals": ["@cnote/catalogue", "@cnote/core", "@cnote/db", "@cnote/identity"],
  // + disputes (ADR-021): ONDC IGM issues are handled as disputes.
  "@cnote/ondc": ["@cnote/catalogue", "@cnote/core", "@cnote/db", "@cnote/disputes", "@cnote/enquiry", "@cnote/identity", "@cnote/security"],
  // Phase 3 (ADR-019..022), each behind a flag. Credit sits above escrow + disputes (score inputs); a2a above negotiation.
  "@cnote/credit": ["@cnote/core", "@cnote/db", "@cnote/disputes", "@cnote/enquiry", "@cnote/escrow", "@cnote/identity"],
  "@cnote/a2a": ["@cnote/ai", "@cnote/catalogue", "@cnote/core", "@cnote/db", "@cnote/enquiry", "@cnote/identity", "@cnote/negotiation"],
  "@cnote/prices": ["@cnote/billing", "@cnote/catalogue", "@cnote/core", "@cnote/db", "@cnote/enquiry", "@cnote/escrow", "@cnote/identity"],
  "@cnote/admin": ["@cnote/core", "@cnote/db", "@cnote/identity"],
  "@cnote/ai": ["@cnote/core", "@cnote/db"],
  "@cnote/templates": ["@cnote/core", "@cnote/db", "@cnote/media"],
  "@cnote/metrics": ["@cnote/core", "@cnote/db"],
  // ADR-023 CDC-style read models (funnel, GMV by category/state, seller cohorts) projected from the domain event log.
  // Depends only on the kernel: state-of-business comes through a resolver port the worker wires (no identity edge).
  "@cnote/analytics": ["@cnote/core", "@cnote/db"],
  // DPDP orchestrator (ADR-010 access/erasure/retention): sits ABOVE the domain modules and calls their public
  // export/erase functions, so it may depend on many of them. Nothing may depend on it except apps.
  "@cnote/compliance": [
    "@cnote/alerts", "@cnote/catalogue", "@cnote/core", "@cnote/credit", "@cnote/db", "@cnote/disputes", "@cnote/enquiry", "@cnote/identity", "@cnote/leadgen", "@cnote/notifications",
    "@cnote/developer", "@cnote/ondc", "@cnote/quality", "@cnote/reviews", "@cnote/security", "@cnote/storefront", "@cnote/whatsapp", "@cnote/wishlist",
  ],
  "@cnote/developer": ["@cnote/core", "@cnote/db", "@cnote/identity"],
  "@cnote/catalogue": ["@cnote/ai", "@cnote/core", "@cnote/db", "@cnote/identity", "@cnote/media", "@cnote/live-db"],
  // + live-db (DEV dependency only): the relevance harness (packages/search/relevance/, outside src/) writes its fixture corpus to the live read DB.
  "@cnote/search": ["@cnote/ai", "@cnote/catalogue", "@cnote/core", "@cnote/db", "@cnote/identity", "@cnote/live-db"],
  "@cnote/enquiry": ["@cnote/ai", "@cnote/billing", "@cnote/catalogue", "@cnote/core", "@cnote/db", "@cnote/identity", "@cnote/media"],
  "@cnote/wishlist": ["@cnote/catalogue", "@cnote/core", "@cnote/db", "@cnote/identity"],
  // Buyer retention: follows, saved searches, opt-in alerts. Reads saved items via wishlist and new matches via search (public APIs only).
  "@cnote/alerts": ["@cnote/catalogue", "@cnote/core", "@cnote/db", "@cnote/identity", "@cnote/search", "@cnote/wishlist"],
  "@cnote/bulk": ["@cnote/catalogue", "@cnote/core", "@cnote/db", "@cnote/identity", "@cnote/media", "@cnote/security"],
  "@cnote/reviews": ["@cnote/ai", "@cnote/catalogue", "@cnote/core", "@cnote/db", "@cnote/enquiry", "@cnote/identity"],
  "@cnote/leadgen": ["@cnote/catalogue", "@cnote/core", "@cnote/db", "@cnote/enquiry", "@cnote/identity"],
  "@cnote/storefront": ["@cnote/ai", "@cnote/catalogue", "@cnote/core", "@cnote/db", "@cnote/identity", "@cnote/reviews"],
  "@cnote/domains": ["@cnote/core", "@cnote/db", "@cnote/security", "@cnote/storefront"],
  "@cnote/email": ["@cnote/core", "@cnote/db", "@cnote/identity", "@cnote/templates"],
  "@cnote/notifications": [
    "@cnote/alerts", "@cnote/catalogue", "@cnote/core", "@cnote/db", "@cnote/email", "@cnote/enquiry", "@cnote/identity", "@cnote/reviews", "@cnote/templates",
  ],
  "@cnote/whatsapp": ["@cnote/ai", "@cnote/catalogue", "@cnote/core", "@cnote/db", "@cnote/identity", "@cnote/media", "@cnote/templates"],
  // Next.js glue shared by the apps: the one package (besides ui) that may sit on top of many modules.
  "@cnote/next-kit": ["@cnote/admin", "@cnote/consent", "@cnote/core", "@cnote/email", "@cnote/identity", "@cnote/security", "@cnote/leadgen", "@cnote/ui"],
};

/** Packages allowed to import next/* or react. Everything else outside apps/ must stay framework-free. */
export const FRAMEWORK_PACKAGES: Record<string, string> = {
  "@cnote/ui": "shared React component library",
  "@cnote/next-kit": "Next.js glue for the three apps",
  "@cnote/storefront": "block renderer (React) for seller mini-sites",
};

/** Owner overrides for schema files whose header does not name a single owning package. */
export const MODEL_OWNER_OVERRIDES: Record<string, string> = {
  // platform.prisma: "Cross-cutting: domain event log (@cnote/core events) and AI audit + human review (@cnote/ai)."
  DomainEvent: "@cnote/core",
  AiDecision: "@cnote/ai",
  ReviewItem: "@cnote/ai",
};

export interface AllowEntry {
  /** Workspace name (e.g. "@cnote/worker") or package.json name of the offending workspace. */
  pkg: string;
  /** Substring the file path (relative to the repo root) must contain; omit for the whole workspace. */
  file?: string;
  /** Models (PascalCase) the exception covers. */
  models: string[];
  reason: string;
}

/**
 * Sanctioned exceptions to "a module queries only its own models". Every entry needs a reason.
 * `TODO(debt)` entries are existing violations captured so CI can guard against NEW ones; each should be
 * paid down by routing through the owning module's public function or a domain event.
 */
export const ALLOWLIST: AllowEntry[] = [
  // --- Sanctioned by design -------------------------------------------------------------------
  {
    pkg: "@cnote/metrics",
    file: "packages/metrics/src/sql.ts",
    models: ["DomainEvent"],
    reason: "Read-only analytics over the append-only domain event log (metrics.prisma header: 'read-only over DomainEvent'); writes stay in @cnote/core.",
  },
  {
    pkg: "@cnote/analytics",
    file: "packages/analytics/src/log.ts",
    models: ["DomainEvent"],
    reason: "ADR-023 projections read the append-only domain event log by id range (same sanctioned read-only exception as @cnote/metrics); writes stay in @cnote/core.",
  },
  {
    pkg: "@cnote/worker",
    file: "apps/worker/src/seed.ts",
    models: ["Person", "Business", "BusinessMember", "VerificationRecord", "AuthSession", "Consent", "Category", "Listing"],
    reason: "Dev-only seed script (pnpm db:seed): builds fixtures across modules directly and idempotently; never runs in production paths.",
  },
  {
    pkg: "@cnote/domains",
    file: "packages/domains/src",
    models: ["Storefront", "StorefrontDomain", "StorefrontTrafficDaily"],
    reason:
      "Custom domains + traffic metering are a sub-feature split out of @cnote/storefront and share storefront.prisma (domains depends on storefront, never the reverse). " +
      "The schema header should name @cnote/domains as co-owner of StorefrontDomain / StorefrontTrafficDaily.",
  },
  // (No debt entries: the three original violations were paid down on 30 Sep 2026 — enquiry counts fake flags via
  // Match.refundReason, leadgen reads catalogue.getPublicListing, and the email log moved into @cnote/email.)
];

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export interface Violation {
  rule: "declared-deps" | "allowed-graph" | "cycle" | "framework" | "model-ownership";
  file: string;
  line: number;
  message: string;
}

export interface Workspace {
  name: string;
  dir: string; // relative to root
  kind: "package" | "app";
  declared: Set<string>;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------------------------

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'](@cnote\/[\w-]+)(?:\/[^"']*)?["']/g;
const FRAMEWORK_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'](next(?:\/[^"']*)?|react|react\/[^"']*|react-dom(?:\/[^"']*)?)["']/g;

/** True for lines that are entirely a comment (good enough for scanning; block comments start with `*`). */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

export function findImports(text: string): { pkg: string; line: number }[] {
  const out: { pkg: string; line: number }[] = [];
  text.split("\n").forEach((l, i) => {
    if (isCommentLine(l)) return;
    for (const m of l.matchAll(IMPORT_RE)) out.push({ pkg: m[1]!, line: i + 1 });
  });
  return out;
}

export function findFrameworkImports(text: string): { spec: string; line: number }[] {
  const out: { spec: string; line: number }[] = [];
  text.split("\n").forEach((l, i) => {
    if (isCommentLine(l)) return;
    for (const m of l.matchAll(FRAMEWORK_RE)) out.push({ spec: m[1]!, line: i + 1 });
  });
  return out;
}

/** Cycles in a dependency graph, each returned as a path that starts and ends at the same node. */
export function findCycles(graph: Record<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const stack: string[] = [];
  const visit = (n: string) => {
    state.set(n, 1);
    stack.push(n);
    for (const d of graph[n] ?? []) {
      if (state.get(d) === 1) cycles.push([...stack.slice(stack.indexOf(d)), d]);
      else if (!state.has(d)) visit(d);
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const n of Object.keys(graph)) if (!state.has(n)) visit(n);
  return cycles;
}

export const accessorOf = (model: string): string => model.charAt(0).toLowerCase() + model.slice(1);

export interface SchemaInfo {
  /** model name -> owning package */
  owners: Map<string, string>;
  /** model name -> mapped table name */
  tables: Map<string, string>;
}

/**
 * Reads models + owner(s) from one schema file. The header clause "Owned by @cnote/a (ModelA) and
 * @cnote/b (ModelB, ModelC)." assigns listed models to each owner; a single owner (optionally followed by
 * a non-model parenthetical such as "(Catalogue + Moderation)") owns every model in the file.
 */
export function parseSchema(text: string): SchemaInfo {
  const models = [...text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((m) => ({
    name: m[1]!,
    table: /@@map\("([^"]+)"\)/.exec(m[2]!)?.[1] ?? m[1]!,
  }));
  const owners = new Map<string, string>();
  const tables = new Map(models.map((m) => [m.name, m.table]));
  const header = text.split("\n").filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/\s?/, "")).join("\n");
  const at = header.indexOf("Owned by");
  if (at >= 0) {
    const clause = header.slice(at + "Owned by".length).split(/:|\.(?:\s|$)/)[0]!;
    const found = [...clause.matchAll(/(@cnote\/[\w-]+)(?:\s*\(([^)]*)\))?/g)].map((m) => ({
      pkg: m[1]!,
      listed: (m[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    }));
    const names = new Set(models.map((m) => m.name));
    for (const f of found) {
      const isModelList = f.listed.length > 0 && f.listed.every((n) => names.has(n));
      if (isModelList) for (const n of f.listed) owners.set(n, f.pkg);
      else if (found.length === 1) for (const m of models) owners.set(m.name, f.pkg);
    }
  }
  for (const [model, pkg] of Object.entries(MODEL_OWNER_OVERRIDES)) if (tables.has(model)) owners.set(model, pkg);
  return { owners, tables };
}

const METHODS =
  "findMany|findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany|count|aggregate|groupBy";

/** `prisma.person`, `tx.person`, or `<anything>.person.<method>` usages of the given model accessors. */
export function findModelUsages(text: string, accessors: Map<string, string>): { model: string; line: number }[] {
  const names = [...accessors.keys()].join("|");
  if (!names) return [];
  const direct = new RegExp(`\\b(?:prisma|tx)\\.(${names})\\b`, "g");
  const viaMethod = new RegExp(`\\.(${names})\\.(?:${METHODS})\\b`, "g");
  const seen = new Set<string>();
  const out: { model: string; line: number }[] = [];
  text.split("\n").forEach((l, i) => {
    if (isCommentLine(l)) return;
    for (const re of [direct, viaMethod]) {
      for (const m of l.matchAll(re)) {
        const model = accessors.get(m[1]!)!;
        if (!seen.has(`${i}:${model}`)) {
          seen.add(`${i}:${model}`);
          out.push({ model, line: i + 1 });
        }
      }
    }
  });
  return out;
}

/**
 * Raw-SQL references (`FROM|JOIN|INTO|UPDATE <table>`, upper-case keyword + exact table name) to the given
 * tables (lower-cased table name -> model). Matches on any non-comment line: SQL is often built in helper
 * files that never call $queryRaw themselves.
 */
export function findRawSqlUsages(text: string, tables: Map<string, string>): { model: string; line: number }[] {
  const names = [...tables.keys()].filter((t) => /^\w+$/.test(t)).join("|");
  if (!names) return [];
  const end = "(?=[\\s;,)\u0060'\"]|$)"; // whitespace, punctuation or a closing quote/backtick
  const re = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+(?:public\\.)?"?(${names})"?${end}`, "g");
  const out: { model: string; line: number }[] = [];
  text.split("\n").forEach((l, i) => {
    if (isCommentLine(l)) return;
    for (const m of l.matchAll(re)) out.push({ model: tables.get(m[1]!)!, line: i + 1 });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Repo scan
// ---------------------------------------------------------------------------------------------

const SRC_EXT = /\.(?:ts|tsx|mts|cts)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "generated", ".turbo", "coverage"]);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (SRC_EXT.test(e) && !e.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

export function loadWorkspaces(root: string): Workspace[] {
  const out: Workspace[] = [];
  for (const kind of ["package", "app"] as const) {
    const base = path.join(root, kind === "package" ? "packages" : "apps");
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base).sort()) {
      const pj = path.join(base, d, "package.json");
      if (!existsSync(pj)) continue;
      const j = JSON.parse(readFileSync(pj, "utf8")) as Record<string, Record<string, string> | string>;
      const declared = new Set(
        ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) => Object.keys((j[k] as Record<string, string>) ?? {})),
      );
      out.push({ name: j.name as string, dir: `${kind === "package" ? "packages" : "apps"}/${d}`, kind, declared });
    }
  }
  return out;
}

export interface Options {
  allowlist?: AllowEntry[];
  allowedDeps?: Record<string, string[]>;
  frameworkPackages?: Record<string, string>;
}

export function runChecks(root: string, opts: Options = {}): Violation[] {
  const allowlist = opts.allowlist ?? ALLOWLIST;
  const allowedDeps = opts.allowedDeps ?? ALLOWED_DEPS;
  const frameworkOk = opts.frameworkPackages ?? FRAMEWORK_PACKAGES;
  const violations: Violation[] = [];
  const workspaces = loadWorkspaces(root);
  const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
  const pkgNames = new Set(workspaces.map((w) => w.name));

  // Schema ownership
  const schemaDir = path.join(root, "packages/db/prisma/schema");
  const owners = new Map<string, string>();
  const tables = new Map<string, string>(); // lower-cased table -> model
  if (existsSync(schemaDir)) {
    for (const f of readdirSync(schemaDir).filter((n) => n.endsWith(".prisma"))) {
      const info = parseSchema(readFileSync(path.join(schemaDir, f), "utf8"));
      for (const [m, o] of info.owners) owners.set(m, o);
      for (const [m, t] of info.tables) tables.set(t.toLowerCase(), m);
      for (const m of info.tables.keys()) {
        if (!info.owners.has(m)) {
          violations.push({ rule: "model-ownership", file: `packages/db/prisma/schema/${f}`, line: 1, message: `model ${m} has no owner: add "// Owned by @cnote/<pkg>" to the file header` });
        }
      }
    }
  }
  const accessors = new Map([...owners.keys()].map((m) => [accessorOf(m), m]));

  // Rule 2: declared graph vs allowed graph, cycles
  const graph: Record<string, string[]> = {};
  for (const w of workspaces.filter((x) => x.kind === "package")) {
    const deps = [...w.declared].filter((d) => pkgNames.has(d));
    graph[w.name] = deps;
    const allowed = allowedDeps[w.name];
    const pj = `${w.dir}/package.json`;
    if (!allowed) {
      violations.push({ rule: "allowed-graph", file: pj, line: 1, message: `${w.name} is not in ALLOWED_DEPS (scripts/check-boundaries.ts): register it with its permitted dependencies` });
      continue;
    }
    for (const d of deps) {
      if (!allowed.includes(d)) violations.push({ rule: "allowed-graph", file: pj, line: 1, message: `${w.name} depends on ${d}, which the allowed graph does not permit (update ALLOWED_DEPS only with an architecture decision)` });
    }
  }
  for (const c of findCycles(graph)) violations.push({ rule: "cycle", file: "package.json", line: 1, message: `dependency cycle: ${c.join(" -> ")}` });

  // Per-file scans
  for (const w of workspaces) {
    for (const file of walk(path.join(root, w.dir, "src"))) {
      const text = readFileSync(file, "utf8");
      const f = rel(file);

      // Rule 1
      for (const imp of findImports(text)) {
        if (imp.pkg !== w.name && pkgNames.has(imp.pkg) && !w.declared.has(imp.pkg)) {
          violations.push({ rule: "declared-deps", file: f, line: imp.line, message: `imports ${imp.pkg} but ${w.name} does not declare it in package.json` });
        }
      }

      // Rule 2b: framework-free domain packages
      if (w.kind === "package" && !frameworkOk[w.name]) {
        for (const fw of findFrameworkImports(text)) {
          violations.push({ rule: "framework", file: f, line: fw.line, message: `domain package ${w.name} imports "${fw.spec}"; only ${Object.keys(frameworkOk).join(", ")} may (and apps)` });
        }
      }

      // Rule 3: model ownership (test-support and the db package itself are exempt)
      if (w.name === "@cnote/db") continue;
      const usages = [
        ...findModelUsages(text, accessors),
        ...findRawSqlUsages(text, tables),
      ];
      const reported = new Set<string>();
      for (const u of usages) {
        const owner = owners.get(u.model);
        if (!owner || owner === w.name) continue;
        const allowed = allowlist.some((a) => a.pkg === w.name && (!a.file || f.includes(a.file)) && a.models.includes(u.model));
        const key = `${u.line}:${u.model}`;
        if (allowed || reported.has(key)) continue;
        reported.add(key);
        violations.push({ rule: "model-ownership", file: f, line: u.line, message: `${w.name} touches ${u.model}, owned by ${owner}: go through ${owner}'s public API or a domain event` });
      }
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function formatViolations(vs: Violation[]): string {
  return vs.map((v) => `${v.file}:${v.line}  [${v.rule}] ${v.message}`).join("\n");
}

function main(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const vs = runChecks(root);
  if (vs.length === 0) {
    console.log("check:boundaries OK (declared deps, allowed graph, no cycles, model ownership)");
    return;
  }
  console.error(`check:boundaries FAILED: ${vs.length} violation${vs.length === 1 ? "" : "s"}\n\n${formatViolations(vs)}\n`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();

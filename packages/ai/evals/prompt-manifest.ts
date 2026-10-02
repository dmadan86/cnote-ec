// Prompt manifest (ADR-008): every system prompt, its version string and the model ids, hashed and committed in
// prompts.manifest.json. CI fails when a prompt's text changes without a version bump, or when the manifest is stale,
// so a prompt or model change can never ship without a reviewed diff (and the eval gate that rides with it).
//
//   tsx evals/prompt-manifest.ts           check (exit 1 on drift)
//   tsx evals/prompt-manifest.ts --write   record the current state (refuses an unbumped prompt change; --force overrides)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface PromptSpec {
  id: string;
  file: string;
  /** const holding the prompt text (template literal or string) */
  const: string;
  /** where the version string lives: a const, or `CONST.key` for an object of versions */
  version: string;
}

/** Every Anthropic-facing prompt. Add new ones here; a test fails if a `*_SYSTEM`/`SYSTEM` const in src/ is missing. */
export const PROMPTS: PromptSpec[] = [
  { id: "intent", file: "src/anthropic.ts", const: "INTENT_SYSTEM", version: "PROMPT_VERSIONS.intent" },
  { id: "extract", file: "src/anthropic.ts", const: "EXTRACT_SYSTEM", version: "PROMPT_VERSIONS.extract" },
  { id: "extract_image", file: "src/anthropic.ts", const: "EXTRACT_IMAGE_SYSTEM", version: "PROMPT_VERSIONS.extractImage" },
  { id: "moderate", file: "src/anthropic.ts", const: "MODERATE_SYSTEM", version: "PROMPT_VERSIONS.moderate" },
  { id: "extract_document", file: "src/document.ts", const: "SYSTEM", version: "DOCUMENT_PROMPT_VERSION" },
  { id: "dispute_brief", file: "src/disputes.ts", const: "BRIEF_SYSTEM", version: "DISPUTE_PROMPT_VERSION.anthropic" },
  { id: "inspect_dispatch", file: "src/inspection.ts", const: "SYSTEM", version: "INSPECTION_PROMPT_VERSION" },
  { id: "draft_quote", file: "src/quotes.ts", const: "DRAFT_SYSTEM", version: "QUOTE_PROMPT_VERSIONS.draft" },
  { id: "normalise_quotes", file: "src/quotes.ts", const: "NORMALISE_SYSTEM", version: "QUOTE_PROMPT_VERSIONS.normalise" },
  { id: "propose_counter", file: "src/quotes.ts", const: "COUNTER_SYSTEM", version: "QUOTE_PROMPT_VERSIONS.counter" },
];

/** Files scanned for model id literals. */
export const MODEL_FILES = ["src/anthropic.ts", "src/document.ts", "src/disputes.ts", "src/inspection.ts", "src/quotes.ts", "src/registry.ts", "src/remote.ts"];

export interface ManifestEntry { id: string; version: string; sha256: string }
export interface Manifest { schema: 1; prompts: ManifestEntry[]; models: { ids: string[]; sha256: string } }

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Reads the string literal assigned to `const NAME =`, template literals and quoted strings alike. Returns null when absent. */
export function constString(src: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\n)(?:export\\s+)?const\\s+${name}\\s*=\\s*([\`"'])`).exec(src);
  if (!m) return null;
  const quote = m[1]!;
  let i = m.index + m[0].length;
  const start = i;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === quote) return src.slice(start, i);
    i++;
  }
  return null;
}

/** `NAME = "v"` or `NAME = { key: "v", ... }` + key. */
export function versionOf(src: string, spec: string): string | null {
  const [name, key] = spec.split(".") as [string, string | undefined];
  if (!key) return constString(src, name);
  const m = new RegExp(`const\\s+${name}\\s*=\\s*\\{([^}]*)\\}`).exec(src);
  const v = m && new RegExp(`\\b${key}\\s*:\\s*"([^"]+)"`).exec(m[1]!);
  return v ? v[1]! : null;
}

export function computeManifest(read: (file: string) => string): Manifest {
  const prompts = PROMPTS.map((p) => {
    const src = read(p.file);
    const text = constString(src, p.const);
    if (text === null) throw new Error(`prompt ${p.id}: const ${p.const} not found in ${p.file}`);
    const version = versionOf(src, p.version);
    if (version === null) throw new Error(`prompt ${p.id}: version ${p.version} not found in ${p.file}`);
    // The shared injection guard is interpolated into the prompt, so its text is part of the prompt.
    const guard = text.includes("${INJECTION_GUARD}") ? constString(src, "INJECTION_GUARD") ?? "" : "";
    return { id: p.id, version, sha256: sha(text + "\n--guard--\n" + guard) };
  });
  const ids = new Set<string>();
  for (const f of MODEL_FILES) for (const m of read(f).matchAll(/claude-[a-z0-9][a-z0-9.-]*[a-z0-9]/g)) ids.add(m[0]);
  const sorted = [...ids].sort();
  return { schema: 1, prompts, models: { ids: sorted, sha256: sha(sorted.join("\n")) } };
}

/** Problems to show the author; empty = the committed manifest matches the code. */
export function diffManifest(current: Manifest, committed: Manifest | null): string[] {
  if (!committed) return ["prompts.manifest.json is missing: run `pnpm --filter @cnote/ai eval:manifest --write`."];
  const problems: string[] = [];
  const old = new Map(committed.prompts.map((p) => [p.id, p]));
  for (const p of current.prompts) {
    const was = old.get(p.id);
    if (!was) problems.push(`prompt "${p.id}" is new: record it with eval:manifest --write, then run the AI evals.`);
    else if (was.sha256 !== p.sha256 && was.version === p.version) problems.push(`prompt "${p.id}" changed but its version is still "${p.version}": bump the version constant (ADR-008), run the AI evals, then eval:manifest --write.`);
    else if (was.sha256 !== p.sha256 || was.version !== p.version) problems.push(`prompt "${p.id}" changed (${was.version} -> ${p.version}): run the AI evals, then record it with eval:manifest --write.`);
    old.delete(p.id);
  }
  for (const id of old.keys()) problems.push(`prompt "${id}" is in the manifest but no longer in the code: eval:manifest --write.`);
  if (current.models.sha256 !== committed.models.sha256) {
    const added = current.models.ids.filter((m) => !committed.models.ids.includes(m));
    const removed = committed.models.ids.filter((m) => !current.models.ids.includes(m));
    problems.push(`model ids changed (added: ${added.join(", ") || "none"}; removed: ${removed.join(", ") || "none"}): run the AI evals against the new model, then eval:manifest --write.`);
  }
  return problems;
}

/** Prompts whose text changed while the version string did not: the one drift --write refuses to record. */
export function unbumped(current: Manifest, committed: Manifest | null): string[] {
  if (!committed) return [];
  const old = new Map(committed.prompts.map((p) => [p.id, p]));
  return current.prompts.filter((p) => { const w = old.get(p.id); return w && w.sha256 !== p.sha256 && w.version === p.version; }).map((p) => p.id);
}

const MANIFEST_PATH = new URL("../prompts.manifest.json", import.meta.url);

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const current = computeManifest((f) => readFileSync(root + f, "utf8"));
  let committed: Manifest | null = null;
  try { committed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest; } catch { /* missing */ }
  if (process.argv.includes("--write")) {
    const bad = unbumped(current, committed);
    if (bad.length && !process.argv.includes("--force")) { console.error(`Refusing to record: prompt text changed without a version bump for ${bad.join(", ")}.`); process.exit(1); }
    writeFileSync(MANIFEST_PATH, JSON.stringify(current, null, 2) + "\n");
    console.log("prompts.manifest.json updated.");
    return;
  }
  const problems = diffManifest(current, committed);
  if (problems.length) { console.error(["AI prompt/model gate (ADR-008):", ...problems.map((p) => `  - ${p}`)].join("\n")); process.exit(1); }
  console.log(`AI prompt manifest OK (${current.prompts.length} prompts, ${current.models.ids.length} model ids).`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

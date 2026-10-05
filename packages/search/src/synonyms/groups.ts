// Staff-editable synonym dictionary, pure part (ADR-004, ADR-009). DATA, not logic: the groups live in the database
// (store.ts), versioned, edited in the admin console. This file validates them, turns a query into extra lexical
// VARIANTS (same channel the built-in lexicon uses, so Postgres FTS and OpenSearch see identical expansions) and renders
// the OpenSearch synonym-filter lines. Deterministic and I/O free.

/** Every term in a group is interchangeable with the others, in any script ("kapda", "कपड़ा", "cloth", "fabric"). */
export interface SynonymGroup {
  terms: string[];
  note?: string;
}

export const MAX_GROUPS = 3000;
export const MAX_TERMS_PER_GROUP = 30;
export const MAX_TERM_LENGTH = 60;
/** Extra query strings a synonym match may add (on top of expandQuery's own cap). */
export const MAX_SYNONYM_VARIANTS = 4;
const MAX_VARIANT_LENGTH = 200;

/** Same folding as `normaliseQuery` (NFKC + lower-case), so a stored term and a normalised query compare equal. */
export const normaliseTerm = (t: string): string => t.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

const BAD_TERM = /[,\n\r\t|;=<>{}]/u;

export interface GroupsCheck {
  groups: SynonymGroup[];
  /** human-readable problems; the groups are only usable when this is empty */
  errors: string[];
}

/**
 * Normalises and validates staff input. A group needs at least two DISTINCT terms after folding; terms containing
 * separators or markup are rejected (they could not round-trip through the text editor or the Solr synonym format).
 * Identical groups are merged; a term may appear in several groups (the union applies).
 */
export function checkGroups(input: unknown): GroupsCheck {
  const errors: string[] = [];
  if (!Array.isArray(input)) return { groups: [], errors: ["The dictionary must be a list of groups."] };
  if (input.length > MAX_GROUPS) errors.push(`At most ${MAX_GROUPS} groups are allowed (got ${input.length}).`);
  const out: SynonymGroup[] = [];
  const seen = new Set<string>();
  input.slice(0, MAX_GROUPS).forEach((raw, i) => {
    const at = `Group ${i + 1}`;
    const terms = (raw as { terms?: unknown } | null)?.terms;
    if (!Array.isArray(terms)) return void errors.push(`${at}: missing terms.`);
    const clean: string[] = [];
    for (const t of terms) {
      if (typeof t !== "string") return void errors.push(`${at}: terms must be text.`);
      const n = normaliseTerm(t);
      if (!n) continue;
      if (n.length > MAX_TERM_LENGTH) return void errors.push(`${at}: "${n.slice(0, 20)}..." is longer than ${MAX_TERM_LENGTH} characters.`);
      if (BAD_TERM.test(n)) return void errors.push(`${at}: "${n}" contains a character that is not allowed (, | ; = < > { } or a line break).`);
      if (!clean.includes(n)) clean.push(n);
    }
    if (clean.length < 2) return void errors.push(`${at}: needs at least two different terms.`);
    if (clean.length > MAX_TERMS_PER_GROUP) return void errors.push(`${at}: at most ${MAX_TERMS_PER_GROUP} terms per group.`);
    const key = [...clean].sort().join("\u0000");
    if (seen.has(key)) return;
    seen.add(key);
    const note = typeof (raw as { note?: unknown }).note === "string" ? (raw as { note: string }).note.trim().slice(0, 200) : "";
    out.push({ terms: clean, ...(note ? { note } : {}) });
  });
  return { groups: out, errors };
}

/**
 * Editor format, one group per line: `kapda, कपड़ा, cloth, fabric   # optional note`. Blank lines and lines starting
 * with `#` are ignored. Solr one-way rules (`a, b => c`) are accepted and read as equivalence (see parseSolr for why).
 */
export function parseGroupsText(text: string): SynonymGroup[] {
  const out: SynonymGroup[] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    const hash = l.indexOf("#");
    const body = (hash >= 0 ? l.slice(0, hash) : l).trim();
    const note = hash >= 0 ? l.slice(hash + 1).trim() : "";
    out.push({ terms: body.split(/=>|,/).map((t) => t.trim()), ...(note ? { note } : {}) });
  }
  return out;
}

export function formatGroupsText(groups: SynonymGroup[]): string {
  return groups.map((g) => `${g.terms.join(", ")}${g.note ? `   # ${g.note}` : ""}`).join("\n");
}

/**
 * Reads the OpenSearch/Solr synonym file shipped with the repo (`synonyms/hinglish-b2b.txt`). Its `a, b => c` rules are
 * imported as equivalence groups: at QUERY time we only add variants (never rewrite), so the one-way direction would
 * only matter for index-time expansion, which the file's own consumer (the OpenSearch filter) keeps doing.
 */
export function parseSolr(text: string): SynonymGroup[] {
  return parseGroupsText(text.split(/\r?\n/).filter((l) => !l.trim().startsWith("#")).join("\n"));
}

/** Solr `synonym_graph` lines (equivalence rules) for the OpenSearch index analyzer: `kapda, कपड़ा, cloth`. */
export function toSolrLines(groups: SynonymGroup[]): string[] {
  return groups.map((g) => g.terms.join(", "));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const B = "(?<![\\p{L}\\p{M}\\p{N}])";
const E = "(?![\\p{L}\\p{M}\\p{N}])";

/** Whole-term regex; Latin terms also match a trailing plural "s"/"es" ("fabrics", "boxes") like the built-in lexicon. */
function termRegex(term: string): RegExp {
  const latin = /^[\x00-\x7f]+$/.test(term);
  return new RegExp(`${B}${escapeRe(term)}${latin ? "(?:e?s)?" : ""}${E}`, "gu");
}

/**
 * Extra lexical query strings from the dictionary. For each group with a term inside `text` (a whole word or phrase,
 * any script) the matched span is replaced by the group's other terms, one substitution at a time, Latin-script
 * alternatives first (so the embedding, which only understands Latin, gets the useful one). The original text is never
 * returned. Capped by `max`, deterministic: groups in dictionary order, longest matching term first.
 */
export function synonymVariants(text: string, groups: SynonymGroup[], max = MAX_SYNONYM_VARIANTS): string[] {
  const src = normaliseTerm(text);
  if (!src || !groups.length || max <= 0) return [];
  const out: string[] = [];
  const isLatin = (s: string) => /^[\x00-\x7f]+$/.test(s);
  for (const g of groups) {
    const hit = [...g.terms].sort((a, b) => b.length - a.length).find((t) => termRegex(t).test(src));
    if (!hit) continue;
    const re = termRegex(hit);
    const alternatives = [...g.terms.filter((t) => t !== hit)].sort((a, b) => Number(isLatin(b)) - Number(isLatin(a)));
    for (const alt of alternatives) {
      const variant = src.replace(re, alt).replace(/\s+/g, " ").trim().slice(0, MAX_VARIANT_LENGTH);
      if (variant && variant !== src && !out.includes(variant)) out.push(variant);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Built-in variants first would bury staff-curated ones in the cap, so curated ones lead; duplicates dropped. */
export function mergeVariants(curated: string[], builtIn: string[], max: number): string[] {
  const out: string[] = [];
  for (const v of [...curated, ...builtIn]) if (v && !out.includes(v)) out.push(v);
  return out.slice(0, max);
}

import type { ExtractListingInput, ExtractListingOutput } from "../index";
import { normalizeUnit, tokenize } from "../text";
import type { ProviderResult } from "../types";
import { HEURISTIC_MODEL } from "./intent";

export const EXTRACT_HEURISTIC_VERSION = "extract-heuristic-v1";

interface Field { key: string; label: string; type: string; unit?: string; options?: string[] }

/** Tolerant reader for the catalogue attributeSchema ({ fields: [...] }). */
export function schemaFields(schema: unknown): Field[] {
  const raw = (schema as { fields?: unknown })?.fields;
  if (!Array.isArray(raw)) return [];
  return raw.filter((f): f is Field => !!f && typeof f.key === "string").map((f) => ({ ...f, label: f.label || f.key }));
}

const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;
const toNum = (s: string) => Number(s.replace(/,/g, ""));

const PRICE_PATTERNS: RegExp[] = [
  new RegExp(String.raw`(?:₹|\brs\.?|\binr|\brupees?)\s*${NUM}(?:\s*(?:/|per|a|each)\s*([a-zA-Z]+))?`, "i"),
  new RegExp(String.raw`\b(?:price|rate|bhav|rate)\s*[:\-]?\s*${NUM}(?:\s*(?:/|per)\s*([a-zA-Z]+))?`, "i"),
  new RegExp(String.raw`${NUM}\s*(?:rs|₹|rupees)?\s*(?:/|per)\s*([a-zA-Z]+)`, "i"),
];

function parsePrice(text: string): { paise: number; unit: string | null } | null {
  for (const re of PRICE_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const n = toNum(m[1]!);
    if (!Number.isFinite(n) || n <= 0) continue;
    const unit = normalizeUnit(m[2]);
    // third pattern needs a real unit, otherwise "10/12 inch"-style specs would match
    if (re === PRICE_PATTERNS[2] && !unit) continue;
    return { paise: Math.round(n * 100), unit };
  }
  return null;
}

const MOQ_RE = new RegExp(
  String.raw`\b(?:moq|min(?:imum)?\.?(?:\s+order)?(?:\s+(?:qty|quantity))?)\s*[:\-]?\s*${NUM}\s*([a-zA-Z]+)?`, "i");

const HSN_RE = /\bhsn(?:\s{0,4}(?:code|no\.?))?\s{0,4}[:\-]?\s{0,4}(\d{4,8})\b/i;

const FILLER = /^(?:hello|hi|namaste|we|i|mere paas|hamare paas)?\s*(?:sell|selling|supply|supplying|manufacture|manufacturing|offer|offering|have|available|deal in|dealing in|mil jayega|hai)\b[:\s-]*/i;

function titleCase(s: string): string {
  return s.replace(/\S+/g, (w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()));
}

function pickCategory(text: string, cats: ExtractListingInput["categories"]): string | null {
  const tt = new Set(tokenize(text));
  let best: { slug: string; hits: number; cover: number } | null = null;
  for (const c of cats) {
    const ct = [...new Set(tokenize(`${c.name} ${c.slug.replace(/-/g, " ")}`))];
    if (!ct.length) continue;
    const hits = ct.filter((t) => tt.has(t)).length;
    const cover = hits / ct.length;
    if (hits && cover >= 0.5 && (!best || hits > best.hits || (hits === best.hits && cover > best.cover))) best = { slug: c.slug, hits, cover };
  }
  return best?.slug ?? null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const STOP_WORDS = "with|and|min|minimum|moq|price|rate|hsn|at|rs|per|for|available|hai";
const namesOf = (f: Field) => [...new Set([f.label, f.key.replace(/_/g, " ")].map((n) => n.toLowerCase()))].map(esc);

function extractAttributes(text: string, fields: Field[]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const f of fields) {
    const names = namesOf(f).join("|");
    // a text value ends where the next field label or a stop word begins
    const stop = new RegExp(String.raw`\s+(?:${[STOP_WORDS, ...fields.filter((o) => o !== f).flatMap(namesOf)].join("|")})\b.*$`, "i");
    const units = f.unit ? `|${esc(f.unit)}` : "";
    if (f.type === "select" && f.options?.length) {
      const opt = f.options.find((o) => new RegExp(String.raw`(?<![\p{L}\p{N}])${esc(o)}(?![\p{L}\p{N}])`, "iu").test(text));
      if (opt) out[f.key] = opt;
      continue;
    }
    if (f.type === "number") {
      // "5 ply" beats "ply 150": a number directly before the label belongs to it
      const m =
        text.match(new RegExp(String.raw`(?<![\p{L}\d.])(\d+(?:\.\d+)?)\s*(?:${names}${units})\b`, "iu")) ??
        text.match(new RegExp(String.raw`\b(?:${names})\s*[:=\-]?\s*(\d+(?:\.\d+)?)`, "i"));
      if (m) out[f.key] = Number(m[1]);
      continue;
    }
    const m = text.match(new RegExp(String.raw`\b(?:${names})\s*[:=\-]?\s*([\p{L}\p{N}.\-]+(?:\s+[\p{L}\p{N}.\-]+){0,2})`, "iu"));
    if (m) {
      const v = m[1]!.replace(stop, "").trim();
      if (v) out[f.key] = v;
    }
  }
  return out;
}

export function extractListingHeuristic(input: ExtractListingInput): ProviderResult<ExtractListingOutput> {
  const text = input.text.trim();
  const price = parsePrice(text);
  const moqM = text.match(MOQ_RE);
  const moq = moqM ? toNum(moqM[1]!) : null;
  const moqUnit = moqM ? normalizeUnit(moqM[2]) : null;
  const hsn = text.match(HSN_RE)?.[1] ?? null;
  const categorySlug = pickCategory(text, input.categories);
  const cat = input.categories.find((c) => c.slug === categorySlug);
  const attributes = cat ? extractAttributes(text, schemaFields(cat.attributeSchema)) : {};

  // Title: first clause with price/MOQ/HSN fragments and "we sell"-style filler removed.
  const clauses = text.replace(/^(?:hello|hi|namaste|dear sir)\b[\s,!.]*/i, "").split(/[,;\n|]|\.(?!\d)|\s[-–]\s/).map((c) => c.trim()).filter(Boolean);
  const clean = (c: string) =>
    c.replace(new RegExp(PRICE_PATTERNS[0]!.source, "gi"), "").replace(MOQ_RE, "").replace(HSN_RE, "")
      .replace(FILLER, "").replace(/\s+/g, " ").trim();
  let ti = clauses.findIndex((c) => clean(c).length >= 3);
  if (ti < 0) ti = 0;
  const title = titleCase(clean(clauses[ti] ?? text).slice(0, 80) || text.slice(0, 60));
  const rest = clauses.filter((_, i) => i !== ti).join(". ");
  const description = rest || text;

  let confidence = 0.3;
  if (categorySlug) confidence += 0.25;
  if (price) confidence += 0.2;
  if (moq) confidence += 0.1;
  if (Object.keys(attributes).length) confidence += 0.1;
  if (hsn) confidence += 0.05;
  return {
    output: {
      title, description, categorySlug, attributes,
      pricePaise: price?.paise ?? null, priceUnit: price?.unit ?? null,
      moq: moq && Number.isFinite(moq) ? moq : null, moqUnit, hsn,
    },
    confidence: Math.min(0.95, Math.round(confidence * 100) / 100),
    provider: "heuristic",
    modelId: HEURISTIC_MODEL,
    promptVersion: EXTRACT_HEURISTIC_VERSION,
  };
}

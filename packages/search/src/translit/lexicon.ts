// Indexes the lexicon data (lexicon-data.ts) for O(1) lookup from any surface form. Pure; built once at module load.
import { LEXICON_COLUMNS, LEXICON_ROWS } from "./lexicon-data";

export type LexColumn = (typeof LEXICON_COLUMNS)[number];
export interface LexEntry {
  /** canonical English term (first English form) */
  canonical: string;
  /** every form per column, NFC-normalised, lower-cased for Latin columns */
  forms: Record<LexColumn, string[]>;
}

const nfc = (s: string) => s.normalize("NFC").trim();

/** Parses the row text. Exported for tests; the module-level `LEXICON` is what callers use. */
export function parseLexicon(text: string): LexEntry[] {
  const out: LexEntry[] = [];
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    const cols = l.split(";").map((c) => c.trim());
    const forms = {} as Record<LexColumn, string[]>;
    LEXICON_COLUMNS.forEach((name, i) => {
      const latin = name === "en" || name === "hinglish";
      forms[name] = (cols[i] ?? "").split("|").map((f) => (latin ? f.trim().toLowerCase() : nfc(f))).filter(Boolean);
    });
    if (!forms.en.length) continue;
    out.push({ canonical: forms.en[0]!, forms });
  }
  return out;
}

export const LEXICON: readonly LexEntry[] = parseLexicon(LEXICON_ROWS);

/** surface form -> entry. First row wins when a form is shared (rows are ordered by importance/commonness). */
const INDEX = new Map<string, LexEntry>();
for (const e of LEXICON) for (const col of LEXICON_COLUMNS) for (const f of e.forms[col]) if (!INDEX.has(f)) INDEX.set(f, e);

// Devanagari chandrabindu/anusvara spellings are interchangeable in everyday typing (गेहूँ / गेहूं).
const foldNasal = (s: string) => s.replace(/ँ/g, "ं");
for (const [k, e] of [...INDEX]) if (/ँ/.test(k) && !INDEX.has(foldNasal(k))) INDEX.set(foldNasal(k), e);

/** Light plural/oblique handling for Latin lookups: "boxes" -> "box", "tiles" -> "tile". */
function latinCandidates(t: string): string[] {
  const c = [t];
  if (t.length > 3 && t.endsWith("ies")) c.push(t.slice(0, -3) + "y");
  if (t.length > 3 && t.endsWith("es")) c.push(t.slice(0, -2));
  if (t.length > 2 && t.endsWith("s")) c.push(t.slice(0, -1));
  return c;
}

/** Entry for a token of any script, or null. Latin tokens are case-insensitive and plural-tolerant. */
export function lookup(token: string): LexEntry | null {
  const t = nfc(token);
  if (!t) return null;
  const lower = t.toLowerCase();
  if (/^[\x00-\x7f]+$/.test(lower)) {
    for (const c of latinCandidates(lower)) {
      const e = INDEX.get(c);
      if (e) return e;
    }
    return null;
  }
  return INDEX.get(t) ?? INDEX.get(foldNasal(t)) ?? null;
}

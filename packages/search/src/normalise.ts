// Query normalisation for Hinglish/English buyer queries (ADR-009). Pure; no I/O.
export interface NormalisedQuery {
  /** Cleaned text used for lexical + embedding. */
  text: string;
  /** Soft city hint ("in Tiruppur"), lowercased; null when absent. Boosts, never filters. */
  location: string | null;
}

// Longest first so "ke liye" wins over shorter overlaps. Whole-word, unicode-aware.
const FILLERS = [
  "suppliers in", "supplier in", "manufacturers in", "manufacturer in", "looking for", "ke liye", "ke lie", "ke liy",
  "chahiye", "chahie", "chahiya", "chaiye", "wala", "wali", "wale", "mujhe", "hume", "humein", "need", "want", "please", "pls", "plz",
  // Devanagari (Hindi/Marathi) fillers, so "मुझे कपास चाहिए" searches for "कपास"
  "के लिए", "चाहिए", "चाहिये", "चहिए", "मुझे", "हमें", "कृपया", "वाला", "वाली", "वाले", "पाहिजे", "हवे", "का", "की", "के", "में", "से", "को",
];
// "in <words>" at the end: up to 2 words. Generic tails are not places and must stay in the query.
const NOT_A_PLACE = new Set(["bulk", "stock", "quantity", "wholesale", "large", "small", "all", "general", "demand", "wholesales", "retail", "different", "various"]);
const COUNTRY = new Set(["india", "bharat"]);
const PUNCT_RE = /[^\p{L}\p{M}\p{N}\s\-+&/.']/gu;
const LOC_RE = /(?<![\p{L}\p{M}\p{N}])(?:in|near|at|from)\s+([\p{L}\p{M}]+(?:\s[\p{L}\p{M}]+)?)\s*$/u;
const WORD = "(?<![\\p{L}\\p{M}\\p{N}])"; // \p{M}: Indic vowel signs are marks, not letters
const WORD_END = "(?![\\p{L}\\p{M}\\p{N}])";
const FILLER_RE = new RegExp(`${WORD}(?:${FILLERS.map((f) => f.replace(/ /g, "\\s+")).join("|")})${WORD_END}`, "gu");

export function normaliseQuery(raw: string): NormalisedQuery {
  // Strip punctuation BEFORE the location match, so a second pass sees the same tokens (idempotence: "in:A" used to leave
  // "in a", which the next pass then parsed as a location).
  let s = raw.normalize("NFKC").toLowerCase().replace(PUNCT_RE, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  let location: string | null = null;

  const m = LOC_RE.exec(s);
  if (m) {
    const place = m[1]!;
    if (COUNTRY.has(place)) s = s.slice(0, m.index).trim(); // "in India": drop, nothing to boost
    else if (!place.split(" ").some((w) => NOT_A_PLACE.has(w))) {
      location = place;
      s = s.slice(0, m.index).trim();
    }
  }
  const cleaned = s.replace(FILLER_RE, " ").replace(/\s+/g, " ").trim();
  return { text: cleaned || s, location };
}

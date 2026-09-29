// Text normalisation shared by the local embedder and the heuristic providers.

/** Canonical unit names. `strict` aliases are safe to rewrite anywhere in free text. */
const UNIT_GROUPS: Record<string, { strict: string[]; loose: string[] }> = {
  piece: { strict: ["pcs", "pc", "pieces", "piece", "nos", "numbers", "units", "unit", "nag"], loose: ["no", "each", "ea"] },
  meter: { strict: ["mtr", "mtrs", "meters", "metres", "meter", "metre"], loose: ["m"] },
  kg: { strict: ["kg", "kgs", "kilogram", "kilograms", "kilo", "kilos"], loose: [] },
  gram: { strict: ["gm", "gms", "gram", "grams"], loose: ["g"] },
  ton: { strict: ["ton", "tons", "tonne", "tonnes", "mt"], loose: [] },
  liter: { strict: ["ltr", "ltrs", "litre", "litres", "liter", "liters"], loose: ["l"] },
  set: { strict: ["set", "sets"], loose: [] },
  dozen: { strict: ["dozen", "doz", "dz"], loose: [] },
  pair: { strict: ["pair", "pairs"], loose: [] },
  roll: { strict: ["roll", "rolls"], loose: [] },
  bag: { strict: ["bag", "bags"], loose: [] },
  box: { strict: [], loose: ["box", "boxes"] },
  sqft: { strict: ["sqft"], loose: [] },
  sqm: { strict: ["sqm"], loose: [] },
  inch: { strict: ["inch", "inches"], loose: [] },
};

const STRICT_UNIT = new Map<string, string>();
const ANY_UNIT = new Map<string, string>();
for (const [canon, { strict, loose }] of Object.entries(UNIT_GROUPS)) {
  for (const a of strict) { STRICT_UNIT.set(a, canon); ANY_UNIT.set(a, canon); }
  for (const a of loose) ANY_UNIT.set(a, canon);
}

/** Canonical unit for a token, or null if it isn't a unit. */
export function normalizeUnit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return ANY_UNIT.get(raw.toLowerCase().replace(/[.\s]/g, "")) ?? null;
}

/** Hinglish/Hindi transliterations and B2B synonyms → one canonical English token. */
const SYNONYMS: Record<string, string> = {
  dabba: "box", dabbe: "box", dibba: "box", डिब्बा: "box", डिब्बे: "box", boxes: "box",
  gatta: "carton", gatte: "carton", gata: "carton", गत्ता: "carton", गत्ते: "carton", cartons: "carton", corrugated: "carton",
  kapda: "fabric", kapde: "fabric", कपड़ा: "fabric", कपड़े: "fabric", cloth: "fabric", textile: "fabric", fabrics: "fabric",
  boriya: "sack", bori: "sack", boria: "sack", बोरी: "sack", बोरिया: "sack", sacks: "sack",
  thaila: "bag", thele: "bag", थैला: "bag", थैले: "bag",
  kagaz: "paper", kagad: "paper", कागज: "paper", कागज़: "paper",
  plastik: "plastic", प्लास्टिक: "plastic",
  loha: "iron", लोहा: "iron", lohe: "iron",
  dhaga: "thread", धागा: "thread",
  chawal: "rice", चावल: "rice",
  aata: "flour", atta: "flour", आटा: "flour",
  cheeni: "sugar", chini: "sugar", चीनी: "sugar",
  tel: "oil", तेल: "oil",
  rang: "paint", रंग: "paint",
  bijli: "electric", बिजली: "electric",
  mashin: "machine", machin: "machine", मशीन: "machine",
  sasta: "cheap", saste: "cheap",
  packing: "pack", packaging: "pack", packages: "pack", package: "pack",
  rupees: "rupee", rupaye: "rupee", rs: "rupee", inr: "rupee", "₹": "rupee",
};

const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "and", "or", "to", "in", "on", "with", "is", "are", "we", "i", "our", "your",
  "need", "needed", "required", "require", "want", "looking", "please", "pls", "supply", "buy", "chahiye", "chahie", "hai", "hain",
  "ka", "ki", "ke", "ko", "se", "mein", "me", "aur", "चाहिए", "है", "का", "की", "के", "और", "से", "में",
]);

function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (/(x|ch|sh|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** lowercase → strip punctuation → split digit/letter runs → units/synonyms/stemming → drop stopwords. */
export function tokenize(text: string): string[] {
  let t = text.normalize("NFKC").toLowerCase().replace(/₹/g, " rupee ");
  t = t.replace(/sq\.?\s*ft\b/g, "sqft").replace(/sq\.?\s*(?:m|mtr|meter)s?\b/g, "sqm");
  t = t.replace(/([0-9])([a-zऀ-ॿ])/g, "$1 $2").replace(/([a-zऀ-ॿ])([0-9])/g, "$1 $2");
  // keep letters (incl. Devanagari marks) and digits only
  t = t.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ");
  const out: string[] = [];
  for (const raw of t.split(" ")) {
    if (!raw) continue;
    let w = SYNONYMS[raw] ?? raw;
    const unit = STRICT_UNIT.get(w);
    if (unit) w = unit;
    else if (!SYNONYMS[raw]) w = stem(w);
    w = SYNONYMS[w] ?? w;
    if (STOPWORDS.has(w)) continue;
    out.push(w);
  }
  return out;
}

export function normalizeText(text: string): string {
  return tokenize(text).join(" ");
}

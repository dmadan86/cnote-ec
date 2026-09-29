// Name/PAN helpers for GST verification (pure, unit-tested).

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const CIN_RE = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;
/** LLP identification number */
export const LLPIN_RE = /^[A-Z]{3}-[0-9]{4}$/;

/** Chars 3–12 of a GSTIN are the holder's PAN. */
export const panFromGstin = (gstin: string): string => gstin.slice(2, 12).toUpperCase();

/** "ABCDE1234F" → "XXXXX1234F" */
export const maskPan = (pan: string | null | undefined): string | null => (pan ? `XXXXX${pan.slice(5)}` : null);

// Order matters: longer phrases first.
const SUFFIXES = [
  "private limited", "pvt ltd", "pvt limited", "p ltd", "public limited", "limited liability partnership", "llp", "limited", "ltd",
  "and company", "and co", "co", "company", "opc", "one person company", "proprietor", "prop", "india",
];

/** lower-case, strip M/S prefix, company-form suffixes and punctuation; "&" → "and". */
export function normaliseName(raw: string): string {
  let s = raw.toLowerCase().replace(/&/g, " and ").replace(/[.,'"()\-_/\\]/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^(m\s?\/?\s?s|messrs)\s+/, "").trim();
  for (const suf of SUFFIXES) {
    const re = new RegExp(`(^|\\s)${suf}$`);
    while (re.test(s) && s.length > suf.length + 1) s = s.replace(re, "").trim();
  }
  return s.replace(/\bp\s+ltd\b/g, "").replace(/\s+/g, " ").trim();
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}
const tokenSim = (a: string, b: string) => (a === b ? 1 : 1 - levenshtein(a, b) / Math.max(a.length, b.length));

/**
 * Token-set similarity in [0,1]: greedily pairs tokens (exact or ≥0.8 fuzzy), score = 2·matched / (|A|+|B|).
 * Order-insensitive ("Sharma Steel" ≈ "Steel Sharma").
 */
export function nameSimilarity(a: string, b: string): number {
  const ta = normaliseName(a).split(" ").filter(Boolean);
  const tb = normaliseName(b).split(" ").filter(Boolean);
  if (ta.length === 0 || tb.length === 0) return 0;
  const used = new Set<number>();
  let matched = 0;
  for (const x of ta) {
    let best = -1, bestSim = 0;
    tb.forEach((y, i) => {
      if (used.has(i)) return;
      const sim = tokenSim(x, y);
      if (sim > bestSim) { bestSim = sim; best = i; }
    });
    if (best >= 0 && bestSim >= 0.8) { used.add(best); matched += bestSim; }
  }
  return (2 * matched) / (ta.length + tb.length);
}

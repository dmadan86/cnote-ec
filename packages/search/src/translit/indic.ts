// Rule-based Indic <-> Latin transliteration (ADR-004 Bharat-native, ADR-009). Pure, deterministic, dependency-free.
//
// Design: every supported Brahmic script (Devanagari, Bengali, Gujarati, Tamil, Telugu, Kannada) shares the ISCII
// code-point layout, so a character maps to its Devanagari-equivalent by a block offset and ONE consonant/vowel table
// (ISO 15919-ish) serves all six. Output comes in two layers:
//   - `toRoman`      strict, diacritic-bearing, schwa-explicit, reversible for Devanagari (see `fromRoman`)
//   - `colloquial`   the ASCII spellings buyers actually type ("kapda", "dhaga"), as a small set of variants
// Indo-Aryan scripts (hi, mr, gu, bn) get schwa deletion in the colloquial layer; Dravidian ones (kn, ta, te) do not.

export type IndicScript = "deva" | "beng" | "gujr" | "taml" | "telu" | "knda";

const BLOCKS: Record<IndicScript, number> = { deva: 0x0900, beng: 0x0980, gujr: 0x0a80, taml: 0x0b80, telu: 0x0c00, knda: 0x0c80 };
const BLOCK_LEN = 0x80;
const DEVA = 0x0900;

/** Script of a single code point, or null for anything that is not one of the six supported Indic scripts. */
export function scriptOf(ch: string): IndicScript | null {
  const cp = ch.codePointAt(0)!;
  for (const [s, base] of Object.entries(BLOCKS) as [IndicScript, number][]) if (cp >= base && cp < base + BLOCK_LEN) return s;
  return null;
}

/** Dominant Indic script of a string (by letter count), or null when it has no Indic letters. */
export function detectScript(text: string): IndicScript | null {
  const counts = new Map<IndicScript, number>();
  for (const ch of text) {
    const s = scriptOf(ch);
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best: IndicScript | null = null;
  let n = 0;
  for (const [s, c] of counts) if (c > n) [best, n] = [s, c];
  return best;
}

export const hasIndic = (text: string): boolean => detectScript(text) !== null;

/** Indo-Aryan scripts drop the inherent "a" in speech (कपड़ा -> kapda); Dravidian ones keep it (ಬಟ್ಟೆ -> baṭṭe). */
const SCHWA_DELETING: ReadonlySet<IndicScript> = new Set(["deva", "beng", "gujr"]);

/** Devanagari-equivalent code point. Bengali khanda-ta (U+09CE) has no Devanagari twin: it is a bare "t". */
function toDevaCp(cp: number, script: IndicScript): number {
  return cp - BLOCKS[script] + DEVA;
}

// ---- ISO 15919-ish tables, keyed by Devanagari-equivalent code point ----------------------------------------------------
const VOWEL: Record<number, string> = {
  0x905: "a", 0x906: "ā", 0x907: "i", 0x908: "ī", 0x909: "u", 0x90a: "ū", 0x90b: "r̥", 0x90c: "l̥", 0x90d: "ê", 0x90e: "e", 0x90f: "ē",
  0x910: "ai", 0x911: "ô", 0x912: "o", 0x913: "ō", 0x914: "au",
};
const MATRA: Record<number, string> = {
  0x93e: "ā", 0x93f: "i", 0x940: "ī", 0x941: "u", 0x942: "ū", 0x943: "r̥", 0x944: "r̥̄", 0x945: "ê", 0x946: "e", 0x947: "ē",
  0x948: "ai", 0x949: "ô", 0x94a: "o", 0x94b: "ō", 0x94c: "au",
};
const CONS: Record<number, string> = {
  0x915: "k", 0x916: "kh", 0x917: "g", 0x918: "gh", 0x919: "ṅ", 0x91a: "c", 0x91b: "ch", 0x91c: "j", 0x91d: "jh", 0x91e: "ñ",
  0x91f: "ṭ", 0x920: "ṭh", 0x921: "ḍ", 0x922: "ḍh", 0x923: "ṇ", 0x924: "t", 0x925: "th", 0x926: "d", 0x927: "dh", 0x928: "n", 0x929: "ṉ",
  0x92a: "p", 0x92b: "ph", 0x92c: "b", 0x92d: "bh", 0x92e: "m", 0x92f: "y", 0x930: "r", 0x931: "ṟ", 0x932: "l", 0x933: "ḷ", 0x934: "ḻ",
  0x935: "v", 0x936: "ś", 0x937: "ṣ", 0x938: "s", 0x939: "h",
};
// Precomposed nukta letters (U+0958..095F); NFC decomposes them (composition exclusion), the table still covers NFD-free input.
const NUKTA_PRECOMPOSED: Record<number, string> = { 0x958: "q", 0x959: "x", 0x95a: "ġ", 0x95b: "z", 0x95c: "ṛ", 0x95d: "ṛh", 0x95e: "f", 0x95f: "y" };
const NUKTA_OF: Record<number, string> = { 0x915: "q", 0x916: "x", 0x917: "ġ", 0x91c: "z", 0x921: "ṛ", 0x922: "ṛh", 0x92b: "f", 0x92f: "y" };
const VIRAMA = 0x94d;
const NUKTA = 0x93c;
const ANUSVARA = 0x902;
const CANDRABINDU = 0x901;
const VISARGA = 0x903;
const AVAGRAHA = 0x93d;

const isConsCp = (c: number) => (c >= 0x915 && c <= 0x939) || (c >= 0x958 && c <= 0x95f);

// ---- Parse to units ----------------------------------------------------------------------------------------------------
/** C = consonant (roman), V = vowel (roman; `inherent` when it is the implicit "a"), M = nasal/visarga mark, X = other. */
type Unit = { t: "C"; r: string } | { t: "V"; r: string; inherent?: boolean } | { t: "M"; r: string } | { t: "X"; r: string };

/** Splits a run of Indic letters (possibly several scripts) into units. Non-Indic characters pass through as X. */
function parseUnits(word: string): Unit[] {
  const chars = [...word];
  const out: Unit[] = [];
  let pending = false; // a consonant has been emitted and its vowel is still open (inherent "a" unless a matra/virama follows)
  const flush = () => {
    if (pending) out.push({ t: "V", r: "a", inherent: true });
    pending = false;
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const script = scriptOf(ch);
    if (!script) {
      flush();
      out.push({ t: "X", r: ch });
      continue;
    }
    const raw = ch.codePointAt(0)!;
    if (script === "beng" && raw === 0x09ce) {
      flush();
      out.push({ t: "C", r: "t" });
      continue; // khanda ta: consonant with no vowel
    }
    const cp = toDevaCp(raw, script);
    if (isConsCp(cp)) {
      flush();
      // combining nukta directly after a base consonant
      const nextIsNukta = chars[i + 1] !== undefined && scriptOf(chars[i + 1]!) && toDevaCp(chars[i + 1]!.codePointAt(0)!, scriptOf(chars[i + 1]!)!) === NUKTA;
      const pre = NUKTA_PRECOMPOSED[cp];
      if (pre) out.push({ t: "C", r: pre });
      else if (nextIsNukta && NUKTA_OF[cp]) {
        out.push({ t: "C", r: NUKTA_OF[cp]! });
        i++;
      } else out.push({ t: "C", r: script === "beng" && cp === 0x92f ? "j" : (CONS[cp] ?? "") }); // Bengali য is pronounced "j"
      pending = true;
    } else if (MATRA[cp] !== undefined) {
      if (pending) pending = false; // matra replaces the inherent vowel
      out.push({ t: "V", r: MATRA[cp]! });
    } else if (cp === VIRAMA) {
      pending = false; // no vowel: cluster / dead consonant
    } else if (VOWEL[cp] !== undefined) {
      flush();
      out.push({ t: "V", r: VOWEL[cp]! });
    } else if (cp === ANUSVARA) {
      flush();
      out.push({ t: "M", r: "ṃ" });
    } else if (cp === CANDRABINDU) {
      flush();
      out.push({ t: "M", r: "ṁ" });
    } else if (cp === VISARGA) {
      flush();
      out.push({ t: "M", r: "ḥ" });
    } else if (cp === AVAGRAHA || cp === NUKTA) {
      // stray nukta / avagraha: no sound of its own
    } else {
      flush();
      // Indic digits, danda, ZWJ etc: keep a stable ASCII rendering for digits, drop the rest
      const digit = (cp >= 0x966 && cp <= 0x96f) ? String(cp - 0x966) : "";
      if (digit) out.push({ t: "X", r: digit });
    }
  }
  flush();
  return out.filter((u) => u.t !== "C" || u.r !== "");
}

/** Digraph collisions: consonant + h (or vowel + vowel) would read as a single letter, so strict output marks the seam with "·". */
const SEAM_BEFORE_H = new Set(["k", "g", "c", "j", "ṭ", "ḍ", "t", "d", "p", "b", "s", "z", "ṛ", "ch"]);
function joinStrict(units: Unit[]): string {
  let s = "";
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    const prev = units[i - 1];
    if (prev && prev.t === "C" && u.t === "C" && u.r === "h" && SEAM_BEFORE_H.has(prev.r)) s += "·";
    if (prev && prev.t === "V" && u.t === "V") s += "·"; // an independent vowel right after a vowel: keep the two letters apart
    s += u.r;
  }
  return s;
}

/** Strict ISO 15919-ish romanisation with the inherent vowel written out ("kapāsa"). Reversible via `fromRoman` for Devanagari. */
export function toRoman(text: string): string {
  return splitRuns(clean(text))
    .map((run) => (run.indic ? joinStrict(parseUnits(run.text)) : run.text))
    .join("")
    .normalize("NFC");
}

/** NFC, and ZWJ/ZWNJ (conjunct hints) dropped: they carry no sound. */
const clean = (text: string) => text.replace(/[\u200c\u200d]/g, "").normalize("NFC");

function splitRuns(text: string): { text: string; indic: boolean }[] {
  const runs: { text: string; indic: boolean }[] = [];
  for (const ch of text) {
    const indic = scriptOf(ch) !== null || (ch === "‍" || ch === "‌" ? false : false);
    const last = runs[runs.length - 1];
    if (last && last.indic === indic) last.text += ch;
    else runs.push({ text: ch, indic });
  }
  return runs;
}

// ---- Colloquial (ASCII) layer ------------------------------------------------------------------------------------------
export interface ColloquialOptions {
  /** delete inherent "a" where speech does (Indo-Aryan) */
  schwaDeletion: boolean;
  /** spell long vowels doubled (aa/ee/oo) instead of plain */
  longVowels: boolean;
  /** v -> w (Hindi speakers type "chawal", "sawal") */
  vAsW: boolean;
  /** ड़ ढ़ as "r" instead of "d" */
  flapAsR: boolean;
  /** Tamil-style intervocalic voicing k/c/ṭ/t/p -> g/j/ḍ/d/b */
  voicing: boolean;
}

const FOLD: Record<string, string> = {
  ā: "a", ī: "i", ū: "u", "r̥": "ri", "l̥": "li", "r̥̄": "ri", ê: "e", ē: "e", ô: "o", ō: "o", ṅ: "n", ñ: "n", ṭ: "t", ṭh: "th", ḍ: "d", ḍh: "dh", ṇ: "n", ṉ: "n",
  ṟ: "r", ḷ: "l", ḻ: "zh", ś: "sh", ṣ: "sh", c: "ch", ch: "chh", ṛ: "d", ṛh: "dh", q: "k", x: "kh", ġ: "g", ṃ: "n", ṁ: "n", ḥ: "h",
};
const LONG: Record<string, string> = { ā: "aa", ī: "ee", ū: "oo" };
const VOICED: Record<string, string> = { k: "g", c: "j", ṭ: "ḍ", t: "d", p: "b" };

function isFullVowel(u: Unit | undefined): boolean {
  return !!u && u.t === "V" && !u.inherent;
}

/** Marks inherent vowels that Indo-Aryan speech drops. Right-to-left so cluster checks see earlier deletions. */
function schwaDelete(units: Unit[]): Unit[] {
  const dead = new Set<number>();
  const vIdx = units.flatMap((u, i) => (u.t === "V" ? [i] : []));
  for (let k = vIdx.length - 1; k >= 1; k--) {
    const i = vIdx[k]!;
    const u = units[i]!;
    if (u.t !== "V" || !u.inherent) continue;
    const lastVowel = k === vIdx.length - 1;
    if (lastVowel) {
      dead.add(i); // word-final: मित्र -> mitr, कमल -> kamal
      continue;
    }
    // medial: exactly one consonant between this vowel and the next LIVE vowel, and the next vowel is a full one
    let j = k + 1;
    while (j < vIdx.length && dead.has(vIdx[j]!)) j++;
    const nextIdx = vIdx[j];
    if (nextIdx === undefined) continue;
    if (nextIdx - i - 1 > 1) continue; // cluster follows
    if (units[i + 1]?.t === "M") continue;
    if (isFullVowel(units[nextIdx])) dead.add(i);
  }
  return units.filter((_, i) => !dead.has(i));
}

function render(units: Unit[], o: ColloquialOptions): string {
  let s = "";
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    let r = u.r;
    if (u.t === "C") {
      let base = u.r;
      if (o.voicing && VOICED[base]) {
        const prev = units[i - 1];
        const next = units[i + 1];
        const betweenVowels = prev?.t === "V" && next?.t === "V";
        const afterNasal = prev?.t === "C" && "ṅñṇnm".includes(prev.r);
        const geminate = prev?.t === "C" && prev.r === base;
        if ((betweenVowels || afterNasal) && !geminate && !(next?.t === "C" && next.r === base)) base = VOICED[base]!;
      }
      r = o.flapAsR && (base === "ṛ" || base === "ṛh") ? (base === "ṛ" ? "r" : "rh") : (FOLD[base] ?? base);
      if (o.vAsW && r === "v") r = "w";
    } else if (u.t === "V") {
      r = o.longVowels && LONG[u.r] ? LONG[u.r]! : (FOLD[u.r] ?? u.r);
    } else if (u.t === "M") {
      r = FOLD[u.r] ?? u.r;
    }
    s += r;
  }
  return s.normalize("NFC");
}

const BASE_OPTS: ColloquialOptions = { schwaDeletion: true, longVowels: false, vAsW: false, flapAsR: false, voicing: false };

/** One ASCII spelling of an Indic word (or mixed text; non-Indic runs pass through untouched). */
export function colloquial(text: string, script: IndicScript | null, opts: Partial<ColloquialOptions> = {}): string {
  const o = { ...BASE_OPTS, schwaDeletion: script ? SCHWA_DELETING.has(script) : true, ...opts };
  return splitRuns(clean(text))
    .map((run) => {
      if (!run.indic) return run.text;
      const sc = detectScript(run.text) ?? script;
      const units = parseUnits(run.text);
      const ud = (o.schwaDeletion && (sc ? SCHWA_DELETING.has(sc) : true)) ? schwaDelete(units) : units;
      return render(ud, o);
    })
    .join("");
}

/**
 * Distinct ASCII spellings of one Indic word, best guess first (schwa-deleted), then schwa-kept, doubled long vowels,
 * v->w, flap-as-r, and (Tamil) voiced stops. Always includes at least one non-empty form for a word with Indic letters.
 */
export function romanVariants(word: string, script: IndicScript | null = detectScript(word)): string[] {
  const deletes = script ? SCHWA_DELETING.has(script) : true;
  const forms = [
    colloquial(word, script),
    ...(deletes ? [colloquial(word, script, { schwaDeletion: false })] : []),
    colloquial(word, script, { longVowels: true }),
    colloquial(word, script, { vAsW: true }),
    colloquial(word, script, { flapAsR: true }),
    ...(script === "taml" ? [colloquial(word, script, { voicing: true })] : []),
  ];
  return [...new Set(forms.filter((f) => f.length > 0))];
}

// ---- Latin -> Devanagari -----------------------------------------------------------------------------------------------
// Greedy, longest-match. Accepts both ISO diacritics (exact inverse of `toRoman` for Devanagari) and plain buyer spellings.
// Plain "t"/"d" map to the retroflex ट/ड because English loanwords ("tape", "drum") dominate B2B queries; the lexicon
// covers native words, so this fallback only needs to be plausible, never perfect.
const R_CONS: [string, number, boolean?][] = [
  ["chh", 0x91b], ["ksh", -1], ["kṣ", -1], ["jñ", -2], ["gy", -2], ["kh", 0x916], ["gh", 0x918], ["ch", 0x91a], ["jh", 0x91d], ["ṭh", 0x920],
  ["ḍh", 0x922], ["ṛh", 0x95d], ["th", 0x925], ["dh", 0x927], ["ph", 0x92b], ["bh", 0x92d], ["sh", 0x936], ["zh", 0x934],
  ["k", 0x915], ["g", 0x917], ["ṅ", 0x919], ["c", 0x91a], ["j", 0x91c], ["ñ", 0x91e], ["ṭ", 0x91f], ["ḍ", 0x921], ["ṇ", 0x923], ["t", 0x91f],
  ["d", 0x921], ["n", 0x928], ["ṉ", 0x929], ["p", 0x92a], ["f", 0x95e], ["b", 0x92c], ["m", 0x92e], ["y", 0x92f], ["r", 0x930], ["ṟ", 0x931],
  ["l", 0x932], ["ḷ", 0x933], ["ḻ", 0x934], ["v", 0x935], ["w", 0x935], ["ś", 0x936], ["ṣ", 0x937], ["s", 0x938], ["h", 0x939],
  ["q", 0x958], ["x", 0x959], ["ġ", 0x95a], ["z", 0x95b], ["ṛ", 0x95c],
];
// Strict-ISO dental stops: after a diacritic-bearing input we still want "t"=त. The strict output of `toRoman` uses plain
// t/d for the dental series and ṭ/ḍ for the retroflex, so `fromRoman(strict)` must read plain t/d as dental.
const R_CONS_STRICT_OVERRIDE: Record<string, number> = { t: 0x924, d: 0x926, ch: 0x91b }; // ISO: c = च, ch = छ (buyers type "ch" for च)
const R_VOWEL: [string, number, number][] = [
  // [roman, independent vowel cp, matra cp (0 = inherent)]
  ["aa", 0x906, 0x93e], ["ai", 0x910, 0x948], ["au", 0x914, 0x94c], ["ee", 0x908, 0x940], ["ii", 0x908, 0x940], ["oo", 0x90a, 0x942], ["uu", 0x90a, 0x942],
  ["r̥̄", 0x960, 0x944], ["r̥", 0x90b, 0x943], ["l̥", 0x90c, 0], ["ā", 0x906, 0x93e], ["ī", 0x908, 0x940], ["ū", 0x90a, 0x942], ["ê", 0x90d, 0x945], ["ô", 0x911, 0x949],
  ["ē", 0x90f, 0x947], ["ō", 0x913, 0x94b],
  ["a", 0x905, 0], ["i", 0x907, 0x93f], ["u", 0x909, 0x941], ["e", 0x90f, 0x947], ["o", 0x913, 0x94b],
];
const R_MARK: Record<string, string> = { ṃ: "ं", ṁ: "ँ", ḥ: "ः" };
const MARK_NFC: Record<string, string> = Object.fromEntries(Object.entries(R_MARK).map(([k, v]) => [k.normalize("NFC"), v]));
const NUKTA_CHAR = "़";

/**
 * Latin (plain or ISO 15919-ish) to Devanagari. `strict` reads plain t/d as dental and rejects nothing; the default
 * colloquial mode reads them as retroflex (loanword-friendly). Non-Latin characters pass through unchanged.
 */
export function fromRoman(input: string, opts: { strict?: boolean } = {}): string {
  const s = input.normalize("NFC").toLowerCase();
  let out = "";
  let i = 0;
  let afterCons = false; // previous emitted unit was a consonant awaiting a vowel sign / virama decision
  // table keys are normalised to NFC so they compare equal to the NFC input whatever form they were typed in
  const consTable = R_CONS.filter(([r]) => !(opts.strict && r === "gy")).map(([r, cp]) => [r.normalize("NFC"), opts.strict && R_CONS_STRICT_OVERRIDE[r] ? R_CONS_STRICT_OVERRIDE[r]! : cp] as const);
  const vowelTable = R_VOWEL.map(([r, indep, matra]) => [r.normalize("NFC"), indep, matra] as const);
  const lit = (cp: number) => {
    const ch = String.fromCodePoint(cp);
    // precomposed nukta letters are excluded from NFC: emit base + combining nukta, the canonical form
    return cp >= 0x958 && cp <= 0x95f ? ch.normalize("NFC") : ch;
  };
  while (i < s.length) {
    if (s[i] === "·") {
      i++;
      // seam marker: forces the consonant before it to take a virama when a consonant follows; nothing else to emit
      continue;
    }
    // vowels
    let matched = false;
    for (const [r, indep, matra] of vowelTable) {
      if (!s.startsWith(r, i)) continue;
      // a plain "a" after a consonant is the inherent vowel: no sign
      if (afterCons) out += matra ? String.fromCodePoint(matra) : "";
      else out += String.fromCodePoint(indep);
      i += r.length;
      afterCons = false;
      matched = true;
      break;
    }
    if (matched) continue;
    const mark = MARK_NFC[s[i]!];
    if (mark) {
      out += mark;
      i++;
      afterCons = false;
      continue;
    }
    // consonants (with special multi-letter clusters)
    let cons = false;
    for (const [r, cp] of consTable) {
      if (!s.startsWith(r, i)) continue;
      if (afterCons) out += "्"; // consonant + consonant: conjunct
      if (cp === -1) out += lit(0x915) + "्" + lit(0x937);
      else if (cp === -2) out += lit(0x91c) + "्" + lit(0x91e);
      else out += lit(cp);
      i += r.length;
      afterCons = true;
      cons = true;
      break;
    }
    if (cons) continue;
    out += s[i]; // digits, punctuation, spaces, anything else
    i++;
    afterCons = false;
  }
  return out.normalize("NFC");
}

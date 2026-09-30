// Query variants for cross-script lexical retrieval (ADR-004 "mixed-script and transliterated queries", ADR-009).
// `expandQuery` NEVER replaces the query: it returns EXTRA strings that the lexical retriever ORs in. The original text
// (and its embedding) is untouched. Deterministic, pure, capped.
import { colloquial, detectScript, fromRoman, hasIndic, romanVariants, scriptOf, type IndicScript } from "./indic";
import { lookup } from "./lexicon";

export const MAX_VARIANTS = 6;
export const MAX_VARIANT_LENGTH = 200;

const nfc = (s: string) => s.normalize("NFC");
const isLatinWord = (t: string) => /^[a-z][a-z'-]*$/.test(t);

/**
 * Extra query strings for `text` (already normalised: lower-case, fillers removed). Empty when nothing useful applies.
 *  - Indic tokens: lexicon English, plain Latin transliteration (+ schwa-kept, long-vowel, v->w spellings)
 *  - Latin tokens with a lexicon hit: English canonical, Hinglish spelling, Devanagari (for Hindi listings)
 * Mixed-script queries transform only their Indic (or lexicon-known Latin) tokens and pass the rest through.
 */
export function expandQuery(text: string, max = MAX_VARIANTS): string[] {
  const src = nfc(text).replace(/\s+/g, " ").trim();
  if (!src) return [];
  const tokens = src.split(" ");
  const dominant = detectScript(src);

  interface Forms {
    /** canonical English (lexicon) or the token itself */
    en: string;
    /** Latin spellings, best first */
    latin: string[];
    /** Devanagari form for Latin tokens */
    deva: string;
    known: boolean;
  }
  const per: Forms[] = tokens.map((tok) => {
    const script = detectScript(tok);
    const lex = lookup(tok);
    if (script) {
      const latin = romanVariants(tok, script);
      const hing = lex?.forms.hinglish[0];
      return { en: lex?.canonical ?? latin[0] ?? tok, latin: hing ? [hing, ...latin] : latin, deva: tok, known: !!lex };
    }
    if (lex) {
      const deva = lex.forms.hi[0] ?? "";
      return { en: lex.canonical, latin: lex.forms.hinglish.length ? [lex.forms.hinglish[0]!] : [tok], deva: deva || tok, known: true };
    }
    return { en: tok, latin: [tok], deva: tok, known: false };
  });

  const out: string[] = [];
  const push = (v: string) => {
    const s = v.replace(/\s+/g, " ").trim().slice(0, MAX_VARIANT_LENGTH);
    if (s && s !== src && !out.includes(s)) out.push(s);
  };
  const build = (pick: (f: Forms, tok: string) => string) => tokens.map((t, i) => pick(per[i]!, t)).join(" ");

  const anyIndic = tokens.some(hasIndic);
  const anyKnownLatin = per.some((f, i) => f.known && !hasIndic(tokens[i]!));

  if (anyIndic) {
    // 1. rewritten to English where the lexicon knows the word, transliterated elsewhere
    push(build((f, t) => (hasIndic(t) ? (f.known ? f.en : (f.latin[0] ?? t)) : t)));
    // 2. pure transliteration spellings, most likely first
    const maxForms = Math.max(0, ...tokens.map((t, i) => (hasIndic(t) ? per[i]!.latin.length : 0)));
    for (let k = 0; k < maxForms; k++) push(build((f, t) => (hasIndic(t) ? (f.latin[k] ?? f.latin[0] ?? t) : t)));
  }
  if (anyKnownLatin) {
    // English canon (Hinglish -> English), and Devanagari for Hindi-language listings
    push(build((f, t) => (hasIndic(t) ? t : f.known ? f.en : t)));
    push(build((f, t) => (hasIndic(t) ? t : f.known ? (f.latin[0] ?? t) : t)));
    push(build((f, t) => (hasIndic(t) ? t : f.known ? f.deva : isLatinWord(t) && t.length >= 3 ? fromRoman(t) : t)));
  }
  return out.slice(0, Math.max(0, max));
}

export { colloquial, detectScript, fromRoman, hasIndic, romanVariants, scriptOf };
export type { IndicScript };

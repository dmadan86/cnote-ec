// PII redaction (ADR-010). Applied to everything sent to a model vendor AND to the
// AiDecision.inputRedacted audit column, so the audit trail never holds more than the vendor saw.

/** Inputs longer than this are truncated BEFORE any regex runs (ReDoS and cost bound). */
export const MAX_REDACT_CHARS = 20_000;

// Bounded quantifiers (RFC 5321 limits) keep matching linear on adversarial input (CodeQL js/polynomial-redos).
const EMAIL = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,24}/gi;
const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/gi;
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/gi;
const AADHAAR = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;
/** Indian mobile: optional +91/0 prefix, 10 digits starting 6-9, optionally split 5+5. */
export const PHONE = /(?<![\d])(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?![\d])/g;
export const URL_RE = /\b(?:https?:\/\/|www\.)\S{1,2048}|\b[a-z0-9-]{1,63}\.(?:com|in|net|org|co\.in|io)\b\S{0,2048}/gi;

/** Digit runs with irregular separators ("+91 - 98 765-43 210", "(011) 2345 6789"); the digit count decides in the callback. */
const PHONE_LOOSE = /(?<![\w.])(?:\+\s?)?\d(?:[\s().-]{0,4}\d){7,14}(?![\w])/g;

/** True when the digits of a loosely-separated run form an Indian mobile or an STD landline. */
function isIndianPhoneDigits(d: string): boolean {
  if (d.length === 10) return /^[6-9]/.test(d);
  if (d.length === 11) return d[0] === "0" && /^[1-9]/.test(d[1]!); // 0 + mobile, or 0 + STD + number
  if (d.length === 12) return d.startsWith("91") && /^[1-9]/.test(d[2]!); // +91 + mobile or STD (no trunk 0)
  if (d.length === 13) return d.startsWith("910") && /^[1-9]/.test(d[3]!); // +91 0 ...
  return false;
}

/** Address fragments ending in a PIN code: "Plot 5, Phase 2, Okhla Industrial Area, New Delhi 110020". */
const ADDRESS_PIN = /\b(?:flat|plot|house|h\.?\s?no|door\s?no|shop|unit|gala|near|opp(?:osite)?|behind|village|vill|street|st\.|road|rd\.|lane|marg|nagar|colony|sector|phase|society|apartments?|bhavan|chowk)\b[^\n]{0,100}?\b[1-9]\d{2}\s?\d{3}\b/gi;

/** Names that follow an introduction marker ("my name is Rajesh Kumar", "Mr. Sharma", "Shri Anil Gupta", "mera naam Suresh"). */
const NAME_AFTER_MARKER =
  /\b(my\s+name\s+is|mera\s+naam|naam\s*[:-]|name\s*[:-]|contact\s+person\s*[:-]?|contact\s*[:-]?|mr|mrs|ms|miss|shri|shree|sri|smt|dr)\.?[ \t]+([\p{L}][\p{L}.'-]{1,30}(?:[ \t]+[\p{L}][\p{L}.'-]{1,30}){0,2})/giu;
const NAME_STOP = new Set(["us", "details", "detail", "number", "info", "information", "person", "sales", "team", "support", "our", "me", "the", "for", "at", "on", "to", "if", "we", "you"]);

function redactNames(text: string): string {
  return text.replace(NAME_AFTER_MARKER, (m, marker: string, name: string) => {
    const words = name.split(/[ \t]+/);
    const kept: string[] = [];
    // a name is Capitalised words; stop at the first lowercase word or stop-word ("Mr Sharma wants 500 pcs")
    for (const w of words) {
      if (!/^\p{Lu}/u.test(w) || NAME_STOP.has(w.toLowerCase())) break;
      kept.push(w);
    }
    if (!kept.length) return m;
    const rest = words.slice(kept.length);
    return `${marker} [name]${rest.length ? " " + rest.join(" ") : ""}`;
  });
}

export function redactPii(input: string): string {
  const text = input.length > MAX_REDACT_CHARS ? `${input.slice(0, MAX_REDACT_CHARS)} [truncated]` : input;
  return redactNames(
    text
      .replace(EMAIL, "[email]")
      .replace(GSTIN, "[gstin]")
      .replace(PAN, "[pan]")
      .replace(AADHAAR, "[aadhaar]")
      .replace(PHONE_LOOSE, (m) => (isIndianPhoneDigits(m.replace(/\D/g, "")) ? "[phone]" : m))
      .replace(PHONE, "[phone]")
      .replace(ADDRESS_PIN, "[address]"),
  );
}

/** Recursively redacts every string in a JSON-like value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactPii(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}

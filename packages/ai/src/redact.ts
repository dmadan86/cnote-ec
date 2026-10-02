// PII redaction (ADR-010). Applied to everything sent to a model vendor AND to the
// AiDecision.inputRedacted audit column, so the audit trail never holds more than the vendor saw.

// Bounded quantifiers (RFC 5321 limits) keep matching linear on adversarial input (CodeQL js/polynomial-redos).
const EMAIL = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,24}/gi;
const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/gi;
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/gi;
const AADHAAR = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;
/** Indian mobile: optional +91/0 prefix, 10 digits starting 6-9, optionally split 5+5. */
export const PHONE = /(?<![\d])(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?![\d])/g;
export const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|in|net|org|co\.in|io)\b\S*/gi;

export function redactPii(text: string): string {
  return text
    .replace(EMAIL, "[email]")
    .replace(GSTIN, "[gstin]")
    .replace(PAN, "[pan]")
    .replace(AADHAAR, "[aadhaar]")
    .replace(PHONE, "[phone]");
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

import type { IntentInput, IntentOutput } from "../index";
import { PHONE, URL_RE } from "../redact";
import type { ProviderResult } from "../types";

export const HEURISTIC_MODEL = "heuristic-v1";
export const INTENT_HEURISTIC_VERSION = "intent-heuristic-v1";

const UNIT_ALT = "mm|cm|mtr|kg|gsm|micron|mic|ml|ltr|inch|ft|ply|watt|kw|hp|mah|gb|tb|pcs|nos|meter|litre|liter|gm|ton|tonne|dozen|sets?|rolls?";
const SPEC_PATTERNS: RegExp[] = [
  new RegExp(`\\b\\d+(?:\\.\\d+)?\\s{0,4}(?:${UNIT_ALT})\\b`, "gi"), // 180 gsm, 3 ply, 12mm
  /\b\d+(?:\.\d+)?\s{0,4}[x×*]\s{0,4}\d+(?:\.\d+)?(?:\s{0,4}[x×*]\s{0,4}\d+(?:\.\d+)?)?\b/gi, // 10x10x5
  /\bgsm\s{0,4}[:\-]?\s{0,4}\d+\b/gi,
  /\b(?:grade|gr)\.?\s{0,4}[:\-]?\s{0,4}[a-z0-9]+\b/gi,
  /\b(?:ss|ms|en|is|astm|din)\s{0,4}[- ]?\d{2,5}[a-z]?\b/gi, // SS304, IS 2062
  /\b(?:size|sz|dia|diameter|thickness|length|width)\s{0,4}[:\-]?\s{0,4}\d+/gi,
];

export function specMatches(text: string): string[] {
  const found: string[] = [];
  for (const re of SPEC_PATTERNS) {
    for (const m of text.match(re) ?? []) {
      const s = m.trim().toLowerCase();
      if (!found.some((f) => f.includes(s) || s.includes(f))) found.push(s);
    }
  }
  return found;
}

function gibberishRatio(text: string): number {
  const words = text.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  if (!words.length) return 0;
  const bad = words.filter((w) => !/[aeiouy]/.test(w) || /(.)\1{3,}/.test(w) || /[^aeiouy\s]{6,}/.test(w));
  return bad.length / words.length;
}

function allCaps(text: string): boolean {
  const letters = text.replace(/[^A-Za-z]/g, "");
  return letters.length >= 12 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.7;
}

const PINCODE = /^[1-9]\d{5}$/;
const DAY = 86_400_000;

/** ADR-002 buyer-intent signals → 0-100 score + human-readable reasons. Pure and deterministic. */
export function scoreIntentHeuristic(input: IntentInput, now: Date = new Date()): ProviderResult<IntentOutput> {
  const text = `${input.title}\n${input.requirement}`.trim();
  const good: string[] = [];
  const bad: string[] = [];
  let score = 10;
  let signals = 0; // filled-in inputs → confidence
  const TOTAL_SIGNALS = 7;

  if (input.quantity && input.quantity > 0) {
    score += 10; signals++;
    const unit = input.quantityUnit?.trim();
    if (unit) score += 3;
    good.push(`Specific quantity: ${input.quantity} ${unit ?? ""}`.trim());
  } else bad.push("No quantity given");

  const specs = specMatches(text);
  if (specs.length) {
    score += Math.min(specs.length, 3) * 4;
    good.push(`Detailed specs: ${specs.slice(0, 3).join(", ")}`);
  }
  if (input.requirement.trim().length >= 60) { score += 5; signals++; }
  else if (input.requirement.trim().length >= 25) signals += 0.5;

  if (input.deliveryPincode && PINCODE.test(input.deliveryPincode.trim())) {
    score += 10; signals++;
    good.push("Delivery pincode provided");
  } else bad.push("No delivery pincode");

  if (input.neededBy) {
    const days = Math.ceil((new Date(input.neededBy).getTime() - now.getTime()) / DAY);
    if (Number.isNaN(days)) bad.push("Needed-by date is invalid");
    else if (days < 0) bad.push("Needed-by date has already passed");
    else {
      score += days <= 60 ? 8 : days <= 180 ? 5 : 2; signals++;
      good.push(days <= 60 ? `Needed within ${Math.max(days, 1)} day${days > 1 ? "s" : ""}` : "Delivery timeline provided");
    }
  }

  if (input.targetPricePaise != null) {
    signals++;
    const p = input.targetPricePaise;
    if (p >= 100 && p <= 1e9) { score += 6; good.push("Target price provided"); }
    else { score -= 5; bad.push("Target price looks implausible"); }
  }

  const tier = Math.max(0, Math.min(3, input.buyerVerificationTier));
  if (tier > 0) { score += tier * 4; good.push(`Verified buyer (tier ${tier})`); }
  else bad.push("Buyer identity not verified");
  if (input.buyerPhoneVerified) { score += 8; good.push("Phone verified"); }
  else bad.push("Phone not verified");

  if (input.buyerPriorEnquiries > 0) {
    signals++;
    const ratio = Math.min(1, input.buyerPriorResponded / input.buyerPriorEnquiries);
    if (input.buyerPriorEnquiries >= 3 && ratio < 0.3) {
      score -= 8; bad.push(`Engaged with sellers on only ${input.buyerPriorResponded} of ${input.buyerPriorEnquiries} earlier enquiries`);
    } else {
      score += Math.round(ratio * 8);
      if (ratio >= 0.5) good.push(`Engaged with sellers on ${input.buyerPriorResponded} of ${input.buyerPriorEnquiries} earlier enquiries`);
    }
  } else bad.push("New buyer, no history");

  const sim = input.nearDuplicateSimilarity ?? 0;
  if (sim >= 0.92) { score -= 25; bad.push("Near-duplicate of a recent enquiry from this buyer"); }
  else if (sim >= 0.85) { score -= 12; bad.push("Similar to a recent enquiry from this buyer"); }

  // Spam signals
  if (input.requirement.trim().length < 15) { score -= 15; bad.push("Requirement text is very short"); }
  if (allCaps(text)) { score -= 12; bad.push("Text is mostly capital letters"); }
  if (URL_RE.test(text)) { score -= 15; bad.push("Contains a link"); }
  URL_RE.lastIndex = 0;
  if (PHONE.test(text) || /[\w.+-]{1,64}@[\w-]{1,255}\.\w{1,24}/.test(text)) { score -= 10; bad.push("Contains contact details in the text"); }
  PHONE.lastIndex = 0;
  if (gibberishRatio(text) > 0.4) { score -= 20; bad.push("Text looks like gibberish"); }

  const final = Math.max(0, Math.min(100, Math.round(score)));
  const confidence = Math.round((0.35 + 0.65 * Math.min(1, signals / TOTAL_SIGNALS)) * 100) / 100;
  const reasons = [...good, ...bad].slice(0, 8);
  return {
    output: { score: final, reasons },
    confidence,
    provider: "heuristic",
    modelId: HEURISTIC_MODEL,
    promptVersion: INTENT_HEURISTIC_VERSION,
  };
}

// Opt-out / opt-in keywords (English + Hindi, Devanagari and romanised). Exact-phrase match after normalisation so
// "please stop calling me a liar" is not an opt-out but "STOP" is.
const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[.!,"'\s]+/g, " ").trim();

const STOP = new Set([
  "stop", "stop all", "unsubscribe", "opt out", "optout", "cancel subscription", "do not contact", "dont contact",
  "बंद", "बंद करो", "बंद करें", "रुको", "रोको", "रोकें", "सदस्यता रद्द", "मुझे संदेश न भेजें", "मैसेज बंद",
  "band", "band karo", "ruko", "message band karo", "stop karo",
]);
const START = new Set(["start", "unstop", "subscribe", "opt in", "optin", "शुरू", "शुरू करें", "shuru", "shuru karo"]);

export const isOptOut = (text: string) => STOP.has(norm(text));
export const isOptIn = (text: string) => START.has(norm(text));
export const normText = norm;

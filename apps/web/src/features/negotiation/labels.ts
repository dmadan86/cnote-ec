/** Every key of the `negotiation` catalogue namespace (apps/web/messages/<locale>.negotiation.json), for typed label passing. */
export const NEGOTIATION_KEYS = [
  "heading", "intro", "tableCaption", "colSeller", "colQuoted", "colDelivery", "colGst", "colLanded", "colQty", "colLead", "colValid", "colTrust", "colAction",
  "badgeBestValue", "badgeLowest", "badgeFastest", "deliveryIncluded", "deliveryExtra", "deliveryExtraUnknown", "deliveryUnknown", "gstIncluded", "gstExtra",
  "gstExtraUnknown", "gstUnknown", "days", "notStated", "expired", "incomplete", "whatDelivery", "whatGst", "whatBoth", "earlier", "reviewNote", "noQuotes",
  "boundsHeading", "boundsHint", "boundsTarget", "boundsMax", "boundsLead", "boundsSave", "boundsSaving", "boundsSaved", "suggest", "suggesting",
  "counterHeading", "counterQuoted", "counterPrice", "counterLead", "counterNote", "counterWhy", "counterNotSent", "counterSend", "counterSending", "counterDiscard",
  "counterSentBadge", "counterSentNote", "lowConfidence", "assistantHeading", "assistantEmpty", "actorAssistant", "actorYou", "log_quotes_normalised",
  "log_counter_proposed", "log_counter_sent", "log_counter_discarded", "log_counter_bounds_rejected", "error", "scrollHint", "regionLabel",
  "colMoq", "colDeliveryTerms", "colPayment", "delivery_ex_works", "delivery_fob", "delivery_door_delivery", "delivery_buyer_pickup", "delivery_other",
  "payment_advance", "payment_on_delivery", "payment_net_7", "payment_net_15", "payment_net_30", "payment_escrow", "payment_other",
] as const;
export type NegotiationLabels = Record<(typeof NEGOTIATION_KEYS)[number], string>;

/** `{name}` substitution for raw catalogue strings (raw so ICU never parses seller-supplied values). */
export const fmt = (s: string, v: Record<string, string | number> = {}): string => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));

export const inr = (paise: number): string => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

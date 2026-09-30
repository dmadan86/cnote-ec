// ADR-020 buyer agent UI. Pure helpers shared by server and client components (no next/* imports).
/** Every key of the `a2a` catalogue namespace (apps/web/messages/<locale>.a2a.json); a test keeps this list equal to en.a2a.json. */
export const A2A_KEYS = ["pageTitle", "pageIntro", "commitNote", "limitsPrivate", "disabledNotice", "backToAgents", "confirmHeading", "confirmEmpty", "confirmItem", "review", "mandatesHeading", "mandatesEmpty", "activityHeading", "activityEmpty", "activityByAgent", "activityByYou", "createHeading", "createHint", "fOptIn", "fName", "fTitle", "fRequirement", "fCategory", "fQuantity", "fUnit", "fTarget", "fTargetHint", "fMax", "fMaxHint", "fLead", "fSellers", "fSellersHint", "fRecur", "recurOnce", "recurEvery", "fRecurDays", "fExpiry", "autoHeading", "autoDefault", "fAuto", "fAutoConsent", "fAutoLimit", "fAutoLimitHint", "create", "creating", "created", "save", "saving", "saved", "errMoney", "errInt", "errRequired", "errSellers", "errCeiling", "errConsent", "errDate", "errFix", "errSummary", "lblMax", "lblNext", "lblRepeat", "repeatOnce", "repeatEvery", "qtyUnit", "autoOnBadge", "autoOffBadge", "open", "perUnit", "none", "mstatusActive", "mstatusPaused", "mstatusRevoked", "mstatusExpired", "mstatusCompleted", "mstatusSuspended", "controlsHeading", "pause", "resume", "revoke", "revokeWarn", "revokeYes", "cancel", "working", "donePaused", "doneResumed", "doneRevoked", "autoIsOn", "autoIsOff", "autoTurnOff", "autoTurnOn", "doneAutoOff", "doneAutoOn", "editHeading", "readOnly", "historyHeading", "historyCaption", "colVersion", "colWhen", "colChange", "colBy", "chgCreated", "chgUpdated", "chgExpired", "chgAutoOn", "chgAutoOff", "chgResumed", "chgPaused", "chgRevoked", "byHuman", "bySystem", "byAdmin", "byApi", "mandateActivity", "negHeading", "negRound", "negExpires", "statusLabel", "statusOpen", "statusAgreed", "statusAccepted", "statusRejected", "statusWithdrawn", "statusExpired", "transcriptHeading", "transcriptCaption", "transcriptEmpty", "colWho", "colType", "colPrice", "colQty", "colUnit", "colLead", "colTerms", "colValid", "typeOffer", "typeCounter", "typeAccept", "typeReject", "typeWithdraw", "sideYou", "actorAgent", "actorExternal", "actorPerson", "days", "noTerms", "termDelivery", "termPayment", "agreedHeading", "confirmDealHeading", "confirmDealBody", "confirmDeal", "declineDeal", "doneConfirmed", "doneDeclined", "sellerConfirmed", "sellerPending", "youConfirmed", "orderLink", "realiseFailed", "retry", "retried", "withdraw", "doneWithdrawn", "actMandateCreated", "actMandateUpdated", "actMandatePaused", "actMandateResumed", "actMandateRevoked", "actMandateExpired", "actMandateSuspended", "actMandateUnsuspended", "actAutoOn", "actAutoOff", "actStarted", "actOffer", "actDealReached", "actRejected", "actWithdrawn", "actExpired", "actAwaiting", "actConfirmed", "actDeclined", "actOrder", "actProblem", "actOther"] as const;
export type A2aLabels = Record<(typeof A2A_KEYS)[number], string>;

/** `{name}` substitution for raw catalogue strings (raw so ICU never parses counterparty-supplied values). */
export const fmt = (s: string, v: Record<string, string | number> = {}): string => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));

/**
 * Rupees typed by a person -> integer paise, using string/integer maths only (no float drift: 1.15 * 100 would be 114.99999).
 * Accepts "1250", "1,250", "1250.5", "1250.50"; rejects signs, exponents, more than 2 decimals and zero.
 */
export function parseRupees(input: string | null | undefined): number | null {
  const v = (input ?? "").trim().replace(/,/g, "");
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(v);
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return paise > 0 ? paise : null;
}

/** Integer paise -> the string a rupee input should show ("1250", "1250.50"). */
export function paiseToInput(paise: number | null | undefined): string {
  if (paise == null) return "";
  const whole = Math.trunc(paise / 100);
  const rem = paise % 100;
  return rem === 0 ? String(whole) : `${whole}.${String(rem).padStart(2, "0")}`;
}

/** Integer paise -> "₹1,250" / "₹1,250.50" (Indian grouping) without floating point on the paise. */
export function rupees(paise: number): string {
  const whole = Math.trunc(paise / 100);
  const rem = paise % 100;
  return `₹${whole.toLocaleString("en-IN")}${rem === 0 ? "" : `.${String(rem).padStart(2, "0")}`}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

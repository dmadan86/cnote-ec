// Browser side of the consent manager for the buyer web. The logic is shared with the seller app in @cnote/consent/client;
// this module binds it to the web's config (cookie name, policy version, registry, receipt path) and adds the account-ledger sync,
// which is web-only. Every function still takes an injectable `ConsentEnv` (default: the real browser) so it is testable in node.
import * as core from "@cnote/consent/client";
import type { ConsentConfig, ConsentEnv, ConsentReceiptBody } from "@cnote/consent/client";
import { reconcileAccountConsent, requestedActionFor, type AccountConsent } from "./account-sync";
import { STORAGE_REGISTRY } from "./registry";
import { CONSENT_COOKIE, CONSENT_POLICY_VERSION, type ConsentAction, type ConsentChoices, type ConsentState, type OptionalCategory } from "./state";

/** localStorage key holding the receipts the server has not acknowledged yet (registered as strictly necessary: it IS the consent record). */
export const CONSENT_PENDING_KEY = "cnote_consent_pending";
/** sessionStorage flag: this visit's cookie choice has been checked against the account ledger. */
export const CONSENT_SYNC_KEY = "cnote_consent_sync";

export type { ConsentEnv, ConsentReceiptBody };
export { isReceiptBody, gpcSignal, expireCookie, openConsentPreferences, subscribeConsent } from "@cnote/consent/client";

export const WEB_CONSENT_CONFIG: ConsentConfig = {
  cookieName: CONSENT_COOKIE,
  policyVersion: CONSENT_POLICY_VERSION,
  registry: STORAGE_REGISTRY,
  pendingKey: CONSENT_PENDING_KEY,
  receiptPath: "/api/consent",
};

export const browserEnv = (): ConsentEnv => core.browserEnv(WEB_CONSENT_CONFIG);
export const readClientConsent = (env: ConsentEnv = browserEnv()): ConsentState | null => core.readClientConsent(WEB_CONSENT_CONFIG, env);

/** Guard used by the leadgen helpers. False on the server, before a choice, and after withdrawal. */
export const clientGranted = (category: OptionalCategory, env?: ConsentEnv): boolean => core.clientGranted(WEB_CONSENT_CONFIG, category, env);

/** Deletes every client-deletable cookie/storage key of a category (withdrawal, and defensively on every "not granted"). */
export const clearCategoryStorage = (category: OptionalCategory, env: ConsentEnv = browserEnv()) => core.clearCategoryStorage(WEB_CONSENT_CONFIG, category, env);

export const queueReceipt = (body: ConsentReceiptBody, env: ConsentEnv = browserEnv()): Promise<void> => core.queueReceipt(WEB_CONSENT_CONFIG, body, env);

/** Resends every unacknowledged receipt, oldest first (idempotent server side). Called once per page load. */
export const flushPendingReceipts = (env: ConsentEnv = browserEnv()): Promise<void> => core.flushPendingReceipts(WEB_CONSENT_CONFIG, env);

/**
 * Records a choice: cookie, storage cleanup for anything not granted, `cnote:consent` event, then the server receipt
 * (POST /api/consent, which also expires the httpOnly `cnote_vid`/`cnote_ad_click` when marketing is not granted).
 * `opts.at` lets account sync adopt the ledger's time instead of "now".
 */
export const applyConsent = (choices: ConsentChoices, requested: Exclude<ConsentAction, "withdraw">, locale: string, env: ConsentEnv = browserEnv(), opts: { at?: number } = {}): ConsentState =>
  core.applyConsent(WEB_CONSENT_CONFIG, choices, requested, locale, env, opts);

export const acceptAll = (locale: string, env: ConsentEnv = browserEnv()) => core.acceptAll(WEB_CONSENT_CONFIG, locale, env);
export const rejectAll = (locale: string, env: ConsentEnv = browserEnv()) => core.rejectAll(WEB_CONSENT_CONFIG, locale, env);

/**
 * Account sync (signed-in people): when there is no valid cookie, or once per visit, ask GET /api/consent/account for the
 * ledger and let the NEWER of cookie and ledger win per purpose (a withdrawal elsewhere beats an older grant here).
 * Anonymous visitors cost one tiny request while the banner is showing. Returns true when the cookie was replaced.
 */
export async function syncFromAccount(locale: string, env: ConsentEnv = browserEnv(), load: () => Promise<AccountConsent | null> = loadAccountConsent): Promise<boolean> {
  const cookie = readClientConsent(env);
  if (cookie && env.readSession(CONSENT_SYNC_KEY)) return false;
  const account = await load();
  if (!account) return false; // network trouble: try again on the next load
  env.writeSession(CONSENT_SYNC_KEY, account.signedIn ? "1" : "0");
  // The visitor may have chosen while the request was in flight: reconcile against the cookie as it is now.
  const decision = reconcileAccountConsent(readClientConsent(env), account, Math.floor(env.now() / 1000));
  if (decision.kind !== "adopt") return false;
  applyConsent(decision.choices, requestedActionFor(decision.choices), locale, env, { at: decision.at });
  return true;
}

export async function loadAccountConsent(): Promise<AccountConsent | null> {
  try {
    const res = await fetch("/api/consent/account", { credentials: "same-origin", cache: "no-store" });
    return res.ok ? ((await res.json()) as AccountConsent) : null;
  } catch {
    return null;
  }
}

/** Raw cookie value snapshot (a string, so it is referentially stable between renders). */
export const consentSnapshot = (): string => core.consentSnapshot(WEB_CONSENT_CONFIG);

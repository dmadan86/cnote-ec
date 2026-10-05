// Browser side of the consent manager for the buyer web. The logic is shared with the seller app in @cnote/consent/client;
// this module binds it to the web's config (cookie name, policy version, registry, receipt path) and adds the account-ledger sync,
// which is web-only. Every function still takes an injectable `ConsentEnv` (default: the real browser) so it is testable in node.
import * as core from "@cnote/consent/client";
import type { ConsentConfig, ConsentEnv, ConsentReceiptBody } from "@cnote/consent/client";
import type { AccountConsent } from "./account-sync";
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

const WEB_ACCOUNT_SYNC = { syncKey: CONSENT_SYNC_KEY, accountPath: "/api/consent/account" } as const;

/** Account sync (signed-in people): the shared logic is `syncFromAccount` in @cnote/consent/client. */
export const syncFromAccount = (locale: string, env: ConsentEnv = browserEnv(), load: () => Promise<AccountConsent | null> = loadAccountConsent): Promise<boolean> =>
  core.syncFromAccount(WEB_CONSENT_CONFIG, WEB_ACCOUNT_SYNC, locale, env, load);

export const loadAccountConsent = (): Promise<AccountConsent | null> => core.loadAccountConsent(WEB_ACCOUNT_SYNC.accountPath);

/** Raw cookie value snapshot (a string, so it is referentially stable between renders). */
export const consentSnapshot = (): string => core.consentSnapshot(WEB_CONSENT_CONFIG);

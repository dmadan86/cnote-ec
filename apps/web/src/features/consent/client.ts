// Browser side of the consent manager. Every function takes an injectable `ConsentEnv` (default: the real browser) so the
// withdrawal/clear logic is unit-testable in node without a DOM.
import { clientClearable, type StorageEntry } from "./registry";
import {
  acceptAllChoices,
  buildConsent,
  CONSENT_EVENT,
  CONSENT_OPEN_EVENT,
  CONSENT_COOKIE,
  consentCookieString,
  cookieValue,
  deriveAction,
  isGranted,
  OPTIONAL_CATEGORIES,
  readConsentFromHeader,
  REJECT_ALL,
  type ConsentAction,
  type ConsentChoices,
  type ConsentState,
  type OptionalCategory,
} from "./state";

/** Body of POST /api/consent (the server adds the timestamp and, when signed in, the person). */
export interface ConsentReceiptBody {
  consentId: string;
  policyVersion: number;
  analytics: boolean;
  marketing: boolean;
  gpc: boolean;
  action: ConsentAction;
  locale: string;
}

export interface ConsentEnv {
  getCookie(): string;
  setCookie(cookie: string): void;
  removeLocal(key: string): void;
  removeSession(key: string): void;
  hostname(): string;
  secure(): boolean;
  gpc(): boolean;
  now(): number;
  emit(state: ConsentState): void;
  sendReceipt(body: ConsentReceiptBody): void;
}

/** Global Privacy Control (https://globalprivacycontrol.org): `navigator.globalPrivacyControl === true`. */
export const gpcSignal = (): boolean => typeof navigator !== "undefined" && (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;

export function browserEnv(): ConsentEnv {
  return {
    getCookie: () => document.cookie,
    setCookie: (c) => void (document.cookie = c),
    removeLocal: (k) => {
      try {
        localStorage.removeItem(k);
      } catch {
        /* storage blocked */
      }
    },
    removeSession: (k) => {
      try {
        sessionStorage.removeItem(k);
      } catch {
        /* storage blocked */
      }
    },
    hostname: () => location.hostname,
    secure: () => location.protocol === "https:",
    gpc: gpcSignal,
    now: () => Date.now(),
    emit: (state) => window.dispatchEvent(new CustomEvent<ConsentState>(CONSENT_EVENT, { detail: state })),
    sendReceipt: (body) => {
      // keepalive: survives the page being closed or navigated right after the click. Static pages, so a plain fetch.
      void fetch("/api/consent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true, credentials: "same-origin" }).catch(() => undefined);
    },
  };
}

export const readClientConsent = (env: ConsentEnv = browserEnv()): ConsentState | null => readConsentFromHeader(env.getCookie(), env.now());

/** Guard used by the leadgen helpers. False on the server, before a choice, and after withdrawal. */
export function clientGranted(category: OptionalCategory, env?: ConsentEnv): boolean {
  if (!env && typeof document === "undefined") return false;
  return isGranted(readClientConsent(env), category);
}

const EPOCH = "Thu, 01 Jan 1970 00:00:00 GMT";

/** Expires a cookie on the current host and on every parent domain (Clarity sets `_clck`/`_clsk` on the registrable domain). */
export function expireCookie(name: string, env: Pick<ConsentEnv, "setCookie" | "hostname">) {
  const base = `${name}=; Max-Age=0; Expires=${EPOCH}; Path=/`;
  env.setCookie(base);
  const host = env.hostname();
  if (!host || !host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":")) return; // localhost / IP literals: host-only cookies
  const parts = host.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const d = parts.slice(i).join(".");
    env.setCookie(`${base}; Domain=${d}`);
    env.setCookie(`${base}; Domain=.${d}`);
  }
}

function clearEntry(e: StorageEntry, env: ConsentEnv) {
  if (e.kind === "cookie") expireCookie(e.name, env);
  else if (e.kind === "localStorage") env.removeLocal(e.name);
  else env.removeSession(e.name);
}

/** Deletes every client-deletable cookie/storage key of a category (withdrawal, and defensively on every "not granted"). */
export function clearCategoryStorage(category: OptionalCategory, env: ConsentEnv = browserEnv()) {
  for (const e of clientClearable(category)) clearEntry(e, env);
}

/**
 * Records a choice: cookie, storage cleanup for anything not granted, `cnote:consent` event, then the server receipt
 * (POST /api/consent, which also expires the httpOnly `cnote_vid`/`cnote_ad_click` when marketing is not granted).
 */
export function applyConsent(choices: ConsentChoices, requested: Exclude<ConsentAction, "withdraw">, locale: string, env: ConsentEnv = browserEnv()): ConsentState {
  const prev = readClientConsent(env);
  const state = buildConsent(choices, { gpc: env.gpc(), prev, now: env.now() });
  env.setCookie(consentCookieString(state, env.secure()));
  for (const c of OPTIONAL_CATEGORIES) if (!state[c]) clearCategoryStorage(c, env);
  env.emit(state);
  env.sendReceipt({
    consentId: state.id,
    policyVersion: state.version,
    analytics: state.analytics,
    marketing: state.marketing,
    gpc: state.gpc,
    action: deriveAction(requested, prev, choices),
    locale,
  });
  return state;
}

export const acceptAll = (locale: string, env: ConsentEnv = browserEnv()) => applyConsent(acceptAllChoices(env.gpc()), "accept_all", locale, env);
export const rejectAll = (locale: string, env: ConsentEnv = browserEnv()) => applyConsent(REJECT_ALL, "reject_all", locale, env);

/** Opens the preferences dialog from anywhere (footer, policy page, account). No reload. */
export const openConsentPreferences = () => window.dispatchEvent(new Event(CONSENT_OPEN_EVENT));

// --- React binding (useSyncExternalStore) ---------------------------------------------------------------------------

export const subscribeConsent = (cb: () => void) => {
  window.addEventListener(CONSENT_EVENT, cb);
  return () => window.removeEventListener(CONSENT_EVENT, cb);
};
/** Raw cookie value snapshot (a string, so it is referentially stable between renders). */
export const consentSnapshot = (): string => cookieValue(document.cookie, CONSENT_COOKIE) ?? "";

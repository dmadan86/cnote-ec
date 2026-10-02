// Browser side of the consent manager. Every function takes an injectable `ConsentEnv` (default: the real browser) so the
// withdrawal/clear logic is unit-testable in node without a DOM.
import { reconcileAccountConsent, requestedActionFor, type AccountConsent } from "./account-sync";
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
  isConsentId,
  OPTIONAL_CATEGORIES,
  readConsentFromHeader,
  REJECT_ALL,
  type ConsentAction,
  type ConsentChoices,
  type ConsentState,
  type OptionalCategory,
} from "./state";

/** localStorage key holding the receipts the server has not acknowledged yet (registered as strictly necessary: it IS the consent record). */
export const CONSENT_PENDING_KEY = "cnote_consent_pending";
/** sessionStorage flag: this visit's cookie choice has been checked against the account ledger. */
export const CONSENT_SYNC_KEY = "cnote_consent_sync";
const PENDING_MAX = 20;

/** Body of POST /api/consent (the server adds its own timestamp, the policy hash and, when signed in, the person). */
export interface ConsentReceiptBody {
  consentId: string;
  policyVersion: number;
  analytics: boolean;
  marketing: boolean;
  gpc: boolean;
  action: ConsentAction;
  locale: string;
  /** unix seconds of the choice (`t` in the cookie); (consentId, at) makes the server write idempotent */
  at: number;
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
  /** POSTs one receipt; resolves with the HTTP status, 0 when the network failed */
  postReceipt(body: ConsentReceiptBody): Promise<number>;
  readPending(): ConsentReceiptBody[];
  writePending(list: ConsentReceiptBody[]): void;
  readSession(key: string): string | null;
  writeSession(key: string, value: string): void;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** Shape check for a receipt read back from localStorage (never trust stored JSON). */
export function isReceiptBody(v: unknown): v is ConsentReceiptBody {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return isConsentId(r.consentId) && isNum(r.policyVersion) && typeof r.analytics === "boolean" && typeof r.marketing === "boolean" && typeof r.gpc === "boolean" && typeof r.action === "string" && typeof r.locale === "string" && isNum(r.at);
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
    // keepalive: survives the page being closed or navigated right after the click. Static pages, so a plain fetch.
    postReceipt: (body) =>
      fetch("/api/consent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true, credentials: "same-origin" }).then(
        (r) => r.status,
        () => 0,
      ),
    readPending: () => {
      try {
        const parsed: unknown = JSON.parse(localStorage.getItem(CONSENT_PENDING_KEY) ?? "[]");
        return Array.isArray(parsed) ? parsed.filter(isReceiptBody) : [];
      } catch {
        return [];
      }
    },
    writePending: (list) => {
      try {
        if (list.length === 0) localStorage.removeItem(CONSENT_PENDING_KEY);
        else localStorage.setItem(CONSENT_PENDING_KEY, JSON.stringify(list));
      } catch {
        /* storage blocked: the receipt is still sent now, it just cannot be retried after a reload */
      }
    },
    readSession: (k) => {
      try {
        return sessionStorage.getItem(k);
      } catch {
        return null;
      }
    },
    writeSession: (k, v) => {
      try {
        sessionStorage.setItem(k, v);
      } catch {
        /* storage blocked */
      }
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

const samePending = (a: ConsentReceiptBody, b: ConsentReceiptBody) => a.consentId === b.consentId && a.at === b.at;

/**
 * A receipt is stored in localStorage BEFORE it is sent and removed only once the server answered 200 (or rejected it
 * for good), so a failed network, a closed tab or a 5xx never loses the proof of consent (DPDP s.6(10)). The server is
 * idempotent on (consentId, at), so resending is always safe.
 */
export async function queueReceipt(body: ConsentReceiptBody, env: ConsentEnv = browserEnv()): Promise<void> {
  const list = env.readPending().filter((p) => !samePending(p, body));
  list.push(body);
  env.writePending(list.slice(-PENDING_MAX));
  await sendPending(body, env);
}

/** Statuses after which resending the same body can never succeed (validation / origin / size): drop it. 429 and 5xx are retried. */
const permanent = (status: number) => status >= 400 && status < 500 && status !== 429 && status !== 408;

/** POSTs one stored receipt and drops it from the outbox when the server took it (200) or refused it for good. */
async function sendPending(body: ConsentReceiptBody, env: ConsentEnv): Promise<number> {
  const status = await env.postReceipt(body);
  if (status === 200 || permanent(status)) env.writePending(env.readPending().filter((p) => !samePending(p, body)));
  return status;
}

/** Resends every unacknowledged receipt, oldest first (idempotent server side). Called once per page load. */
export async function flushPendingReceipts(env: ConsentEnv = browserEnv()): Promise<void> {
  for (const body of env.readPending()) {
    const status = await sendPending(body, env);
    if (status === 0 || status === 429 || status >= 500) return; // offline or throttled: later bodies would fail too, retry on the next load
  }
}

/**
 * Records a choice: cookie, storage cleanup for anything not granted, `cnote:consent` event, then the server receipt
 * (POST /api/consent, which also expires the httpOnly `cnote_vid`/`cnote_ad_click` when marketing is not granted).
 * `opts.at` lets account sync adopt the ledger's time instead of "now".
 */
export function applyConsent(
  choices: ConsentChoices,
  requested: Exclude<ConsentAction, "withdraw">,
  locale: string,
  env: ConsentEnv = browserEnv(),
  opts: { at?: number } = {},
): ConsentState {
  const prev = readClientConsent(env);
  const state = buildConsent(choices, { gpc: env.gpc(), prev, now: env.now(), at: opts.at });
  env.setCookie(consentCookieString(state, env.secure()));
  for (const c of OPTIONAL_CATEGORIES) if (!state[c]) clearCategoryStorage(c, env);
  env.emit(state);
  void queueReceipt({
    consentId: state.id,
    policyVersion: state.version,
    analytics: state.analytics,
    marketing: state.marketing,
    gpc: state.gpc,
    action: deriveAction(requested, prev, choices),
    locale,
    at: state.at,
  }, env);
  return state;
}

export const acceptAll = (locale: string, env: ConsentEnv = browserEnv()) => applyConsent(acceptAllChoices(env.gpc()), "accept_all", locale, env);
export const rejectAll = (locale: string, env: ConsentEnv = browserEnv()) => applyConsent(REJECT_ALL, "reject_all", locale, env);

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

/** Opens the preferences dialog from anywhere (footer, policy page, account). No reload. */
export const openConsentPreferences = () => window.dispatchEvent(new Event(CONSENT_OPEN_EVENT));

// --- React binding (useSyncExternalStore) ---------------------------------------------------------------------------

export const subscribeConsent = (cb: () => void) => {
  window.addEventListener(CONSENT_EVENT, cb);
  return () => window.removeEventListener(CONSENT_EVENT, cb);
};
/** Raw cookie value snapshot (a string, so it is referentially stable between renders). */
export const consentSnapshot = (): string => cookieValue(document.cookie, CONSENT_COOKIE) ?? "";

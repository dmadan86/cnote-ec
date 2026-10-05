// Browser side of the consent manager, shared by every app that shows a banner. Every function takes the app's `ConsentConfig`
// (cookie name, policy version, registry, storage keys, receipt path) and an injectable `ConsentEnv` (default: the real browser),
// so the withdrawal / clear logic is unit-testable in node without a DOM. No react / next imports.
import { reconcileAccountConsent, requestedActionFor, type AccountConsent } from "./account-sync";
import { clientClearable, type StorageEntry } from "./registry";
import {
  acceptAllChoices,
  buildConsent,
  CONSENT_EVENT,
  CONSENT_OPEN_EVENT,
  consentCookieString,
  cookieValue,
  deriveAction,
  gpcSignal,
  isConsentId,
  isGranted,
  OPTIONAL_CATEGORIES,
  readConsentFromHeader,
  REJECT_ALL,
  type ConsentAction,
  type ConsentChoices,
  type ConsentState,
  type OptionalCategory,
} from "./state";

export { gpcSignal };

export interface ConsentConfig {
  /** consent cookie name (host-scoped per app): `cnote_consent` (web), `seller_consent` (seller) */
  cookieName: string;
  /** the app's CONSENT_POLICY_VERSION */
  policyVersion: number;
  registry: readonly StorageEntry[];
  /** localStorage key holding the receipts the server has not acknowledged yet (strictly necessary: it IS the consent record) */
  pendingKey: string;
  /** same-origin receipt endpoint, e.g. `/api/consent` */
  receiptPath: string;
}

const PENDING_MAX = 20;

/** Body of POST <receiptPath> (the server adds its own timestamp, the app, the policy hash and, when signed in, the person). */
export interface ConsentReceiptBody {
  consentId: string;
  policyVersion: number;
  analytics: boolean;
  marketing: boolean;
  /** absent on receipts queued by an older build: counts as false */
  functional?: boolean;
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
  return isConsentId(r.consentId) && isNum(r.policyVersion) && typeof r.analytics === "boolean" && typeof r.marketing === "boolean" && (r.functional === undefined || typeof r.functional === "boolean") && typeof r.gpc === "boolean" && typeof r.action === "string" && typeof r.locale === "string" && isNum(r.at);
}

export function browserEnv(cfg: Pick<ConsentConfig, "pendingKey" | "receiptPath">): ConsentEnv {
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
    gpc: () => gpcSignal(),
    now: () => Date.now(),
    emit: (state) => window.dispatchEvent(new CustomEvent<ConsentState>(CONSENT_EVENT, { detail: state })),
    // keepalive: survives the page being closed or navigated right after the click. Static pages, so a plain fetch.
    postReceipt: (body) =>
      fetch(cfg.receiptPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true, credentials: "same-origin" }).then(
        (r) => r.status,
        () => 0,
      ),
    readPending: () => {
      try {
        const parsed: unknown = JSON.parse(localStorage.getItem(cfg.pendingKey) ?? "[]");
        return Array.isArray(parsed) ? parsed.filter(isReceiptBody) : [];
      } catch {
        return [];
      }
    },
    writePending: (list) => {
      try {
        if (list.length === 0) localStorage.removeItem(cfg.pendingKey);
        else localStorage.setItem(cfg.pendingKey, JSON.stringify(list));
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

export const readClientConsent = (cfg: ConsentConfig, env: ConsentEnv = browserEnv(cfg)): ConsentState | null =>
  readConsentFromHeader(env.getCookie(), cfg.cookieName, cfg.policyVersion, env.now());

/** Guard used by client-side writers. False on the server, before a choice, and after withdrawal. */
export function clientGranted(cfg: ConsentConfig, category: OptionalCategory, env?: ConsentEnv): boolean {
  if (!env && typeof document === "undefined") return false;
  return isGranted(readClientConsent(cfg, env), category);
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
export function clearCategoryStorage(cfg: ConsentConfig, category: OptionalCategory, env: ConsentEnv = browserEnv(cfg)) {
  for (const e of clientClearable(cfg.registry, category)) clearEntry(e, env);
}

const samePending = (a: ConsentReceiptBody, b: ConsentReceiptBody) => a.consentId === b.consentId && a.at === b.at;

/**
 * A receipt is stored in localStorage BEFORE it is sent and removed only once the server answered 200 (or rejected it
 * for good), so a failed network, a closed tab or a 5xx never loses the proof of consent (DPDP s.6(10)). The server is
 * idempotent on (consentId, at), so resending is always safe.
 */
export async function queueReceipt(cfg: ConsentConfig, body: ConsentReceiptBody, env: ConsentEnv = browserEnv(cfg)): Promise<void> {
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
export async function flushPendingReceipts(cfg: ConsentConfig, env: ConsentEnv = browserEnv(cfg)): Promise<void> {
  for (const body of env.readPending()) {
    const status = await sendPending(body, env);
    if (status === 0 || status === 429 || status >= 500) return; // offline or throttled: later bodies would fail too, retry on the next load
  }
}

/**
 * Records a choice: cookie, storage cleanup for anything not granted, `cnote:consent` event, then the server receipt
 * (which also expires httpOnly marketing cookies the browser cannot delete).
 * `opts.at` lets account sync adopt the ledger's time instead of "now".
 */
export function applyConsent(
  cfg: ConsentConfig,
  choices: ConsentChoices,
  requested: Exclude<ConsentAction, "withdraw">,
  locale: string,
  env: ConsentEnv = browserEnv(cfg),
  opts: { at?: number } = {},
): ConsentState {
  const prev = readClientConsent(cfg, env);
  const state = buildConsent(choices, { version: cfg.policyVersion, gpc: env.gpc(), prev, now: env.now(), at: opts.at });
  env.setCookie(consentCookieString(cfg.cookieName, state, env.secure()));
  for (const c of OPTIONAL_CATEGORIES) if (!state[c]) clearCategoryStorage(cfg, c, env);
  env.emit(state);
  void queueReceipt(cfg, {
    consentId: state.id,
    policyVersion: state.version,
    analytics: state.analytics,
    marketing: state.marketing,
    functional: state.functional,
    gpc: state.gpc,
    action: deriveAction(requested, prev, choices),
    locale,
    at: state.at,
  }, env);
  return state;
}

export const acceptAll = (cfg: ConsentConfig, locale: string, env: ConsentEnv = browserEnv(cfg)) => applyConsent(cfg, acceptAllChoices(env.gpc()), "accept_all", locale, env);
export const rejectAll = (cfg: ConsentConfig, locale: string, env: ConsentEnv = browserEnv(cfg)) => applyConsent(cfg, REJECT_ALL, "reject_all", locale, env);

/** Opens the preferences dialog from anywhere (footer, policy page, account). No reload. */
export const openConsentPreferences = () => window.dispatchEvent(new Event(CONSENT_OPEN_EVENT));

// --- React binding helpers (useSyncExternalStore) ---------------------------------------------------------------------

export const subscribeConsent = (cb: () => void) => {
  window.addEventListener(CONSENT_EVENT, cb);
  return () => window.removeEventListener(CONSENT_EVENT, cb);
};
/** Raw cookie value snapshot (a string, so it is referentially stable between renders). */
export const consentSnapshot = (cfg: Pick<ConsentConfig, "cookieName">): string => cookieValue(document.cookie, cfg.cookieName) ?? "";

// --- Account sync (signed-in people) ------------------------------------------------------------------------------------

export interface AccountSyncOptions {
  /** sessionStorage key (registered as strictly necessary) marking that this visit was checked against the account ledger */
  syncKey: string;
  /** same-origin endpoint returning the ledger state, e.g. `/api/consent/account` */
  accountPath: string;
}

/** GET the signed-in person's ledger state; null on any network / server trouble (try again on the next load). */
export async function loadAccountConsent(accountPath: string): Promise<AccountConsent | null> {
  try {
    const res = await fetch(accountPath, { credentials: "same-origin", cache: "no-store" });
    return res.ok ? ((await res.json()) as AccountConsent) : null;
  } catch {
    return null;
  }
}

/**
 * Account sync: when there is no valid cookie, or once per visit, ask the app's account endpoint for the ledger and let the NEWER
 * of cookie and ledger win per purpose (a withdrawal elsewhere beats an older grant here). Anonymous visitors cost one tiny request
 * while the banner is showing. Returns true when the cookie was replaced. Shared by the buyer web and the seller app.
 */
export async function syncFromAccount(
  cfg: ConsentConfig,
  sync: AccountSyncOptions,
  locale: string,
  env: ConsentEnv = browserEnv(cfg),
  load: () => Promise<AccountConsent | null> = () => loadAccountConsent(sync.accountPath),
): Promise<boolean> {
  const cookie = readClientConsent(cfg, env);
  if (cookie && env.readSession(sync.syncKey)) return false;
  const account = await load();
  if (!account) return false;
  env.writeSession(sync.syncKey, account.signedIn ? "1" : "0");
  // The visitor may have chosen while the request was in flight: reconcile against the cookie as it is now.
  const decision = reconcileAccountConsent(readClientConsent(cfg, env), account, Math.floor(env.now() / 1000));
  if (decision.kind !== "adopt") return false;
  applyConsent(cfg, decision.choices, requestedActionFor(decision.choices), locale, env, { at: decision.at });
  return true;
}

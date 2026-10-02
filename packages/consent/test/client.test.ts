import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptAll,
  applyConsent,
  browserEnv,
  clearCategoryStorage,
  clientGranted,
  consentSnapshot,
  expireCookie,
  flushPendingReceipts,
  isReceiptBody,
  openConsentPreferences,
  queueReceipt,
  readClientConsent,
  rejectAll,
  subscribeConsent,
  type ConsentConfig,
  type ConsentEnv,
  type ConsentReceiptBody,
} from "../src/client";
import { CONSENT_EVENT, CONSENT_OPEN_EVENT, firstParty, type ConsentState } from "../src";

const NOW = Date.parse("2026-09-30T00:00:00Z");
const CFG: ConsentConfig = {
  cookieName: "app_consent",
  policyVersion: 2,
  pendingKey: "app_consent_pending",
  receiptPath: "/api/consent",
  registry: [
    firstParty("app_consent", "necessary", "cookie", "consent", { unit: "months", n: 12 }),
    firstParty("app_t0", "analytics", "cookie", "timing", { unit: "years", n: 1 }, true), // httpOnly: not client-clearable
    firstParty("_x", "analytics", "cookie", "x", { unit: "years", n: 1 }),
    firstParty("app_ls", "marketing", "localStorage", "ls", { unit: "persistent" }),
    firstParty("app_ss", "marketing", "sessionStorage", "ss", { unit: "session" }),
  ],
};

function fakeEnv(o: { gpc?: boolean; host?: string; cookies?: Record<string, string>; local?: string[]; session?: string[] } = {}) {
  const jar = new Map<string, string>(Object.entries(o.cookies ?? {}));
  const local = new Set(o.local ?? []);
  const session = new Set(o.session ?? []);
  const events: ConsentState[] = [];
  const receipts: ConsentReceiptBody[] = [];
  const writes: string[] = [];
  let pending: ConsentReceiptBody[] = [];
  const server = { status: 200 };
  const env: ConsentEnv = {
    getCookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    setCookie: (c) => {
      writes.push(c);
      const [pair = "", ...attrs] = c.split(";").map((x) => x.trim());
      const i = pair.indexOf("=");
      if (attrs.some((a) => /^max-age=0$/i.test(a))) jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), pair.slice(i + 1));
    },
    removeLocal: (k) => void local.delete(k),
    removeSession: (k) => void session.delete(k),
    hostname: () => o.host ?? "localhost",
    secure: () => false,
    gpc: () => o.gpc ?? false,
    now: () => NOW,
    emit: (s) => void events.push(s),
    postReceipt: async (b) => {
      receipts.push(b);
      return server.status;
    },
    readPending: () => [...pending],
    writePending: (l) => void (pending = [...l]),
    readSession: () => null,
    writeSession: () => undefined,
  };
  return { env, jar, local, session, events, receipts, server, writes, pending: () => pending };
}

describe("applyConsent with the app's config", () => {
  it("writes the app's own cookie at the app's policy version, emits the event and posts a receipt", () => {
    const f = fakeEnv();
    const s = rejectAll(CFG, "en", f.env);
    expect(s.version).toBe(2);
    expect(f.jar.has("app_consent")).toBe(true);
    expect(f.jar.has("cnote_consent")).toBe(false);
    expect(readClientConsent(CFG, f.env)).toMatchObject({ id: s.id, analytics: false });
    expect(f.events).toEqual([s]);
    expect(f.receipts).toEqual([{ consentId: s.id, policyVersion: 2, analytics: false, marketing: false, functional: false, gpc: false, action: "reject_all", locale: "en", at: s.at }]);
  });
  it("Accept all honours GPC (marketing off, functional on) and records it", () => {
    const g = fakeEnv({ gpc: true });
    expect(acceptAll(CFG, "hi", g.env)).toMatchObject({ analytics: true, marketing: false, functional: true, gpc: true });
    expect(g.receipts[0]).toMatchObject({ action: "accept_all", locale: "hi", gpc: true });
  });
  it("withdrawal deletes the category's client storage (cookies on every parent domain too) and is a withdraw receipt", () => {
    const f = fakeEnv({ host: "portal.example.in", cookies: { _x: "1", app_t0: "kept: httpOnly belongs to the server" }, local: ["app_ls"], session: ["app_ss"] });
    applyConsent(CFG, { analytics: true, marketing: true, functional: false }, "custom", "en", f.env);
    f.jar.set("_x", "1");
    f.writes.length = 0;
    applyConsent(CFG, { analytics: false, marketing: false, functional: false }, "custom", "en", f.env);
    expect(f.jar.has("_x")).toBe(false);
    expect(f.local.has("app_ls")).toBe(false);
    expect(f.session.has("app_ss")).toBe(false);
    expect(f.jar.has("app_t0")).toBe(true);
    expect(f.writes.some((w) => w.includes("_x=") && w.includes("Domain=portal.example.in"))).toBe(true);
    expect(f.writes.some((w) => w.includes("Domain=.example.in"))).toBe(true);
    expect(f.receipts.at(-1)?.action).toBe("withdraw");
  });
  it("clientGranted is false off the browser and before a choice, true after the grant", () => {
    expect(clientGranted(CFG, "analytics")).toBe(false); // no document in node
    const f = fakeEnv();
    expect(clientGranted(CFG, "analytics", f.env)).toBe(false);
    applyConsent(CFG, { analytics: true, marketing: false, functional: false }, "custom", "en", f.env);
    expect(clientGranted(CFG, "analytics", f.env)).toBe(true);
    expect(clientGranted(CFG, "marketing", f.env)).toBe(false);
  });
  it("clearCategoryStorage removes only client-clearable entries of that category", () => {
    const f = fakeEnv({ cookies: { _x: "1", app_t0: "1" }, local: ["app_ls"], session: ["app_ss"] });
    clearCategoryStorage(CFG, "analytics", f.env);
    expect([...f.jar.keys()]).toEqual(["app_t0"]);
    expect(f.local.has("app_ls")).toBe(true);
    clearCategoryStorage(CFG, "marketing", f.env);
    expect(f.local.size + f.session.size).toBe(0);
  });
});

describe("expireCookie", () => {
  it("expires on the host only for localhost, IP literals and bare hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "intranet", ""]) {
      const writes: string[] = [];
      expireCookie("c", { setCookie: (x) => void writes.push(x), hostname: () => host });
      expect(writes, host).toHaveLength(1);
    }
  });
  it("expires on every parent domain of a real host", () => {
    const writes: string[] = [];
    expireCookie("c", { setCookie: (x) => void writes.push(x), hostname: () => "a.b.example.com" });
    expect(writes.filter((w) => w.includes("Domain=")).length).toBe(6);
  });
});

describe("reliable receipts (outbox)", () => {
  it("keeps a receipt until the server answers 200, resends it on the next load, and drops permanent refusals", async () => {
    const f = fakeEnv();
    f.server.status = 503;
    rejectAll(CFG, "en", f.env);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.pending()).toHaveLength(1);
    f.server.status = 200;
    await flushPendingReceipts(CFG, f.env);
    expect(f.pending()).toHaveLength(0);
    // 400 can never succeed: drop it; 429 / network failure are retried
    const body = { ...f.receipts[0]!, at: f.receipts[0]!.at + 1 };
    f.server.status = 400;
    await queueReceipt(CFG, body, f.env);
    expect(f.pending()).toHaveLength(0);
    f.server.status = 429;
    await queueReceipt(CFG, body, f.env);
    expect(f.pending()).toHaveLength(1);
    f.server.status = 0;
    await flushPendingReceipts(CFG, f.env);
    expect(f.pending()).toHaveLength(1);
  });
  it("stops at the first transient failure so later receipts are retried in order", async () => {
    const f = fakeEnv();
    const base = { consentId: "d".repeat(32), policyVersion: 2, analytics: false, marketing: false, gpc: false, action: "reject_all" as const, locale: "en" };
    f.env.writePending([{ ...base, at: 10 }, { ...base, at: 11 }]);
    f.server.status = 500;
    await flushPendingReceipts(CFG, f.env);
    expect(f.receipts).toHaveLength(1);
    expect(f.pending()).toHaveLength(2);
  });
  it("only trusts well-formed stored receipts", () => {
    const ok = { consentId: "e".repeat(32), policyVersion: 1, analytics: true, marketing: false, gpc: false, action: "custom", locale: "en", at: 5 };
    expect(isReceiptBody(ok)).toBe(true);
    expect(isReceiptBody({ ...ok, functional: true })).toBe(true);
    for (const bad of [null, "x", 1, { ...ok, consentId: "nope" }, { ...ok, at: "5" }, { ...ok, functional: "yes" }, { ...ok, analytics: 1 }, { ...ok, locale: 3 }, { ...ok, policyVersion: NaN }]) expect(isReceiptBody(bad)).toBe(false);
  });
});

describe("browser binding (jsdom-free fakes)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubBrowser() {
    const store = new Map<string, string>();
    const sstore = new Map<string, string>();
    const listeners = new Map<string, Set<(e: Event) => void>>();
    const fetchMock = vi.fn(async () => ({ status: 200 }));
    const fake = (m: Map<string, string>) => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
    const win = {
      addEventListener: (t: string, cb: (e: Event) => void) => void (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(cb),
      removeEventListener: (t: string, cb: (e: Event) => void) => void listeners.get(t)?.delete(cb),
      dispatchEvent: (e: Event) => {
        listeners.get(e.type)?.forEach((cb) => cb(e));
        return true;
      },
    };
    const doc = { cookie: "app_consent=abc; other=1" };
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("location", { hostname: "portal.example.in", protocol: "https:" });
    vi.stubGlobal("localStorage", fake(store));
    vi.stubGlobal("sessionStorage", fake(sstore));
    vi.stubGlobal("navigator", { globalPrivacyControl: true });
    vi.stubGlobal("fetch", fetchMock);
    return { store, sstore, doc, win, fetchMock };
  }

  it("reads cookies, storage, location, GPC and posts to the configured receipt path with keepalive", async () => {
    const b = stubBrowser();
    const env = browserEnv(CFG);
    expect(env.getCookie()).toContain("app_consent=abc");
    env.setCookie("x=1");
    expect(b.doc.cookie).toBe("x=1");
    expect(env.hostname()).toBe("portal.example.in");
    expect(env.secure()).toBe(true);
    expect(env.gpc()).toBe(true);
    expect(typeof env.now()).toBe("number");
    expect(await env.postReceipt({ consentId: "f".repeat(32), policyVersion: 2, analytics: false, marketing: false, gpc: false, action: "reject_all", locale: "en", at: 1 })).toBe(200);
    expect(b.fetchMock).toHaveBeenCalledWith("/api/consent", expect.objectContaining({ method: "POST", keepalive: true, credentials: "same-origin" }));
  });

  it("maps a failed fetch to status 0 and a blocked storage to harmless no-ops", async () => {
    const b = stubBrowser();
    b.fetchMock.mockRejectedValueOnce(new Error("offline"));
    const env = browserEnv(CFG);
    expect(await env.postReceipt({ consentId: "f".repeat(32), policyVersion: 2, analytics: false, marketing: false, gpc: false, action: "reject_all", locale: "en", at: 1 })).toBe(0);
    env.writePending([{ consentId: "f".repeat(32), policyVersion: 2, analytics: false, marketing: false, gpc: false, action: "reject_all", locale: "en", at: 1 }]);
    expect(env.readPending()).toHaveLength(1);
    env.writePending([]);
    expect(b.store.has("app_consent_pending")).toBe(false);
    b.store.set("app_consent_pending", "{not json");
    expect(env.readPending()).toEqual([]);
    b.store.set("app_consent_pending", '{"a":1}');
    expect(env.readPending()).toEqual([]);
    env.writeSession("k", "v");
    expect(env.readSession("k")).toBe("v");
    env.removeSession("k");
    env.removeLocal("app_consent_pending");

    const boom = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom, removeItem: boom });
    vi.stubGlobal("sessionStorage", { getItem: boom, setItem: boom, removeItem: boom });
    expect(env.readPending()).toEqual([]);
    expect(() => env.writePending([{ consentId: "f".repeat(32), policyVersion: 2, analytics: false, marketing: false, gpc: false, action: "reject_all", locale: "en", at: 1 }])).not.toThrow();
    expect(() => env.writePending([])).not.toThrow();
    expect(env.readSession("k")).toBeNull();
    expect(() => env.writeSession("k", "v")).not.toThrow();
    expect(() => env.removeLocal("x")).not.toThrow();
    expect(() => env.removeSession("x")).not.toThrow();
  });

  it("emits cnote:consent, opens the dialog on cnote:consent-open, and the snapshot is the raw cookie value", () => {
    const b = stubBrowser();
    const env = browserEnv(CFG);
    const seen: unknown[] = [];
    const unsub = subscribeConsent(() => seen.push(1));
    env.emit({ version: 2, id: "a".repeat(32), analytics: false, marketing: false, functional: false, gpc: false, at: 1 });
    expect(seen).toHaveLength(1);
    unsub();
    env.emit({ version: 2, id: "a".repeat(32), analytics: false, marketing: false, functional: false, gpc: false, at: 1 });
    expect(seen).toHaveLength(1);
    const opened = vi.fn();
    b.win.addEventListener(CONSENT_OPEN_EVENT, opened);
    openConsentPreferences();
    expect(opened).toHaveBeenCalled();
    expect(consentSnapshot(CFG)).toBe("abc");
    b.doc.cookie = "none=1";
    expect(consentSnapshot(CFG)).toBe("");
    expect(CONSENT_EVENT).toBe("cnote:consent");
  });
});

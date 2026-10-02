import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileAccountConsent, requestedActionFor, type AccountConsent } from "@/features/consent/account-sync";
import { consentFromRequest, requireConsent } from "@/features/consent/server";
import { buildConsent, CONSENT_COOKIE, CONSENT_MAX_AGE_SECONDS, CONSENT_POLICY_VERSION, consentIdFromCookieValue, serializeConsent, type ConsentState } from "@/features/consent/state";

const h = vi.hoisted(() => ({ states: vi.fn(), set: vi.fn(), session: vi.fn(), list: vi.fn(), rate: vi.fn() }));
vi.mock("@cnote/identity", () => ({ getConsentStates: h.states, setConsent: h.set }));
vi.mock("@cnote/next-kit", () => ({ currentSession: h.session }));
vi.mock("@cnote/compliance", () => ({ listCookieConsentReceipts: h.list }));
vi.mock("@cnote/core", () => ({ rateLimit: h.rate }));

const { effectiveChoiceTime, syncCookieConsentToLedger, loadAccountConsent } = await import("@/features/consent/ledger");
const receiptRoute = await import("@/app/api/consent/receipt/route");
const accountRoute = await import("@/app/api/consent/account/route");

const NOW = Date.parse("2026-10-02T00:00:00Z");
const nowS = Math.floor(NOW / 1000);
const ID = "c".repeat(32);
const state = (o: Partial<ConsentState> = {}): ConsentState => ({ version: CONSENT_POLICY_VERSION, id: ID, analytics: true, marketing: true, functional: false, gpc: false, at: nowS - 1000, ...o });
const acct = (o: Partial<AccountConsent> = {}): AccountConsent => ({ signedIn: true, analytics: null, marketing: null, ...o });

describe("reconcileAccountConsent (newest wins per purpose)", () => {
  it("never acts for anonymous visitors or an empty ledger", () => {
    expect(reconcileAccountConsent(null, null, nowS)).toEqual({ kind: "none" });
    expect(reconcileAccountConsent(null, acct({ signedIn: false, analytics: { granted: true, at: nowS } }), nowS)).toEqual({ kind: "none" });
    expect(reconcileAccountConsent(state(), acct(), nowS)).toEqual({ kind: "none" });
  });
  it("seeds a cookie-less browser from the ledger, with unrecorded purposes off", () => {
    expect(reconcileAccountConsent(null, acct({ analytics: { granted: true, at: nowS - 5 } }), nowS)).toEqual({ kind: "adopt", choices: { analytics: true, marketing: false, functional: false }, at: nowS - 5 });
  });
  it("does not resurrect a ledger older than the 12-month consent lifetime (ask again)", () => {
    expect(reconcileAccountConsent(null, acct({ analytics: { granted: true, at: nowS - CONSENT_MAX_AGE_SECONDS - 10 } }), nowS)).toEqual({ kind: "none" });
  });
  it("a newer withdrawal on another device wins; a newer grant too; an older entry never does", () => {
    const c = state({ at: nowS - 1000 });
    expect(reconcileAccountConsent(c, acct({ marketing: { granted: false, at: nowS - 10 } }), nowS)).toEqual({ kind: "adopt", choices: { analytics: true, marketing: false, functional: false }, at: nowS - 10 });
    expect(reconcileAccountConsent(state({ analytics: false, marketing: false, functional: false }), acct({ analytics: { granted: true, at: nowS - 10 } }), nowS)).toMatchObject({ kind: "adopt", choices: { analytics: true, marketing: false, functional: false } });
    expect(reconcileAccountConsent(c, acct({ analytics: { granted: false, at: nowS - 2000 }, marketing: { granted: false, at: nowS - 2000 } }), nowS)).toEqual({ kind: "none" });
  });
  it("an equal value is not a change even when the ledger is newer", () => {
    expect(reconcileAccountConsent(state(), acct({ analytics: { granted: true, at: nowS }, marketing: { granted: true, at: nowS } }), nowS)).toEqual({ kind: "none" });
  });
  it("derives the action of an adopted choice set", () => {
    expect(requestedActionFor({ analytics: true, marketing: true, functional: true })).toBe("accept_all");
    expect(requestedActionFor({ analytics: false, marketing: false, functional: false })).toBe("reject_all");
    expect(requestedActionFor({ analytics: true, marketing: false, functional: false })).toBe("custom");
  });
});

describe("buildConsent timestamps", () => {
  it("is strictly increasing per consent id so (consentId, at) stays unique", () => {
    const first = buildConsent({ analytics: true, marketing: false, functional: false }, { gpc: false, now: NOW });
    const second = buildConsent({ analytics: false, marketing: false, functional: false }, { gpc: false, now: NOW, prev: first });
    expect(second.id).toBe(first.id);
    expect(second.at).toBe(first.at + 1);
    expect(buildConsent({ analytics: true, marketing: true, functional: false }, { gpc: false, now: NOW + 5000, prev: first }).at).toBe(nowS + 5);
  });
  it("lets account sync adopt the ledger's time", () => {
    expect(buildConsent({ analytics: true, marketing: false, functional: false }, { gpc: false, now: NOW, at: nowS - 50 }).at).toBe(nowS - 50);
  });
});

describe("consentIdFromCookieValue", () => {
  it("reads the id even from an expired or older-version record, and nothing from garbage", () => {
    const old = serializeConsent(state({ version: 0, at: 5 }));
    expect(consentIdFromCookieValue(old)).toBe(ID);
    expect(consentIdFromCookieValue("granted")).toBeNull();
    expect(consentIdFromCookieValue("id=short")).toBeNull();
    expect(consentIdFromCookieValue("%E0%A4%A")).toBeNull();
    expect(consentIdFromCookieValue(undefined)).toBeNull();
  });
});

describe("requireConsent (server helper)", () => {
  const cookie = (s: ConsentState) => `${CONSENT_COOKIE}=${serializeConsent(s)}`;
  const reqWith = (header?: string) => new NextRequest("https://shop.test/ad/x", { headers: header ? { cookie: header } : {} });
  it("is true only for a granted category on a valid record", () => {
    const at = Math.floor(Date.now() / 1000) - 5;
    expect(requireConsent(reqWith(cookie(state({ at, marketing: true }))), "marketing")).toBe(true);
    expect(requireConsent(reqWith(cookie(state({ at, marketing: false }))), "marketing")).toBe(false);
    expect(requireConsent(reqWith(cookie(state({ at, analytics: false }))), "analytics")).toBe(false);
  });
  it("is false with no cookie, an expired one, or a legacy value", () => {
    expect(requireConsent(reqWith(), "marketing")).toBe(false);
    expect(requireConsent(reqWith(cookie(state({ at: 5 }))), "marketing")).toBe(false);
    expect(requireConsent(reqWith(`${CONSENT_COOKIE}=granted`), "marketing")).toBe(false);
    expect(consentFromRequest(reqWith())).toBeNull();
  });
  it("also accepts a cookie store (next/headers cookies())", () => {
    const at = Math.floor(Date.now() / 1000) - 5;
    const jar = { get: (n: string) => (n === CONSENT_COOKIE ? { value: serializeConsent(state({ at })) } : undefined) };
    expect(requireConsent(jar, "marketing")).toBe(true);
    expect(requireConsent({ get: () => undefined }, "marketing")).toBe(false);
  });
});

describe("account ledger sync (server)", () => {
  beforeEach(() => {
    h.states.mockReset();
    h.set.mockReset().mockResolvedValue(undefined);
  });
  it("treats a fresh choice as now even when the device clock is off, but keeps an old resend's own time", () => {
    expect(effectiveChoiceTime(nowS - 120, NOW)).toBe(NOW);
    expect(effectiveChoiceTime(nowS + 200, NOW)).toBe(NOW);
    expect(effectiveChoiceTime(nowS - 86_400, NOW)).toBe((nowS - 86_400) * 1000);
    expect(effectiveChoiceTime(undefined, NOW)).toBe(NOW);
  });
  it("writes both purposes the first time and only what changed afterwards", async () => {
    h.states.mockResolvedValue({ analytics_cookies: null, marketing_cookies: null, functional_cookies: null });
    expect(await syncCookieConsentToLedger("p1", { analytics: true, marketing: false, functional: false }, { now: NOW })).toEqual(["analytics_cookies", "marketing_cookies", "functional_cookies"]);
    expect(h.set).toHaveBeenCalledWith("p1", "analytics_cookies", true, "web_cookie_banner");
    expect(h.set).toHaveBeenCalledWith("p1", "marketing_cookies", false, "web_cookie_banner");
    h.set.mockClear();
    h.states.mockResolvedValue({ analytics_cookies: { granted: true, at: new Date(NOW - 5000) }, marketing_cookies: { granted: true, at: new Date(NOW - 5000) }, functional_cookies: { granted: false, at: new Date(NOW - 5000) } });
    expect(await syncCookieConsentToLedger("p1", { analytics: true, marketing: false, functional: false }, { now: NOW })).toEqual(["marketing_cookies"]);
  });
  it("a late resend of an older choice cannot overwrite a newer withdrawal made elsewhere", async () => {
    h.states.mockResolvedValue({ analytics_cookies: { granted: false, at: new Date(NOW - 1000) }, marketing_cookies: { granted: false, at: new Date(NOW - 1000) }, functional_cookies: { granted: false, at: new Date(NOW - 1000) } });
    const written = await syncCookieConsentToLedger("p1", { analytics: true, marketing: true, functional: true }, { now: NOW, clientAt: nowS - 3 * 86_400 });
    expect(written).toEqual([]);
    expect(h.set).not.toHaveBeenCalled();
  });
  it("exposes the ledger to the browser in unix seconds", async () => {
    h.states.mockResolvedValue({ analytics_cookies: { granted: true, at: new Date(NOW) }, marketing_cookies: null, functional_cookies: null });
    expect(await loadAccountConsent("p1")).toEqual({ signedIn: true, analytics: { granted: true, at: nowS }, marketing: null, functional: null });
  });
});

describe("GET /api/consent/account", () => {
  const get = (headers: Record<string, string> = {}) => accountRoute.GET(new NextRequest("https://shop.test/api/consent/account", { headers }));
  beforeEach(() => {
    h.session.mockReset();
    h.states.mockReset().mockResolvedValue({ analytics_cookies: null, marketing_cookies: null });
  });
  it("answers anonymous visitors without reading the ledger, uncached", async () => {
    h.session.mockResolvedValue(null);
    const res = await get();
    expect(await res.json()).toEqual({ signedIn: false, analytics: null, marketing: null, functional: null });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(h.states).not.toHaveBeenCalled();
  });
  it("returns the signed-in person's ledger and refuses cross-site fetches", async () => {
    h.session.mockResolvedValue({ personId: "p1" });
    expect(await (await get()).json()).toMatchObject({ signedIn: true });
    expect((await get({ "sec-fetch-site": "cross-site" })).status).toBe(403);
  });
});

describe("GET /api/consent/receipt", () => {
  const get = (cookie?: string, headers: Record<string, string> = {}) =>
    receiptRoute.GET(new NextRequest("https://shop.test/api/consent/receipt", { headers: { ...(cookie ? { cookie } : {}), "cf-connecting-ip": "198.18.0.9", ...headers } }));
  beforeEach(() => {
    h.rate.mockReset().mockResolvedValue(true);
    h.list.mockReset().mockResolvedValue([
      { id: "row-1", consentId: ID, policyVersion: 1, analytics: true, marketing: false, functional: false, gpc: true, action: "custom", locale: "hi", personId: "11111111-1111-4111-8111-111111111111", clientAt: nowS, registryHash: "a".repeat(64), createdAt: "2026-10-02T00:00:01.000Z" },
    ]);
  });
  it("is keyed by the cookie's consent id, no-store, as a download, and leaks neither person id nor row id", async () => {
    const res = await get(`${CONSENT_COOKIE}=${serializeConsent(state({ at: 5 }))}`); // even an expired record can be downloaded
    expect(res.status).toBe(200);
    expect(h.list).toHaveBeenCalledWith(ID);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toContain(`consent-record-${ID.slice(0, 8)}.json`);
    const body = await res.json();
    expect(body.consentId).toBe(ID);
    expect(body.receipts).toEqual([{ recordedAt: "2026-10-02T00:00:01.000Z", choiceAt: new Date(nowS * 1000).toISOString(), action: "custom", analytics: true, marketing: false, functional: false, globalPrivacyControl: true, policyVersion: 1, registryHash: "a".repeat(64), language: "hi", signedIn: true }]);
    expect(JSON.stringify(body)).not.toMatch(/11111111|row-1/);
  });
  it("404s without a record, 403s cross-site, 429s when throttled, 503s when the store is down", async () => {
    expect((await get()).status).toBe(404);
    expect((await get(`${CONSENT_COOKIE}=garbage`)).status).toBe(404);
    const c = `${CONSENT_COOKIE}=${serializeConsent(state())}`;
    expect((await get(c, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    h.rate.mockResolvedValue(false);
    expect((await get(c)).status).toBe(429);
    h.rate.mockResolvedValue(true);
    h.list.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await get(c)).status).toBe(503);
    err.mockRestore();
  });
});

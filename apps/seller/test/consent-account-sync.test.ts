import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readClientConsent, syncFromAccount, type ConsentEnv, type ConsentReceiptBody } from "@cnote/consent/client";
import type { AccountConsent } from "@cnote/consent";
import { SELLER_ACCOUNT_SYNC, SELLER_CONSENT_CONFIG, SELLER_CONSENT_SYNC_KEY } from "@/features/consent/config";

// Account sync for signed-in sellers (same mechanism as apps/web/test/consent-v2.test.ts): the choice is mirrored into the identity
// consent ledger under SELLER-specific purposes, read back by GET /api/consent/account, and the newer of cookie and ledger wins.

const h = vi.hoisted(() => ({ states: vi.fn(), set: vi.fn(), session: vi.fn() }));
vi.mock("@cnote/identity", () => ({
  getConsentStates: h.states,
  setConsent: h.set,
  SELLER_COOKIE_CONSENT_PURPOSES: ["seller_analytics_cookies", "seller_marketing_cookies"],
}));
vi.mock("@cnote/next-kit", () => ({ currentSession: h.session }));

const { syncSellerCookieConsentToLedger, loadSellerAccountConsent } = await import("@/features/consent/ledger");
const accountRoute = await import("@/app/api/consent/account/route");

const NOW = Date.parse("2026-10-06T00:00:00Z");
const nowS = Math.floor(NOW / 1000);
const none = { seller_analytics_cookies: null, seller_marketing_cookies: null };

beforeEach(() => {
  h.states.mockReset();
  h.set.mockReset();
  h.session.mockReset();
});

describe("syncSellerCookieConsentToLedger", () => {
  it("writes both seller purposes the first time, with the seller source (never the buyer web's purposes)", async () => {
    h.states.mockResolvedValue(none);
    expect(await syncSellerCookieConsentToLedger("p1", { analytics: true, marketing: false }, { now: NOW })).toEqual(["seller_analytics_cookies", "seller_marketing_cookies"]);
    expect(h.set.mock.calls).toEqual([
      ["p1", "seller_analytics_cookies", true, "seller_cookie_banner"],
      ["p1", "seller_marketing_cookies", false, "seller_cookie_banner"],
    ]);
  });
  it("writes only what changed, and only when the choice is newer than the ledger row", async () => {
    h.states.mockResolvedValue({ seller_analytics_cookies: { granted: true, at: new Date(NOW - 5000) }, seller_marketing_cookies: { granted: true, at: new Date(NOW - 5000) } });
    expect(await syncSellerCookieConsentToLedger("p1", { analytics: true, marketing: false }, { now: NOW })).toEqual(["seller_marketing_cookies"]);
    h.set.mockReset();
    // an offline receipt from yesterday arrives late: it must not overwrite the newer ledger row
    h.states.mockResolvedValue({ seller_analytics_cookies: { granted: true, at: new Date(NOW - 1000) }, seller_marketing_cookies: { granted: true, at: new Date(NOW - 1000) } });
    expect(await syncSellerCookieConsentToLedger("p1", { analytics: false, marketing: false }, { now: NOW, clientAt: nowS - 86_400 })).toEqual([]);
    expect(h.set).not.toHaveBeenCalled();
  });
  it("loadSellerAccountConsent maps ledger rows to unix seconds and never reports a functional choice", async () => {
    h.states.mockResolvedValue({ seller_analytics_cookies: { granted: true, at: new Date(NOW) }, seller_marketing_cookies: null });
    expect(await loadSellerAccountConsent("p1")).toEqual({ signedIn: true, analytics: { granted: true, at: nowS }, marketing: null, functional: null });
  });
});

describe("GET /api/consent/account (seller)", () => {
  const req = (headers: Record<string, string> = {}) => new NextRequest("http://localhost:3002/api/consent/account", { headers });
  it("answers anonymous visitors without touching the database", async () => {
    h.session.mockResolvedValue(null);
    const res = await accountRoute.GET(req());
    expect(await res.json()).toEqual({ signedIn: false, analytics: null, marketing: null, functional: null });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(h.states).not.toHaveBeenCalled();
  });
  it("returns the signed-in seller's ledger and rejects cross-site fetches", async () => {
    h.session.mockResolvedValue({ personId: "p1" });
    h.states.mockResolvedValue({ seller_analytics_cookies: { granted: false, at: new Date(NOW) }, seller_marketing_cookies: null });
    const res = await accountRoute.GET(req());
    expect(await res.json()).toMatchObject({ signedIn: true, analytics: { granted: false, at: nowS } });
    expect((await accountRoute.GET(req({ "sec-fetch-site": "cross-site" }))).status).toBe(403);
  });
  it("is unavailable (503) when the ledger read fails", async () => {
    h.session.mockResolvedValue({ personId: "p1" });
    h.states.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await accountRoute.GET(req())).status).toBe(503);
  });
});

function fakeEnv() {
  const jar = new Map<string, string>();
  const flags = new Map<string, string>();
  const receipts: ConsentReceiptBody[] = [];
  let pending: ConsentReceiptBody[] = [];
  const env: ConsentEnv = {
    getCookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    setCookie: (c) => {
      const [pair = "", ...attrs] = c.split(";").map((x) => x.trim());
      const i = pair.indexOf("=");
      if (attrs.some((a) => /^max-age=0$/i.test(a))) jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), pair.slice(i + 1));
    },
    removeLocal: () => undefined,
    removeSession: () => undefined,
    hostname: () => "localhost",
    secure: () => false,
    gpc: () => false,
    now: () => NOW,
    emit: () => undefined,
    postReceipt: async (b) => (receipts.push(b), 200),
    readPending: () => [...pending],
    writePending: (l) => void (pending = [...l]),
    readSession: (k) => flags.get(k) ?? null,
    writeSession: (k, v) => void flags.set(k, v),
  };
  return { env, flags, receipts };
}
const ledger = (o: Partial<AccountConsent>): AccountConsent => ({ signedIn: true, analytics: null, marketing: null, ...o });
const sync = (f: ReturnType<typeof fakeEnv>, load: () => Promise<AccountConsent | null>) => syncFromAccount(SELLER_CONSENT_CONFIG, SELLER_ACCOUNT_SYNC, "hi", f.env, load);

describe("seller client syncFromAccount", () => {
  it("uses the seller's own endpoint and session flag", () => {
    expect(SELLER_ACCOUNT_SYNC).toEqual({ syncKey: "seller_consent_sync", accountPath: "/api/consent/account" });
    expect(SELLER_CONSENT_SYNC_KEY).toBe("seller_consent_sync");
  });
  it("seeds a new device's seller_consent cookie from the ledger and posts a receipt with the ledger's time", async () => {
    const f = fakeEnv();
    expect(await sync(f, async () => ledger({ analytics: { granted: true, at: nowS - 100 }, marketing: { granted: false, at: nowS - 50 } }))).toBe(true);
    expect(readClientConsent(SELLER_CONSENT_CONFIG, f.env)).toMatchObject({ analytics: true, marketing: false, functional: false });
    expect(f.flags.get(SELLER_CONSENT_SYNC_KEY)).toBe("1");
    await Promise.resolve();
    expect(f.receipts[0]).toMatchObject({ analytics: true, marketing: false, action: "custom", locale: "hi" });
  });
  it("does nothing for anonymous visitors, offline, or an empty ledger; remembers the check for the visit", async () => {
    const f = fakeEnv();
    expect(await sync(f, async () => ({ signedIn: false, analytics: null, marketing: null }))).toBe(false);
    expect(f.flags.get(SELLER_CONSENT_SYNC_KEY)).toBe("0");
    expect(await sync(fakeEnv(), async () => null)).toBe(false);
    expect(await sync(fakeEnv(), async () => ledger({}))).toBe(false);
  });
  it("a newer withdrawal on another device beats this browser's older grant; an older ledger row never does", async () => {
    const f = fakeEnv();
    await sync(f, async () => ledger({ analytics: { granted: true, at: nowS - 500 }, marketing: { granted: true, at: nowS - 500 } }));
    f.flags.clear();
    expect(await sync(f, async () => ledger({ marketing: { granted: false, at: nowS - 10 } }))).toBe(true);
    expect(readClientConsent(SELLER_CONSENT_CONFIG, f.env)).toMatchObject({ analytics: true, marketing: false });
    f.flags.clear();
    expect(await sync(f, async () => ledger({ analytics: { granted: false, at: nowS - 5000 } }))).toBe(false);
  });
});

import { serializeConsent, type ConsentState } from "@cnote/consent";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake cookie store standing in for `await cookies()`.
const h = vi.hoisted(() => {
  const jar = new Map<string, string>();
  const store = {
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: vi.fn((name: string, value: string) => void jar.set(name, value)),
    delete: vi.fn((name: string) => void jar.delete(name)),
  };
  return { jar, store };
});
vi.mock("next/headers", () => ({ cookies: async () => h.store }));

const { SELLER_CONSENT_COOKIE, SELLER_POLICY_VERSION } = await import("@/features/consent/registry");
const { requireSellerConsent, sellerConsent } = await import("@/features/consent/server");
const { ONB, readOnb, writeOnb, clearOnb } = await import("@/lib/cookies");
const ref = await import("@/app/api/consent/ref/route");

const state = (over: Partial<ConsentState> = {}): ConsentState => ({ version: SELLER_POLICY_VERSION, id: "c".repeat(32), analytics: false, marketing: false, functional: false, gpc: false, at: Math.floor(Date.now() / 1000) - 60, ...over });
const consent = (over: Partial<ConsentState> = {}) => h.jar.set(SELLER_CONSENT_COOKIE, serializeConsent(state(over)));

beforeEach(() => {
  h.jar.clear();
  h.store.set.mockClear();
  h.store.delete.mockClear();
});

describe("sellerConsent / requireSellerConsent (the seller's own cookie and policy version)", () => {
  it("is off before a choice, for an older policy version and for junk", () => {
    expect(requireSellerConsent(h.store, "analytics")).toBe(false);
    h.jar.set(SELLER_CONSENT_COOKIE, serializeConsent(state({ version: SELLER_POLICY_VERSION + 1, analytics: true })));
    expect(sellerConsent(h.store)).toBeNull();
    h.jar.set(SELLER_CONSENT_COOKIE, "granted");
    expect(requireSellerConsent(h.store, "marketing")).toBe(false);
  });
  it("grants exactly what was chosen, from a cookie store or a request", () => {
    consent({ analytics: true });
    expect(requireSellerConsent(h.store, "analytics")).toBe(true);
    expect(requireSellerConsent(h.store, "marketing")).toBe(false);
    const req = new NextRequest("https://seller.test/x", { headers: { cookie: `${SELLER_CONSENT_COOKIE}=${serializeConsent(state({ marketing: true }))}` } });
    expect(requireSellerConsent(req, "marketing")).toBe(true);
    expect(requireSellerConsent(req, "analytics")).toBe(false);
  });
  it("does not read the buyer web's cookie (cookies are per app)", () => {
    h.jar.set("cnote_consent", serializeConsent(state({ analytics: true, marketing: true })));
    expect(requireSellerConsent(h.store, "analytics")).toBe(false);
  });
});

describe("onboarding cookies: optional ones need consent, necessary ones do not", () => {
  it("writes no start-time (timing) cookie without analytics consent, and writes it with", async () => {
    await writeOnb(ONB.startedAt, "1");
    expect(h.store.set).not.toHaveBeenCalled();
    consent({ analytics: true });
    await writeOnb(ONB.startedAt, "1");
    expect(h.store.set).toHaveBeenCalledWith(ONB.startedAt, "1", expect.objectContaining({ httpOnly: true, sameSite: "lax" }));
  });
  it("analytics consent does not unlock the marketing cookie", async () => {
    consent({ analytics: true });
    await writeOnb(ONB.referral, "ABCD1234");
    expect(h.store.set).not.toHaveBeenCalled();
    consent({ marketing: true });
    await writeOnb(ONB.referral, "ABCD1234");
    expect(h.store.set).toHaveBeenCalledTimes(1);
  });
  it("always stores progress the seller caused (skip, done, first listing submitted) and the language, with no consent at all", async () => {
    await writeOnb(ONB.done, "1");
    await writeOnb(ONB.skipGst, "1");
    await writeOnb(ONB.skipListing, "1");
    await writeOnb(ONB.firstListing, String(Date.now()));
    await writeOnb("seller_locale", "hi");
    expect(h.store.set).toHaveBeenCalledTimes(5);
    expect(await readOnb(ONB.done)).toBe("1");
    await clearOnb(ONB.done);
    expect(await readOnb(ONB.done)).toBeUndefined();
  });
});

describe("POST /api/consent/ref (referral code after a late marketing grant)", () => {
  const post = (body: unknown, headers: Record<string, string> = {}, cookie?: string) =>
    ref.POST(new NextRequest("https://seller.test/api/consent/ref", { method: "POST", headers: { "content-type": "application/json", origin: "https://seller.test", ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body) }));
  const marketing = `${SELLER_CONSENT_COOKIE}=${serializeConsent(state({ marketing: true }))}`;

  it("stores the code only with marketing consent", async () => {
    const without = await post({ ref: "ABCD1234" });
    expect(await without.json()).toEqual({ stored: false });
    expect(without.headers.getSetCookie()).toEqual([]);
    const withGrant = await post({ ref: "ABCD1234" }, {}, marketing);
    expect(await withGrant.json()).toEqual({ stored: true });
    expect(withGrant.headers.getSetCookie().join("|")).toMatch(/seller_ref=ABCD1234.*HttpOnly/i);
  });
  it("rejects a malformed code and a cross-origin call", async () => {
    expect((await post({ ref: "no spaces!" }, {}, marketing)).status).toBe(400);
    expect((await post({}, {}, marketing)).status).toBe(400);
    expect((await post({ ref: "ABCD1234" }, { origin: "https://evil.test" }, marketing)).status).toBe(403);
  });
});

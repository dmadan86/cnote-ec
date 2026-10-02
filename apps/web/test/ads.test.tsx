import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ recordClick: vi.fn() }));
vi.mock("@cnote/ads", () => ({ recordClick: h.recordClick, isAdsEnabled: () => true }));
vi.mock("@cnote/next-kit", () => ({ currentSession: async () => null, requestContext: async () => ({ ip: "1.2.3.4", userAgent: "Mozilla/5.0" }) }));

const { SponsoredLabel } = await import("@/features/ads/label");
const { SponsoredLink } = await import("@/features/ads/sponsored-link");
const { GET } = await import("@/app/ad/[token]/route");
const { CONSENT_POLICY_VERSION, serializeConsent } = await import("@/features/consent/state");

// `consent`: marketing granted (cnote_consent, features/consent/state.ts); `vid`: an existing visitor cookie.
const consentValue = (marketing: boolean) =>
  serializeConsent({ version: CONSENT_POLICY_VERSION, id: "f".repeat(32), analytics: false, marketing, functional: false, gpc: false, at: Math.floor(Date.now() / 1000) - 5 });
const req = (url: string, o: { vid?: string; marketing?: boolean } = {}) => {
  const u = new URL(url);
  const jar: Record<string, string> = { ...(o.vid ? { cnote_vid: o.vid } : {}), ...(o.marketing === undefined ? {} : { cnote_consent: consentValue(o.marketing) }) };
  return { nextUrl: u, cookies: { get: (n: string) => (n in jar ? { value: jar[n] } : undefined) } } as never;
};

describe("Sponsored label (ADR-009, E-Commerce Rules r.5(15))", () => {
  it("is visible text, not colour alone, with a screen-reader phrase, and is neutral (no brand/accent colours)", () => {
    const html = renderToStaticMarkup(<SponsoredLabel label="Sponsored" srLabel="Sponsored listing" />);
    expect(html).toContain("Sponsored");
    expect(html).toContain("sr-only");
    expect(html).toContain("Sponsored listing");
    expect(html).toContain("border-ink");
    expect(html).not.toMatch(/brand|accent/);
  });
  it("ad links are rel=sponsored nofollow", () => {
    expect(renderToStaticMarkup(<SponsoredLink href="/ad/x">t</SponsoredLink>)).toContain('rel="sponsored nofollow noopener"');
  });
});

describe("GET /ad/[token]", () => {
  it("records the click, then 302s to the localised product, setting visitor and attribution cookies (marketing consent granted)", async () => {
    h.recordClick.mockResolvedValueOnce({ status: "recorded", listingId: "11111111-1111-4111-8111-111111111111", clickId: "c1", validity: "valid", chargedPaise: 500 });
    const res = await GET(req("https://x.test/ad/tok?l=hi", { marketing: true }), { params: Promise.resolve({ token: "tok" }) });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/hi/p/11111111-1111-4111-8111-111111111111");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    const cookies = res.headers.getSetCookie().join(";");
    expect(cookies).toContain("cnote_vid=");
    expect(cookies).toContain("cnote_ad_click=c1");
    expect(h.recordClick.mock.calls[0]![1]).toMatchObject({ ip: "1.2.3.4", userAgent: "Mozilla/5.0" });
  });
  it("without marketing consent the click is still recorded and redirected, but cnote_vid and cnote_ad_click are never set or read", async () => {
    h.recordClick.mockResolvedValue({ status: "recorded", listingId: "11111111-1111-4111-8111-111111111111", clickId: "c2", validity: "valid", chargedPaise: 500 });
    for (const marketing of [undefined, false]) {
      h.recordClick.mockClear();
      const res = await GET(req("https://x.test/ad/tok", { marketing, vid: "vid-from-before" }), { params: Promise.resolve({ token: "tok" }) });
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/p/11111111-1111-4111-8111-111111111111");
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(h.recordClick.mock.calls[0]![1].visitorId).not.toBe("vid-from-before"); // legacy cookie ignored: no consent
    }
    h.recordClick.mockReset();
  });
  it("with consent an existing visitor cookie is reused and not re-set", async () => {
    h.recordClick.mockResolvedValueOnce({ status: "recorded", listingId: "11111111-1111-4111-8111-111111111111", clickId: "c3", validity: "valid", chargedPaise: 0 });
    const res = await GET(req("https://x.test/ad/tok", { marketing: true, vid: "vid-existing" }), { params: Promise.resolve({ token: "tok" }) });
    expect(h.recordClick.mock.calls.at(-1)![1].visitorId).toBe("vid-existing");
    expect(res.headers.getSetCookie().join(";")).not.toContain("cnote_vid=");
    expect(res.headers.getSetCookie().join(";")).toContain("cnote_ad_click=c3");
  });
  it("invalid tokens and internal errors still redirect (never an error page) and set no attribution cookie", async () => {
    h.recordClick.mockResolvedValueOnce({ status: "invalid_token" });
    const a = await GET(req("https://x.test/ad/bad", { vid: "vid", marketing: true }), { params: Promise.resolve({ token: "bad" }) });
    expect(a.status).toBe(302);
    expect(new URL(a.headers.get("location")!).pathname).toBe("/");
    expect(a.headers.getSetCookie().join(";")).not.toContain("cnote_ad_click");
    h.recordClick.mockRejectedValueOnce(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const b = await GET(req("https://x.test/ad/t?l=zz"), { params: Promise.resolve({ token: "t" }) });
    expect(b.status).toBe(302);
    err.mockRestore();
  });
  it("replays and expired tokens redirect to the product without an attribution cookie", async () => {
    h.recordClick.mockResolvedValueOnce({ status: "replay", listingId: "22222222-2222-4222-8222-222222222222" });
    const res = await GET(req("https://x.test/ad/t"), { params: Promise.resolve({ token: "t" }) });
    expect(new URL(res.headers.get("location")!).pathname).toBe("/p/22222222-2222-4222-8222-222222222222");
    expect(res.headers.getSetCookie().join(";")).not.toContain("cnote_ad_click");
  });
});

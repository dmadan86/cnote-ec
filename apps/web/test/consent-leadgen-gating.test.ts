import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeConsent, CONSENT_COOKIE, CONSENT_POLICY_VERSION } from "@/features/consent/state";

// Marketing gating of the leadgen browser helpers: with no consent nothing is written; with consent they persist.
const consentCookie = (marketing: boolean) => `${CONSENT_COOKIE}=${serializeConsent({ version: CONSENT_POLICY_VERSION, id: "c".repeat(32), analytics: false, marketing, gpc: false, at: Math.floor(Date.now() / 1000) - 5 })}`;

function browser(cookie: string) {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: vi.fn((k: string, v: string) => void m.set(k, v)), removeItem: (k: string) => void m.delete(k), map: m };
  };
  const doc = { cookie, referrer: "https://ads.example.org/landing?x=1" } as { cookie: string; referrer: string };
  const writes: string[] = [];
  Object.defineProperty(doc, "cookie", { get: () => cookie, set: (v: string) => void writes.push(v), configurable: true });
  const local = store();
  const session = store();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("location", { protocol: "https:", pathname: "/p/abc", search: "?utm_source=news&utm_campaign=x", origin: "https://x.test" });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  return { writes, local, session };
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("leadgen helpers without marketing consent", () => {
  it("getVisitorId returns a stable in-memory id and writes no cookie", async () => {
    const b = browser("");
    const { getVisitorId } = await import("@/features/leadgen/visitor");
    const id = getVisitorId();
    expect(id).toMatch(/^v[a-f0-9]{32}$/);
    expect(getVisitorId()).toBe(id);
    expect(b.writes).toEqual([]);
  });
  it("does not persist a legacy visitor cookie's value either (marketing is denied)", async () => {
    browser(`cnote_vid=vlegacyid1234; ${consentCookie(false)}`);
    const { getVisitorId } = await import("@/features/leadgen/visitor");
    expect(getVisitorId()).not.toBe("vlegacyid1234");
  });
  it("captureAttribution collects no UTM/referrer and stores nothing", async () => {
    const b = browser(consentCookie(false));
    const { captureAttribution } = await import("@/features/leadgen/visitor");
    expect(captureAttribution()).toEqual({ landingPath: "/p/abc", device: "desktop" });
    expect(b.session.setItem).not.toHaveBeenCalled();
  });
  it("the nudge store keeps caps in memory only: same behaviour, no localStorage/sessionStorage writes", async () => {
    const b = browser("");
    const s = await import("@/features/leadgen/store");
    expect(s.isNewSession()).toBe(true);
    expect(s.isNewSession()).toBe(false);
    expect(s.trackView("a")).toBe(1);
    expect(s.trackView("b")).toBe(2);
    expect(s.trackView("a")).toBe(2);
    const next = { ...s.loadStore(), dismissed: { enquiry: 1 } } as never;
    s.saveStore(next);
    expect(s.loadStore()).toBe(next);
    expect(b.local.setItem).not.toHaveBeenCalled();
    expect(b.session.setItem).not.toHaveBeenCalled();
  });
});

describe("leadgen helpers with marketing consent", () => {
  it("persist the visitor id (30 days), attribution and nudge state", async () => {
    const b = browser(consentCookie(true));
    const v = await import("@/features/leadgen/visitor");
    const id = v.getVisitorId();
    expect(b.writes[0]).toMatch(new RegExp(`^cnote_vid=${id}; Max-Age=${60 * 60 * 24 * 30}; Path=/; SameSite=Lax; Secure$`));
    const a = v.captureAttribution();
    expect(a).toMatchObject({ utm_source: "news", utm_campaign: "x", referrer: "https://ads.example.org/landing" });
    expect(b.session.setItem).toHaveBeenCalledWith("cnote_attr", expect.any(String));
    const s = await import("@/features/leadgen/store");
    s.saveStore(s.loadStore());
    expect(b.local.setItem).toHaveBeenCalledWith("cnote_lg_v1", expect.any(String));
    expect(s.isNewSession()).toBe(true);
    expect(s.isNewSession()).toBe(false);
  });
});

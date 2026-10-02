import { describe, expect, it } from "vitest";
import {
  acceptAllChoices,
  buildConsent,
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_SECONDS,
  CONSENT_POLICY_VERSION,
  consentCookieString,
  cookieValue,
  deriveAction,
  isGranted,
  marketingGrantedInHeader,
  newConsentId,
  parseConsent,
  readConsentFromHeader,
  REJECT_ALL,
  serializeConsent,
  type ConsentState,
} from "@/features/consent/state";

const NOW = Date.parse("2026-09-30T00:00:00Z");
const at = (offsetSeconds = 0) => Math.floor(NOW / 1000) + offsetSeconds;
const state = (over: Partial<ConsentState> = {}): ConsentState => ({ version: CONSENT_POLICY_VERSION, id: "a".repeat(32), analytics: true, marketing: false, functional: false, gpc: false, at: at(-60), ...over });

describe("consent cookie: serialize / parse", () => {
  it("round-trips a state through the URL-encoded compact format", () => {
    const s = state();
    const raw = serializeConsent(s);
    expect(decodeURIComponent(raw)).toBe(`v=${CONSENT_POLICY_VERSION}&id=${"a".repeat(32)}&a=1&m=0&f=0&t=${s.at}&gpc=0`);
    expect(raw).not.toMatch(/[&=]/); // fully URL-encoded: safe as a cookie value
    expect(parseConsent(raw, NOW)).toEqual(s);
  });
  it("accepts the already-decoded value too (framework cookie jars decode)", () => {
    expect(parseConsent(decodeURIComponent(serializeConsent(state({ marketing: true, functional: false, gpc: true }))), NOW)).toMatchObject({ marketing: true, functional: false, gpc: true });
  });
  it("treats legacy 'granted' / 'denied' and other junk as no choice (re-prompt)", () => {
    for (const v of ["granted", "denied", "", undefined, null, "%E0%A4%A", "v=1", "a=1&m=1", `v=1&id=short&a=1&m=1&t=${at()}&gpc=0`]) expect(parseConsent(v, NOW), String(v)).toBeNull();
  });
  it("rejects malformed flags, timestamps and ids", () => {
    const ok = (o: Record<string, string>) => encodeURIComponent(new URLSearchParams({ v: String(CONSENT_POLICY_VERSION), id: "b".repeat(32), a: "1", m: "1", t: String(at(-5)), gpc: "0", ...o }).toString());
    expect(parseConsent(ok({}), NOW)).not.toBeNull();
    for (const bad of [{ a: "2" }, { m: "yes" }, { gpc: "" }, { t: "abc" }, { t: "0" }, { t: "1.5" }, { id: "B".repeat(32) }, { id: "z".repeat(32) }] as Record<string, string>[]) expect(parseConsent(ok(bad), NOW), JSON.stringify(bad)).toBeNull();
  });
  it("re-prompts everyone when the policy version changes", () => {
    const raw = serializeConsent(state({ version: CONSENT_POLICY_VERSION + 1 }));
    expect(parseConsent(raw, NOW)).toBeNull();
    expect(parseConsent(serializeConsent(state({ version: CONSENT_POLICY_VERSION - 1 })), NOW)).toBeNull();
  });
  it("expires after 12 months (under CNIL's 13-month maximum) and ignores timestamps from the future", () => {
    expect(CONSENT_MAX_AGE_SECONDS).toBe(365 * 24 * 3600);
    expect(CONSENT_MAX_AGE_SECONDS).toBeLessThan(13 * 30 * 24 * 3600);
    expect(parseConsent(serializeConsent(state({ at: at(-CONSENT_MAX_AGE_SECONDS + 10) })), NOW)).not.toBeNull();
    expect(parseConsent(serializeConsent(state({ at: at(-CONSENT_MAX_AGE_SECONDS - 10) })), NOW)).toBeNull();
    expect(parseConsent(serializeConsent(state({ at: at(3600) })), NOW)).toBeNull();
    expect(parseConsent(serializeConsent(state({ at: at(120) })), NOW)).not.toBeNull(); // small clock skew is fine
  });
  it("cookie Max-Age matches the expiry, is Lax, and Secure only on https", () => {
    const c = consentCookieString(state(), true);
    expect(c).toContain(`${CONSENT_COOKIE}=`);
    expect(c).toContain(`Max-Age=${CONSENT_MAX_AGE_SECONDS}`);
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).toContain("; Secure");
    expect(consentCookieString(state(), false)).not.toContain("Secure");
    expect(c).not.toContain("HttpOnly"); // client islands must read it
  });
});

describe("consent: server-side reads (route handlers / Cookie header)", () => {
  it("finds the consent cookie in a Cookie header and gates marketing on it", () => {
    const yes = `a=b; ${CONSENT_COOKIE}=${serializeConsent(state({ marketing: true }))}; c=d`;
    const no = `${CONSENT_COOKIE}=${serializeConsent(state({ marketing: false }))}`;
    expect(readConsentFromHeader(yes, NOW)?.marketing).toBe(true);
    expect(marketingGrantedInHeader(yes, NOW)).toBe(true);
    expect(marketingGrantedInHeader(no, NOW)).toBe(false);
    expect(marketingGrantedInHeader(`${CONSENT_COOKIE}=granted`, NOW)).toBe(false);
    expect(marketingGrantedInHeader(undefined, NOW)).toBe(false);
    expect(marketingGrantedInHeader("cnote_vid=abc", NOW)).toBe(false);
    expect(cookieValue("x=1;  y = 2", "y")).toBe("2");
    expect(isGranted(null, "analytics")).toBe(false);
  });
});

describe("consent: defaults, GPC and actions", () => {
  it("nothing is pre-ticked", () => {
    expect(REJECT_ALL).toEqual({ analytics: false, marketing: false, functional: false });
  });
  it("Accept all grants everything, except marketing when Global Privacy Control is on", () => {
    expect(acceptAllChoices(false)).toEqual({ analytics: true, marketing: true, functional: true });
    expect(acceptAllChoices(true)).toEqual({ analytics: true, marketing: false, functional: true }); // GPC never touches functional
  });
  it("buildConsent stamps version/time/gpc and keeps the browser's consent id across changes", () => {
    const first = buildConsent(REJECT_ALL, { gpc: true, now: NOW });
    expect(first).toMatchObject({ version: CONSENT_POLICY_VERSION, analytics: false, marketing: false, functional: false, gpc: true, at: at() });
    expect(first.id).toMatch(/^[a-f0-9]{32}$/);
    expect(buildConsent({ analytics: true, marketing: true, functional: false }, { gpc: true, prev: first, now: NOW + 5000 }).id).toBe(first.id); // explicit opt-in despite GPC is allowed
    expect(newConsentId()).not.toBe(newConsentId());
  });
  it("switching off something previously granted is a withdrawal, whichever button was used", () => {
    const prev = state({ analytics: true, marketing: true, functional: false });
    expect(deriveAction("accept_all", prev, { analytics: true, marketing: true, functional: false })).toBe("accept_all");
    expect(deriveAction("reject_all", prev, REJECT_ALL)).toBe("withdraw");
    expect(deriveAction("custom", prev, { analytics: true, marketing: false, functional: false })).toBe("withdraw");
    expect(deriveAction("custom", prev, { analytics: true, marketing: true, functional: false })).toBe("custom");
    expect(deriveAction("reject_all", null, REJECT_ALL)).toBe("reject_all");
    expect(deriveAction("reject_all", state({ analytics: false, marketing: false, functional: false }), REJECT_ALL)).toBe("reject_all");
  });
});

describe("functional (preferences & personalisation) category", () => {
  const cookieFor = (extra: string) => encodeURIComponent(`v=${CONSENT_POLICY_VERSION}&id=${"a".repeat(32)}&a=1&m=1${extra}&t=${at(-60)}&gpc=0`);
  it("a cookie without `f` parses as functional NOT granted (old cookies are never read as consent)", () => {
    expect(parseConsent(cookieFor(""), NOW)).toMatchObject({ analytics: true, marketing: true, functional: false });
  });
  it("reads f=1 and f=0, and rejects a malformed f", () => {
    expect(parseConsent(cookieFor("&f=1"), NOW)?.functional).toBe(true);
    expect(parseConsent(cookieFor("&f=0"), NOW)?.functional).toBe(false);
    expect(parseConsent(cookieFor("&f=yes"), NOW)).toBeNull();
  });
  it("is granted only by its own flag, so analytics or marketing never imply it", () => {
    expect(isGranted(state({ analytics: true, marketing: true, functional: false }), "functional")).toBe(false);
    expect(isGranted(state({ analytics: false, marketing: false, functional: true }), "functional")).toBe(true);
  });
  it("switching only functional off is a withdrawal", () => {
    const prev = state({ functional: true });
    expect(deriveAction("custom", prev, { analytics: true, marketing: false, functional: false })).toBe("withdraw");
  });
});

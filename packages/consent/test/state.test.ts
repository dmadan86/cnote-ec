import { describe, expect, it } from "vitest";
import {
  acceptAllChoices,
  buildConsent,
  CONSENT_APPS,
  CONSENT_MAX_AGE_SECONDS,
  consentCookieString,
  consentIdFromCookieValue,
  cookieValue,
  deriveAction,
  gpcFromHeader,
  gpcSignal,
  isConsentId,
  isGranted,
  needsPrompt,
  newConsentId,
  parseConsent,
  readConsentFromHeader,
  REJECT_ALL,
  serializeConsent,
  type ConsentState,
} from "../src";

const V = 3;
const NOW = Date.parse("2026-09-30T00:00:00Z");
const at = (offset = 0) => Math.floor(NOW / 1000) + offset;
const state = (over: Partial<ConsentState> = {}): ConsentState => ({ version: V, id: "a".repeat(32), analytics: true, marketing: false, functional: false, gpc: false, at: at(-60), ...over });

describe("consent cookie: serialize / parse (policy version is the app's)", () => {
  it("round-trips through the URL-encoded compact format", () => {
    const s = state();
    const raw = serializeConsent(s);
    expect(decodeURIComponent(raw)).toBe(`v=3&id=${"a".repeat(32)}&a=1&m=0&f=0&t=${s.at}&gpc=0`);
    expect(raw).not.toMatch(/[&=]/);
    expect(parseConsent(raw, V, NOW)).toEqual(s);
  });
  it("accepts the already-decoded value, and treats a missing f as not granted", () => {
    expect(parseConsent(decodeURIComponent(serializeConsent(state({ marketing: true, gpc: true }))), V, NOW)).toMatchObject({ marketing: true, gpc: true });
    const noF = encodeURIComponent(`v=3&id=${"b".repeat(32)}&a=1&m=1&t=${at(-5)}&gpc=0`);
    expect(parseConsent(noF, V, NOW)).toMatchObject({ functional: false, analytics: true, marketing: true });
  });
  it("a record of another policy version is no choice: each app versions its own registry", () => {
    expect(parseConsent(serializeConsent(state({ version: 1 })), V, NOW)).toBeNull();
    expect(parseConsent(serializeConsent(state({ version: 1 })), 1, NOW)).not.toBeNull();
  });
  it("treats legacy values, junk, malformed flags, bad ids and bad times as no choice", () => {
    for (const v of ["granted", "denied", "", undefined, null, "%E0%A4%A", "v=1", `v=3&id=short&a=1&m=1&t=${at()}&gpc=0`]) expect(parseConsent(v, V, NOW), String(v)).toBeNull();
    const ok = (o: Record<string, string>) => encodeURIComponent(new URLSearchParams({ v: "3", id: "b".repeat(32), a: "1", m: "1", t: String(at(-5)), gpc: "0", ...o }).toString());
    for (const bad of [{ a: "2" }, { m: "x" }, { f: "9" }, { gpc: "" }, { t: "abc" }, { t: "0" }, { t: "1.5" }, { t: String(at(600)) }, { t: String(at(-CONSENT_MAX_AGE_SECONDS - 10)) }] as Record<string, string>[]) expect(parseConsent(ok(bad), V, NOW), JSON.stringify(bad)).toBeNull();
    expect(parseConsent(ok({ t: String(at(120)) }), V, NOW)).not.toBeNull(); // within the clock-skew tolerance
  });
  it("reads the consent id even from an expired or older-version record", () => {
    const old = serializeConsent(state({ version: 1, at: 5 }));
    expect(consentIdFromCookieValue(old)).toBe("a".repeat(32));
    expect(consentIdFromCookieValue("%E0%A4%A")).toBeNull();
    expect(consentIdFromCookieValue(undefined)).toBeNull();
    expect(consentIdFromCookieValue("id=nothex")).toBeNull();
    expect(isConsentId(newConsentId())).toBe(true);
    expect(isConsentId(5)).toBe(false);
  });
});

describe("cookie plumbing", () => {
  it("builds a Set-Cookie for the app's own cookie name, Secure only on https", () => {
    const s = state();
    expect(consentCookieString("seller_consent", s, true)).toBe(`seller_consent=${serializeConsent(s)}; Path=/; Max-Age=${CONSENT_MAX_AGE_SECONDS}; SameSite=Lax; Secure`);
    expect(consentCookieString("cnote_consent", s, false)).not.toContain("Secure");
  });
  it("finds a named cookie in a header and decodes by the app's cookie name", () => {
    const s = state();
    const header = `a=1; seller_consent=${serializeConsent(s)}; b=2`;
    expect(cookieValue(header, "b")).toBe("2");
    expect(cookieValue(header, "nope")).toBeUndefined();
    expect(cookieValue(null, "a")).toBeUndefined();
    expect(readConsentFromHeader(header, "seller_consent", V, NOW)).toEqual(s);
    expect(readConsentFromHeader(header, "cnote_consent", V, NOW)).toBeNull(); // another app's cookie name is not this app's consent
  });
});

describe("choices, actions and GPC", () => {
  it("Accept all grants everything except marketing under Global Privacy Control (never functional)", () => {
    expect(acceptAllChoices(false)).toEqual({ analytics: true, marketing: true, functional: true });
    expect(acceptAllChoices(true)).toEqual({ analytics: true, marketing: false, functional: true });
    expect(REJECT_ALL).toEqual({ analytics: false, marketing: false, functional: false });
  });
  it("detects the GPC signal from the navigator flag or the Sec-GPC header", () => {
    expect(gpcSignal({ globalPrivacyControl: true })).toBe(true);
    expect(gpcSignal({ globalPrivacyControl: false })).toBe(false);
    expect(gpcSignal({})).toBe(false);
    expect(gpcSignal(undefined)).toBe(false);
    expect(gpcFromHeader("1")).toBe(true);
    expect(gpcFromHeader(" 1 ")).toBe(true);
    expect(gpcFromHeader("0")).toBe(false);
    expect(gpcFromHeader(null)).toBe(false);
  });
  it("records any switch-off of something granted as a withdrawal; accept_all is never one", () => {
    const prev = state({ analytics: true, marketing: true });
    expect(deriveAction("custom", prev, { analytics: true, marketing: false, functional: false })).toBe("withdraw");
    expect(deriveAction("reject_all", prev, REJECT_ALL)).toBe("withdraw");
    expect(deriveAction("reject_all", null, REJECT_ALL)).toBe("reject_all");
    expect(deriveAction("custom", prev, { analytics: true, marketing: true, functional: true })).toBe("custom");
    expect(deriveAction("accept_all", prev, REJECT_ALL)).toBe("accept_all");
  });
  it("builds a state with the app's version and a strictly increasing timestamp per consent id", () => {
    const first = buildConsent(REJECT_ALL, { version: 7, gpc: false, now: NOW });
    expect(first).toMatchObject({ version: 7, at: at(), gpc: false });
    const again = buildConsent(acceptAllChoices(false), { version: 7, gpc: true, prev: first, now: NOW });
    expect(again.id).toBe(first.id);
    expect(again.at).toBe(first.at + 1);
    expect(buildConsent(REJECT_ALL, { version: 7, gpc: false, at: at(100), prev: first }).at).toBe(at(100));
  });
  it("answers needsPrompt / isGranted from the state", () => {
    expect(needsPrompt(null)).toBe(true);
    expect(needsPrompt(state())).toBe(false);
    expect(isGranted(null, "analytics")).toBe(false);
    expect(isGranted(state(), "analytics")).toBe(true);
    expect(isGranted(state(), "marketing")).toBe(false);
  });
  it("knows the apps that can show a banner", () => {
    expect(CONSENT_APPS).toEqual(["web", "seller", "studio", "admin"]);
  });
});

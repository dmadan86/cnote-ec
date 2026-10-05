import { describe, expect, it } from "vitest";
import {
  CONSENT_MAX_AGE_SECONDS,
  effectiveChoiceTime,
  reconcileAccountConsent,
  requestedActionFor,
  type AccountConsent,
  type ConsentState,
} from "../src";

const NOW = 1_800_000_000;
const cookie = (o: Partial<ConsentState> = {}): ConsentState => ({
  version: 2,
  id: "a".repeat(32),
  gpc: false,
  at: NOW - 1000,
  analytics: false,
  marketing: false,
  functional: false,
  ...o,
});
const acct = (o: Partial<AccountConsent> = {}): AccountConsent => ({ signedIn: true, analytics: null, marketing: null, ...o });

describe("reconcileAccountConsent", () => {
  it("does nothing for anonymous visitors, a missing account, or an empty ledger", () => {
    expect(reconcileAccountConsent(cookie(), null, NOW)).toEqual({ kind: "none" });
    expect(reconcileAccountConsent(cookie(), acct({ signedIn: false, analytics: { granted: true, at: NOW } }), NOW)).toEqual({ kind: "none" });
    expect(reconcileAccountConsent(null, acct(), NOW)).toEqual({ kind: "none" });
  });

  it("seeds a device without a cookie from the ledger, defaulting missing purposes to off", () => {
    const d = reconcileAccountConsent(null, acct({ analytics: { granted: true, at: NOW - 10 }, marketing: { granted: false, at: NOW - 5 } }), NOW);
    expect(d).toEqual({ kind: "adopt", choices: { analytics: true, marketing: false, functional: false }, at: NOW - 5 });
    const f = reconcileAccountConsent(null, acct({ functional: { granted: true, at: NOW - 1 } }), NOW);
    expect(f).toEqual({ kind: "adopt", choices: { analytics: false, marketing: false, functional: true }, at: NOW - 1 });
  });

  it("does not seed from a ledger older than the consent lifetime", () => {
    const old = NOW - CONSENT_MAX_AGE_SECONDS - 1;
    expect(reconcileAccountConsent(null, acct({ analytics: { granted: true, at: old } }), NOW)).toEqual({ kind: "none" });
  });

  it("per purpose, a newer and different ledger value wins over the cookie (a withdrawal elsewhere beats an older grant)", () => {
    const c = cookie({ analytics: true, marketing: true, functional: false, at: NOW - 100 });
    const d = reconcileAccountConsent(
      c,
      acct({ analytics: { granted: false, at: NOW - 50 }, marketing: { granted: true, at: NOW - 40 }, functional: { granted: true, at: NOW - 30 } }),
      NOW,
    );
    // marketing is equal so it is kept; analytics is withdrawn; functional is granted
    expect(d).toEqual({ kind: "adopt", choices: { analytics: false, marketing: true, functional: true }, at: NOW - 30 });
  });

  it("keeps the cookie when the ledger is older or identical", () => {
    const c = cookie({ analytics: true, at: NOW - 100 });
    expect(reconcileAccountConsent(c, acct({ analytics: { granted: false, at: NOW - 200 } }), NOW)).toEqual({ kind: "none" });
    expect(reconcileAccountConsent(c, acct({ analytics: { granted: true, at: NOW - 10 } }), NOW)).toEqual({ kind: "none" });
  });
});

describe("requestedActionFor", () => {
  it("names accept_all, reject_all and custom", () => {
    expect(requestedActionFor({ analytics: true, marketing: true, functional: true })).toBe("accept_all");
    expect(requestedActionFor({ analytics: false, marketing: false, functional: false })).toBe("reject_all");
    expect(requestedActionFor({ analytics: true, marketing: false, functional: true })).toBe("custom");
  });
});

describe("effectiveChoiceTime", () => {
  const nowMs = Date.parse("2026-09-30T00:00:00Z");
  it("uses the server clock when there is no client time or it is within the 5 minute skew", () => {
    expect(effectiveChoiceTime(undefined, nowMs)).toBe(nowMs);
    expect(effectiveChoiceTime(nowMs / 1000 - 120, nowMs)).toBe(nowMs);
    expect(effectiveChoiceTime(nowMs / 1000 + 120, nowMs)).toBe(nowMs);
  });
  it("keeps the client time for a late resend", () => {
    const at = nowMs / 1000 - 3600;
    expect(effectiveChoiceTime(at, nowMs)).toBe(at * 1000);
  });
});

// Phone OTP (T0 verification), phone login supplement, consent ledger, DPDP export + erasure.
import { randomUUID } from "node:crypto";
import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  COOKIE_CONSENT_PURPOSES, createBusiness, erasePerson, exportPersonalData, getConsents, getConsentStates, getSession, hasConsent, requestLoginOtp, requestPhoneOtp, setConsent, setOtpSender, setSmsSender,
  signInWithPassword, signUpWithPassword, verifyLoginOtp, verifyPhoneOtp, hashPhone, type OtpSender, type SmsSender,
} from "../src";
import { beginMfaEnrollment } from "../src/mfa";
import { consoleSms } from "../src/mailer";
import { CONSENT_PURPOSES } from "../src/types";

const people: string[] = [];
const bizIds: string[] = [];
const phones: string[] = [];
const uid = () => randomUUID();
const newPhone = () => {
  const p = `+9170${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  phones.push(p);
  return p;
};
async function person(extra: Record<string, unknown> = {}) {
  const p = await prisma.person.create({ data: { email: `op-${uid()}@example.test`, ...extra }, select: { id: true } });
  people.push(p.id);
  return p.id;
}
const delKeys = async (pattern: string) => { const k = await redis.keys(pattern); if (k.length) await redis.del(...k); };

const smsSent: { to: string; text: string }[] = [];
const sms: SmsSender = { async send(m) { smsSent.push(m); } };
const loginSent: { to: string; code: string; channel: string }[] = [];
const otpSender: OtpSender = { async send(m) { loginSent.push(m); } };
const lctx = (extra: object = {}) => ({ ip: `t-${uid()}`, userAgent: "vitest", visitorId: uid(), ...extra });

afterAll(async () => {
  setSmsSender(consoleSms);
  setOtpSender(undefined);
  const byPhone = await prisma.person.findMany({ where: { phone: { in: phones } }, select: { id: true } });
  const ids = [...new Set([...people, ...byPhone.map((p) => p.id)])];
  await prisma.authSession.deleteMany({ where: { personId: { in: ids } } });
  await prisma.consent.deleteMany({ where: { personId: { in: ids } } });
  await prisma.personMfa.deleteMany({ where: { personId: { in: ids } } });
  await prisma.authIdentity.deleteMany({ where: { personId: { in: ids } } });
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: [...ids, ...bizIds] } } });
  await prisma.verificationRecord.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: ids } } });
  for (const p of phones) { await delKeys(`rl:otp:phone:${p}:*`); await delKeys(`rl:lotp:*:${hashPhone(p)}:*`); await redis.del(`lotp:${hashPhone(p)}`); }
  await delKeys("rl:otp:person:*");
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("phone OTP verification (T0)", () => {
  it("issues a 6-digit code, never stores it in clear, never echoes it without OTP_DEV_ECHO, and marks the phone verified once", async () => {
    setOtpSender(otpSender);
    vi.stubEnv("OTP_DEV_ECHO", "true");
    const id = await person();
    const phone = newPhone();
    const r = await requestPhoneOtp(id, phone.slice(3));
    expect(r.devCode).toMatch(/^\d{6}$/);
    const rec = await redis.hgetall(`otp:${id}`);
    expect(rec.phone).toBe(phone);
    expect(rec.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.hash).not.toContain(r.devCode!);
    expect(await redis.ttl(`otp:${id}`)).toBeLessThanOrEqual(600);
    expect(await redis.ttl(`otp:${id}`)).toBeGreaterThan(590);
    // delivered to the phone through the OTP provider (same path as phone sign-in)
    expect(loginSent.at(-1)).toMatchObject({ to: phone, code: r.devCode, channel: "sms" });

    const { businessId } = await createBusiness(id, { name: "OTP Biz", isSeller: false });
    bizIds.push(businessId);
    expect(await verifyPhoneOtp(id, phone, ` ${r.devCode} `)).toEqual({ verified: true });
    const p = await prisma.person.findUniqueOrThrow({ where: { id } });
    expect(p.phone).toBe(phone);
    expect(p.phoneVerifiedAt).not.toBeNull();
    const rec2 = await prisma.verificationRecord.findFirstOrThrow({ where: { businessId, kind: "phone_otp" } });
    expect(rec2).toMatchObject({ tier: 0, status: "passed" });
    expect(JSON.stringify(rec2.details)).not.toContain(phone); // only last 4 digits kept
    // replay: code is gone
    expect(await verifyPhoneOtp(id, phone, r.devCode!)).toEqual({ verified: false });
    expect(await redis.exists(`otp:${id}`)).toBe(0);
  });
  it("never returns the code in the response by default; delivers it only to the phone", async () => {
    setOtpSender(otpSender);
    vi.stubEnv("OTP_DEV_ECHO", "false");
    const id = await person();
    const phone = newPhone();
    const r = await requestPhoneOtp(id, phone);
    expect(r).toEqual({ sent: true });
    expect(loginSent.at(-1)!.to).toBe(phone);
    expect(loginSent.at(-1)!.code).toMatch(/^\d{6}$/);
  });
  it("wrong code / wrong phone / no pending code all return verified:false without consuming the code", async () => {
    setOtpSender(otpSender);
    vi.stubEnv("OTP_DEV_ECHO", "true");
    const id = await person();
    const phone = newPhone();
    expect(await verifyPhoneOtp(id, phone, "123456")).toEqual({ verified: false }); // nothing pending
    const { devCode } = await requestPhoneOtp(id, phone);
    const wrong = devCode === "000000" ? "000001" : "000000";
    expect(await verifyPhoneOtp(id, phone, wrong)).toEqual({ verified: false });
    expect(await verifyPhoneOtp(id, newPhone(), devCode!)).toEqual({ verified: false }); // code bound to phone
    expect(await verifyPhoneOtp(await person(), phone, devCode!)).toEqual({ verified: false }); // and to the person
    expect(await verifyPhoneOtp(id, phone, devCode!)).toEqual({ verified: true });
  });
  it("allows 5 wrong attempts, then locks and deletes the code (even the right code fails afterwards)", async () => {
    setOtpSender(otpSender);
    vi.stubEnv("OTP_DEV_ECHO", "true");
    const id = await person();
    const phone = newPhone();
    const { devCode } = await requestPhoneOtp(id, phone);
    const wrong = devCode === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) expect(await verifyPhoneOtp(id, phone, wrong)).toEqual({ verified: false });
    await expect(verifyPhoneOtp(id, phone, devCode!)).rejects.toMatchObject({ code: "rate_limited" });
    expect(await redis.exists(`otp:${id}`)).toBe(0);
    expect(await verifyPhoneOtp(id, phone, devCode!)).toEqual({ verified: false });
  });
  it("expiry: once the Redis TTL lapses the code is invalid", async () => {
    setOtpSender(otpSender);
    vi.stubEnv("OTP_DEV_ECHO", "true");
    const id = await person();
    const phone = newPhone();
    const { devCode } = await requestPhoneOtp(id, phone);
    expect(await redis.ttl(`otp:${id}`)).toBeGreaterThan(0);
    await redis.del(`otp:${id}`); // what the 10 min TTL does
    expect(await verifyPhoneOtp(id, phone, devCode!)).toEqual({ verified: false });
  });
  it("a new request replaces the old code and resets the attempt counter", async () => {
    setOtpSender(otpSender);
    vi.stubEnv("OTP_DEV_ECHO", "true");
    const id = await person();
    const phone = newPhone();
    const first = await requestPhoneOtp(id, phone);
    await verifyPhoneOtp(id, phone, "999999");
    const second = await requestPhoneOtp(id, phone);
    expect(await redis.hget(`otp:${id}`, "attempts")).toBe("0");
    if (first.devCode !== second.devCode) expect(await verifyPhoneOtp(id, phone, first.devCode!)).toEqual({ verified: false });
    expect(await verifyPhoneOtp(id, phone, second.devCode!)).toEqual({ verified: true });
  });
  it("rate limits: 3 per phone / 10 min, 10 per person / day, window resets (fake time)", async () => {
    setOtpSender(otpSender);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2035-01-01T00:00:00Z"));
    const id = await person();
    const phone = newPhone();
    for (let i = 0; i < 3; i++) await requestPhoneOtp(id, phone);
    await expect(requestPhoneOtp(id, phone)).rejects.toMatchObject({ code: "rate_limited", message: expect.stringContaining("this number") });
    vi.setSystemTime(new Date("2035-01-01T00:10:00Z"));
    await requestPhoneOtp(id, phone);
    // per-person daily cap: 10 total across numbers
    const id2 = await person();
    for (let i = 0; i < 10; i++) await requestPhoneOtp(id2, newPhone());
    await expect(requestPhoneOtp(id2, newPhone())).rejects.toMatchObject({ code: "rate_limited", message: expect.stringContaining("Daily") });
    vi.setSystemTime(new Date("2035-01-02T00:00:00Z"));
    await requestPhoneOtp(id2, newPhone());
  });
  it("rejects invalid numbers and numbers linked to another account", async () => {
    const id = await person();
    await expect(requestPhoneOtp(id, "12345")).rejects.toMatchObject({ code: "validation" });
    await expect(verifyPhoneOtp(id, "abc", "123456")).rejects.toMatchObject({ code: "validation" });
    const phone = newPhone();
    await prisma.person.create({ data: { phone } }).then((p) => people.push(p.id));
    await expect(requestPhoneOtp(id, phone)).rejects.toMatchObject({ code: "conflict" });
  });
  it("conflict if someone else claims the number between request and verify (unique violation)", async () => {
    setOtpSender(otpSender);
    vi.stubEnv("OTP_DEV_ECHO", "true");
    const id = await person();
    const phone = newPhone();
    const { devCode } = await requestPhoneOtp(id, phone);
    await prisma.person.create({ data: { phone } }).then((p) => people.push(p.id));
    await expect(verifyPhoneOtp(id, phone, devCode!)).rejects.toMatchObject({ code: "conflict" });
    expect((await prisma.person.findUniqueOrThrow({ where: { id } })).phoneVerifiedAt).toBeNull();
  });
  it("re-throws unexpected errors from the update", async () => {
    setOtpSender(otpSender);
    vi.stubEnv("OTP_DEV_ECHO", "true");
    const id = await person();
    const phone = newPhone();
    const { devCode } = await requestPhoneOtp(id, phone);
    await prisma.person.delete({ where: { id } }); // update -> P2025, not a conflict
    await expect(verifyPhoneOtp(id, phone, devCode!)).rejects.toMatchObject({ code: "P2025" });
  });
});

describe("phone login (supplement)", () => {
  it("enforces the 30s resend cooldown, then the 3/10min cap; channel defaults to sms; dev echo only when enabled", async () => {
    setOtpSender(otpSender);
    vi.stubEnv("OTP_DEV_ECHO", "false");
    const phone = newPhone();
    const r = await requestLoginOtp(phone, lctx(), { channel: "bogus" as never });
    expect(r).toMatchObject({ sent: true, channel: "sms", phone, phoneHash: hashPhone(phone), resendAfterSeconds: 30 });
    expect("devCode" in r).toBe(false);
    await expect(requestLoginOtp(phone, lctx())).rejects.toMatchObject({ code: "rate_limited", message: expect.stringContaining("wait a few seconds") });
  });
  it("cooldown, per-phone and daily windows reset with time", async () => {
    setOtpSender(otpSender);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2036-01-01T00:00:00Z"));
    const phone = newPhone();
    await requestLoginOtp(phone, lctx());
    vi.setSystemTime(new Date("2036-01-01T00:00:30Z"));
    await requestLoginOtp(phone, lctx());
    vi.setSystemTime(new Date("2036-01-01T00:01:00Z"));
    await requestLoginOtp(phone, lctx());
    vi.setSystemTime(new Date("2036-01-01T00:01:30Z"));
    await expect(requestLoginOtp(phone, lctx())).rejects.toMatchObject({ message: expect.stringContaining("Too many codes requested for this number") });
    vi.setSystemTime(new Date("2036-01-01T00:10:00Z"));
    await requestLoginOtp(phone, lctx());
  });
  it("per-IP (20/h) and per-visitor (10/day) caps", async () => {
    setOtpSender(otpSender);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2037-01-01T00:00:00Z"));
    const ip = `ip-${uid()}`;
    for (let i = 0; i < 20; i++) await requestLoginOtp(newPhone(), { ip, userAgent: null });
    await expect(requestLoginOtp(newPhone(), { ip, userAgent: null })).rejects.toMatchObject({ message: expect.stringContaining("network") });
    const visitorId = uid();
    for (let i = 0; i < 10; i++) await requestLoginOtp(newPhone(), { ip: `ip-${uid()}`, userAgent: null, visitorId });
    await expect(requestLoginOtp(newPhone(), { ip: `ip-${uid()}`, userAgent: null, visitorId })).rejects.toMatchObject({ message: expect.stringContaining("Too many codes requested. Try again tomorrow") });
  });
  it("stores only a keyed hash of the code (never the code) under a hashed-phone key", async () => {
    setOtpSender(otpSender);
    const phone = newPhone();
    await requestLoginOtp(phone, lctx());
    const code = loginSent.at(-1)!.code;
    const rec = await redis.hgetall(`lotp:${hashPhone(phone)}`);
    expect(rec.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rec)).not.toContain(code);
    expect(await redis.ttl(`lotp:${hashPhone(phone)}`)).toBeGreaterThan(590);
  });
  it("verify: expired/unknown code and wrong code give the same generic error; attempt cap of 5 then lock", async () => {
    setOtpSender(otpSender);
    const phone = newPhone();
    await expect(verifyLoginOtp(phone, "123456", lctx())).rejects.toMatchObject({ code: "validation", message: "That code is incorrect or has expired." });
    await requestLoginOtp(phone, lctx());
    const code = loginSent.at(-1)!.code;
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) await expect(verifyLoginOtp(phone, wrong, lctx())).rejects.toMatchObject({ code: "validation", message: "That code is incorrect or has expired." });
    await expect(verifyLoginOtp(phone, code, lctx())).rejects.toMatchObject({ code: "rate_limited" });
    await expect(verifyLoginOtp(phone, code, lctx())).rejects.toMatchObject({ code: "validation" }); // code deleted
  });
  it("verify-IP throttle: 30 attempts / 10 min per IP", async () => {
    const ip = `ip-${uid()}`;
    const phone = newPhone();
    for (let i = 0; i < 30; i++) await expect(verifyLoginOtp(phone, "123456", { ip, userAgent: null })).rejects.toMatchObject({ code: "validation" });
    await expect(verifyLoginOtp(phone, "123456", { ip, userAgent: null })).rejects.toMatchObject({ code: "rate_limited" });
  });
  it("existing unverified-phone person is verified (not duplicated); consents (granted + denied) go to the ledger", async () => {
    setOtpSender(otpSender);
    const phone = newPhone();
    const existing = await prisma.person.create({ data: { phone } });
    people.push(existing.id);
    await requestLoginOtp(phone, lctx());
    const t = await verifyLoginOtp(phone, loginSent.at(-1)!.code, lctx(), { consents: { matching: true, marketing: false } });
    expect(t).toMatchObject({ personId: existing.id, isNew: false });
    expect((await prisma.person.findUniqueOrThrow({ where: { id: existing.id } })).phoneVerifiedAt).not.toBeNull();
    expect(await getConsents(existing.id)).toMatchObject({ matching: true, marketing: false });
    expect(await prisma.consent.findMany({ where: { personId: existing.id } })).toHaveLength(2);
  });
  it("refuses an erased person and creates no session; realm admission guard applies", async () => {
    setOtpSender(otpSender);
    const phone = newPhone();
    const existing = await prisma.person.create({ data: { phone, erasedAt: new Date() } });
    people.push(existing.id);
    await requestLoginOtp(phone, lctx());
    await expect(verifyLoginOtp(phone, loginSent.at(-1)!.code, lctx())).rejects.toMatchObject({ code: "unauthenticated" });
    expect(await prisma.authSession.count({ where: { personId: existing.id } })).toBe(0);

    const phone2 = newPhone();
    await requestLoginOtp(phone2, lctx());
    await expect(verifyLoginOtp(phone2, loginSent.at(-1)!.code, lctx({ realm: "seller", allowPerson: async () => false }))).rejects.toMatchObject({ message: "Invalid email or password" }); // the admin realm is refused outright (security-hardening.test.ts)
  });
  it("new person: PersonRegistered emitted, realm-bound session, phone shown as verified", async () => {
    setOtpSender(otpSender);
    const phone = newPhone();
    await requestLoginOtp(phone, lctx({ realm: "seller" }));
    const t = await verifyLoginOtp(phone, loginSent.at(-1)!.code, lctx({ realm: "seller" }));
    expect(t.isNew).toBe(true);
    expect(await prisma.domainEvent.count({ where: { aggregateId: t.personId, type: "PersonRegistered" } })).toBe(1);
    expect(await getSession(t.accessToken, "web")).toBeNull();
    expect((await getSession(t.accessToken, "seller"))?.phone).toBe(phone);
  });
});

describe("consent ledger", () => {
  it("is append-only: state is the latest row per purpose, history is retained, default is false", async () => {
    const id = await person();
    for (const p of CONSENT_PURPOSES) expect(await hasConsent(id, p)).toBe(false);
    await setConsent(id, "marketing", true, "web");
    await setConsent(id, "marketing", false, "settings");
    await setConsent(id, "marketing", true, "settings");
    expect(await hasConsent(id, "marketing")).toBe(true);
    expect(await hasConsent(id, "matching")).toBe(false);
    const rows = await prisma.consent.findMany({ where: { personId: id, purpose: "marketing" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.granted)).toEqual([true, false, true]);
    expect(rows.map((r) => r.source)).toEqual(["web", "settings", "settings"]);
    expect(await prisma.domainEvent.count({ where: { aggregateId: id, type: "ConsentChanged" } })).toBe(3);
    const all = await getConsents(id);
    expect(Object.keys(all).sort()).toEqual([...CONSENT_PURPOSES].sort());
    expect(all).toMatchObject({ marketing: true, matching: false, voice_retention: false, counterparty_sharing: false });
  });
  it("getConsentStates returns the latest row with its time per purpose (null when never recorded), for cookie-banner sync", async () => {
    const id = await person();
    expect(await getConsentStates(id, COOKIE_CONSENT_PURPOSES)).toEqual({ analytics_cookies: null, marketing_cookies: null, functional_cookies: null });
    await setConsent(id, "analytics_cookies", true, "web_cookie_banner");
    await new Promise((r) => setTimeout(r, 5));
    await setConsent(id, "analytics_cookies", false, "web_cookie_banner");
    await setConsent(id, "matching", true, "w"); // other purposes are not returned
    const s = await getConsentStates(id, COOKIE_CONSENT_PURPOSES);
    expect(s.analytics_cookies).toMatchObject({ granted: false });
    expect(s.analytics_cookies!.at.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(s.marketing_cookies).toBeNull();
    expect(await hasConsent(id, "analytics_cookies")).toBe(false);
  });
  it("changing one purpose never touches another", async () => {
    const id = await person();
    await setConsent(id, "matching", true, "w");
    await setConsent(id, "marketing", true, "w");
    await setConsent(id, "marketing", false, "w");
    expect(await getConsents(id)).toMatchObject({ matching: true, marketing: false });
  });
});

describe("DPDP export + erasure", () => {
  async function fullPerson() {
    const email = `dp-${uid()}@example.test`;
    const t = await signUpWithPassword({ email, password: "a fine long passphrase", name: "Dee Pee", consents: { matching: true } }, { ip: uid(), userAgent: "vitest" });
    people.push(t.personId);
    const { businessId } = await createBusiness(t.personId, { name: "DP Biz", isSeller: true });
    bizIds.push(businessId);
    await prisma.authIdentity.create({ data: { personId: t.personId, provider: "google", providerSubject: `sub-${uid()}`, email } });
    await prisma.person.update({ where: { id: t.personId }, data: { phone: newPhone(), phoneVerifiedAt: new Date() } });
    await beginMfaEnrollment(t.personId, email);
    const seller = await signInWithPassword({ email, password: "a fine long passphrase" }, { ip: uid(), userAgent: "ua2", realm: "seller" });
    return { email, t, seller, businessId };
  }
  it("export contains everything held about the person and never credential material", async () => {
    const { email, t, businessId } = await fullPerson();
    const out = (await exportPersonalData(t.personId)) as Record<string, any>;
    expect(out.exportedAt).toEqual(expect.any(String));
    expect(out.person).toMatchObject({ id: t.personId, email, name: "Dee Pee" });
    expect(out.person.passwordHash).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("scrypt$");
    expect(out.businesses).toEqual([expect.objectContaining({ id: businessId, role: "owner", name: "DP Biz" })]);
    expect(out.consents).toEqual([expect.objectContaining({ purpose: "matching", granted: true, source: "web" })]);
    expect(out.sessions).toHaveLength(2);
    expect(Object.keys(out.sessions[0]).sort()).toEqual(["createdAt", "expiresAt", "id", "ip", "lastUsedAt", "revokedAt", "userAgent"]); // no token hashes
    expect(out.loginIdentities).toEqual([expect.objectContaining({ provider: "google", email })]);
    expect(await exportPersonalData(uid())).toEqual({});
  });
  it("erasure tombstones PII, revokes sessions in every realm, deletes MFA + identities, withdraws every consent and emits DataErasureRequested", async () => {
    const { t, seller } = await fullPerson();
    await erasePerson(t.personId);
    const p = await prisma.person.findUniqueOrThrow({ where: { id: t.personId } });
    expect(p).toMatchObject({ email: null, emailVerifiedAt: null, phone: null, phoneVerifiedAt: null, name: null, avatarUrl: null, passwordHash: null });
    expect(p.erasedAt).not.toBeNull();
    expect(await prisma.personMfa.count({ where: { personId: t.personId } })).toBe(0);
    expect(await prisma.authIdentity.count({ where: { personId: t.personId } })).toBe(0);
    expect(await prisma.authSession.count({ where: { personId: t.personId, revokedAt: null } })).toBe(0);
    expect(await getSession(t.accessToken, "web")).toBeNull();
    expect(await getSession(seller.accessToken, "seller")).toBeNull();
    expect(await getConsents(t.personId)).toEqual({ matching: false, marketing: false, voice_retention: false, counterparty_sharing: false, credit_underwriting: false, analytics_cookies: false, marketing_cookies: false, functional_cookies: false });
    const erasureRows = await prisma.consent.findMany({ where: { personId: t.personId, source: "erasure" } });
    expect(erasureRows).toHaveLength(CONSENT_PURPOSES.length);
    // history is preserved (append-only), only withdrawn
    expect(await prisma.consent.count({ where: { personId: t.personId, purpose: "matching" } })).toBe(2);
    const ev = await prisma.domainEvent.findMany({ where: { aggregateId: t.personId, type: "DataErasureRequested" } });
    expect(ev).toHaveLength(1);
    expect(JSON.stringify(ev[0]!.payload)).toContain(t.personId);
    // exports of an erased person carry no PII
    const out = (await exportPersonalData(t.personId)) as Record<string, any>;
    expect(out.person).toMatchObject({ email: null, phone: null, name: null });
    expect(out.loginIdentities).toEqual([]);
  });
  it("erasure is idempotent and a phone number can be reused afterwards", async () => {
    const { t } = await fullPerson();
    const phone = (await prisma.person.findUniqueOrThrow({ where: { id: t.personId } })).phone!;
    await erasePerson(t.personId);
    await erasePerson(t.personId);
    await expect(prisma.person.create({ data: { phone } }).then((p) => (people.push(p.id), p.id))).resolves.toBeTruthy();
  });
});

// Identity security hardening: OTP dev-echo, breached passwords, progressive backoff + burst alerts, refresh-rotation grace,
// revocation marker on Redis failure, Google pre-hijack, GSTIN control-proof port. Against the isolated test DB + Redis.
import { randomUUID } from "node:crypto";
import { MemoryJobQueue, redis, setJobQueue } from "@cnote/core";
import { prisma } from "@cnote/db";
import { setSecurityEventSink, type SecurityEvent } from "@cnote/security";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSession, passwordProblem, refreshSession, requestLoginOtp, verifyLoginOtp, requestPasswordReset, requestPhoneOtp, resetPassword, setMailer, setOtpSender, signInWithPassword, signOut, signUpWithPassword,
  type OtpSender,
} from "../src";
import { ACCOUNT_BURST_THRESHOLD, FREE_FAILURES, MFA_FREE_FAILURES, backoffRemaining, backoffSeconds, clearFailures, knownIp, recordFailure } from "../src/auth-guard";
import { isBreachedPassword } from "../src/breached-passwords";
import { devEchoEnabled } from "../src/dev-echo";
import { getGstControlProvider, mockGstControlProvider, setGstControlProvider } from "../src/gst/control";
import { upsertGoogleUser } from "../src/google";
import { enqueueAccountMail, mailQueueConsumers } from "../src/mail-queue";
import { trustHandlers } from "../src/trust-worker";
import { verifyMfa } from "../src/mfa";

const PW = "a fine long passphrase";
const made: string[] = [];
const uid = () => randomUUID();
const ctxFor = (extra: object = {}) => ({ ip: uid(), userAgent: "vitest", ...extra });
const newEmail = () => `sh-${uid()}@example.test`;
async function signUp(ctx = ctxFor()) {
  const email = newEmail();
  const t = await signUpWithPassword({ email, password: PW, name: "Hardening" }, ctx);
  made.push(t.personId);
  return { email, t, ctx };
}
const sidOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).sid as string;
const ageRotation = (sid: string, ms = 60_000) => prisma.authSession.update({ where: { id: sid }, data: { lastUsedAt: new Date(Date.now() - ms) } });

afterAll(async () => {
  await prisma.authSession.deleteMany({ where: { personId: { in: made } } });
  await prisma.authIdentity.deleteMany({ where: { personId: { in: made } } });
  await prisma.consent.deleteMany({ where: { personId: { in: made } } });
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: made } } });
  await prisma.person.deleteMany({ where: { id: { in: made } } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("OTP_DEV_ECHO: one rule, every combination", () => {
  const cases: [string, Record<string, string | undefined>, { real?: boolean } | undefined, boolean][] = [
    ["flag unset", { NODE_ENV: "development" }, undefined, false],
    ["flag not exactly 'true'", { OTP_DEV_ECHO: "1", NODE_ENV: "development" }, undefined, false],
    ["dev + console sender", { OTP_DEV_ECHO: "true", NODE_ENV: "development" }, undefined, true],
    ["test env + console sender", { OTP_DEV_ECHO: "true", NODE_ENV: "test", OTP_SENDER: "console" }, undefined, true],
    ["blank OTP_SENDER counts as console", { OTP_DEV_ECHO: "true", OTP_SENDER: "  " }, undefined, true],
    ["production, no opt-out", { OTP_DEV_ECHO: "true", NODE_ENV: "production" }, undefined, false],
    ["production, opt-out is exactly '1' only", { OTP_DEV_ECHO: "true", NODE_ENV: "production", ALLOW_OTP_ECHO_IN_PRODUCTION: "true" }, undefined, false],
    ["production + opt-out + console sender (e2e / dev cluster)", { OTP_DEV_ECHO: "true", NODE_ENV: "production", ALLOW_OTP_ECHO_IN_PRODUCTION: "1" }, undefined, true],
    ["production + opt-out + real provider env", { OTP_DEV_ECHO: "true", NODE_ENV: "production", ALLOW_OTP_ECHO_IN_PRODUCTION: "1", OTP_SENDER: "msg91" }, undefined, false],
    ["production + opt-out + real sender object", { OTP_DEV_ECHO: "true", NODE_ENV: "production", ALLOW_OTP_ECHO_IN_PRODUCTION: "1" }, { real: true }, false],
    ["dev + real provider env (a real sender never echoes anywhere)", { OTP_DEV_ECHO: "true", NODE_ENV: "development", OTP_SENDER: "whatsapp_then_sms" }, undefined, false],
    ["dev + real sender object", { OTP_DEV_ECHO: "true", NODE_ENV: "development" }, { real: true }, false],
    ["dev + injected non-provider sender (tests)", { OTP_DEV_ECHO: "true", NODE_ENV: "development" }, { real: false }, true],
  ];
  it.each(cases)("%s", (_name, env, sender, expected) => {
    expect(devEchoEnabled(sender, env)).toBe(expected);
  });
  it("the provider adapters are marked real, the console adapter is not", async () => {
    const { msg91OtpSender, whatsappCloudOtpSender, fallbackOtpSender } = await import("../src/otp-senders");
    const { consoleOtpSender } = await import("../src/phone-login");
    const env = { MSG91_AUTH_KEY: "k", MSG91_OTP_TEMPLATE_ID: "t", WHATSAPP_PHONE_NUMBER_ID: "p", WHATSAPP_ACCESS_TOKEN: "a" };
    const sms = msg91OtpSender(env);
    const wa = whatsappCloudOtpSender(env);
    expect([sms.real, wa.real, fallbackOtpSender(wa, sms).real]).toEqual([true, true, true]);
    expect(consoleOtpSender.real).toBeUndefined();
  });
  it("requestPhoneOtp / requestLoginOtp: dev echoes; production does not unless opted out; a real sender never does", async () => {
    const sent: { code: string }[] = [];
    const sender: OtpSender = { async send(m) { sent.push(m); } };
    const realSender: OtpSender = { real: true, async send(m) { sent.push(m); } };
    setOtpSender(sender);
    vi.stubEnv("OTP_DEV_ECHO", "true");
    vi.stubEnv("OTP_SENDER", "console");
    const person = await prisma.person.create({ data: { email: newEmail() }, select: { id: true } });
    made.push(person.id);
    const phone = () => `+9170${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const lctx = () => ({ ip: uid(), userAgent: null, visitorId: uid() });
    expect((await requestPhoneOtp(person.id, phone())).devCode).toMatch(/^\d{6}$/); // dev: echoes (existing behaviour)
    expect(await requestLoginOtp(phone(), lctx())).toHaveProperty("devCode", expect.stringMatching(/^\d{6}$/));
    vi.stubEnv("NODE_ENV", "production");
    expect(await requestPhoneOtp(person.id, phone())).toEqual({ sent: true }); // production, no opt-out
    expect(await requestLoginOtp(phone(), lctx())).not.toHaveProperty("devCode");
    expect(sent.at(-1)!.code).toMatch(/^\d{6}$/); // the code still went out through the sender
    vi.stubEnv("ALLOW_OTP_ECHO_IN_PRODUCTION", "1");
    expect((await requestPhoneOtp(person.id, phone())).devCode).toMatch(/^\d{6}$/); // e2e / dev cluster opt-out with the console-style sender
    setOtpSender(realSender);
    expect(await requestPhoneOtp(person.id, phone())).toEqual({ sent: true }); // real sender: never
    expect(await requestLoginOtp(phone(), lctx())).not.toHaveProperty("devCode");
    vi.stubEnv("NODE_ENV", "development");
    expect(await requestPhoneOtp(person.id, phone())).toEqual({ sent: true }); // ... not even in development
    setOtpSender(undefined);
  });
});

describe("phone login is refused for the admin realm", () => {
  it("requestLoginOtp and verifyLoginOtp throw before sending or verifying anything", async () => {
    const sent: unknown[] = [];
    setOtpSender({ async send(m) { sent.push(m); } });
    const ctx = { ip: uid(), userAgent: null, realm: "admin" as const };
    await expect(requestLoginOtp("+917000000001", ctx)).rejects.toMatchObject({ code: "forbidden" });
    await expect(verifyLoginOtp("+917000000001", "123456", ctx)).rejects.toMatchObject({ code: "forbidden" });
    expect(sent).toHaveLength(0);
    setOtpSender(undefined);
  });
});

describe("breached passwords", () => {
  it("rejects entries of the bundled top-10k list (case-insensitive) that meet the length policy", () => {
    expect(isBreachedPassword("Unbelievable")).toBe(true);
    expect(passwordProblem("unbelievable")).toMatch(/too common/);
    expect(passwordProblem("UNBELIEVABLE")).toMatch(/too common/);
    expect(isBreachedPassword("a fine long passphrase")).toBe(false);
    expect(passwordProblem(PW)).toBeNull();
  });
});

describe("progressive per-account backoff + burst alerts", () => {
  it("backoffSeconds: free failures, then exponential, capped", () => {
    expect(backoffSeconds(FREE_FAILURES - 1)).toBe(0);
    expect(backoffSeconds(FREE_FAILURES)).toBe(15);
    expect(backoffSeconds(FREE_FAILURES + 1)).toBe(30);
    expect(backoffSeconds(FREE_FAILURES + 2)).toBe(60);
    expect(backoffSeconds(1000)).toBe(15 * 60);
    expect(backoffSeconds(MFA_FREE_FAILURES - 1, MFA_FREE_FAILURES)).toBe(0);
  });
  it("after the free failures the account is locked for everyone except an IP it already signed in from; success and reset clear it", async () => {
    const { email, t, ctx } = await signUp(); // first session is created from ctx.ip
    await clearFailures("signin", email);
    for (let i = 0; i < FREE_FAILURES; i++) await recordFailure("signin", email, "auth.signin_failed");
    expect(await backoffRemaining("signin", email)).toBeGreaterThan(0);
    expect(await knownIp(t.personId, ctx.ip)).toBe(true);
    expect(await knownIp(t.personId, uid())).toBe(false);
    expect(await knownIp(undefined, ctx.ip)).toBe(false);
    expect(await knownIp(t.personId, null)).toBe(false);
    // an attacker (new IP) is held back even with the RIGHT password; the failed guess does not extend it into permanence
    await expect(signInWithPassword({ email, password: PW }, ctxFor())).rejects.toMatchObject({ code: "rate_limited", message: expect.stringMatching(/Try again in \d+ seconds/) });
    // the owner on a known IP still gets in, and that clears the lock
    await expect(signInWithPassword({ email, password: PW }, ctx)).resolves.toMatchObject({ personId: t.personId });
    expect(await backoffRemaining("signin", email)).toBe(0);
    // lock again, then a password reset (the owner's recovery path) clears it
    for (let i = 0; i < FREE_FAILURES; i++) await recordFailure("signin", email, "auth.signin_failed");
    expect(await backoffRemaining("signin", email)).toBeGreaterThan(0);
    const q = new MemoryJobQueue();
    setJobQueue(q);
    let link = "";
    setMailer({ async send(m) { link = m.text; } });
    await requestPasswordReset(email, ctxFor());
    await q.consume("identity.mail", "g", "c", mailQueueConsumers[0]!.handler as never);
    await resetPassword(/token=([\w-]+)/.exec(link)![1]!, "brand new long passphrase");
    expect(await backoffRemaining("signin", email)).toBe(0);
  });
  it("the lock stays under the cap and expires with time (not permanent)", async () => {
    const email = newEmail();
    for (let i = 0; i < 40; i++) await recordFailure("signin", email, "auth.signin_failed");
    const wait = await backoffRemaining("signin", email);
    expect(wait).toBeGreaterThan(14 * 60);
    expect(wait).toBeLessThanOrEqual(15 * 60);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 16 * 60_000));
    expect(await backoffRemaining("signin", email)).toBe(0);
  });
  it("a burst of failures on one account raises exactly one auth.failure_burst event; malformed emails are not tracked", async () => {
    const events: SecurityEvent[] = [];
    const prev = setSecurityEventSink((e) => events.push(e));
    try {
      const email = newEmail();
      for (let i = 0; i < ACCOUNT_BURST_THRESHOLD + 5; i++) await recordFailure("signin", email, "auth.signin_failed");
      const bursts = events.filter((e) => e.type === "auth.failure_burst" && e.data.scope === "account");
      expect(bursts).toHaveLength(1);
      expect(bursts[0]!.data).toMatchObject({ kind: "auth.signin_failed", count: ACCOUNT_BURST_THRESHOLD });
      expect(JSON.stringify(bursts[0])).not.toContain(email); // hashed subject, never the address
      await signInWithPassword({ email: "not an email", password: "x" }, ctxFor()).catch(() => undefined);
      expect(await backoffRemaining("signin", "not an email")).toBe(0);
    } finally {
      setSecurityEventSink(prev);
    }
  });
  it("MFA: beyond a full window of misses the account backs off, and a valid sign-in path clears it", async () => {
    const { t } = await signUp();
    await clearFailures("mfa", t.personId);
    for (let i = 0; i < MFA_FREE_FAILURES; i++) await recordFailure("mfa", t.personId, "mfa.failed", MFA_FREE_FAILURES);
    await expect(verifyMfa(t.personId, "000000")).rejects.toMatchObject({ code: "rate_limited", message: expect.stringMatching(/Too many failed attempts/) });
    await clearFailures("mfa", t.personId);
    await expect(verifyMfa(t.personId, "000000")).rejects.toMatchObject({ code: "unauthenticated" }); // no MFA enrolled: plain bad code, not locked
  });
  it("failure bookkeeping never throws when Redis is down", async () => {
    vi.spyOn(redis, "multi").mockImplementation(() => { throw new Error("redis down"); });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(recordFailure("signin", newEmail(), "auth.signin_failed")).resolves.toBe(0);
    vi.spyOn(redis, "get").mockRejectedValue(new Error("redis down"));
    await expect(backoffRemaining("signin", newEmail())).resolves.toBe(0);
    vi.spyOn(redis, "del").mockRejectedValue(new Error("redis down"));
    await expect(clearFailures("signin", newEmail())).resolves.toBeUndefined();
  });
});

describe("refresh-token rotation grace window", () => {
  beforeEach(() => void 0);
  it("the immediately previous token returns the already-rotated pair within ~10s and the session survives", async () => {
    const { t, ctx } = await signUp();
    const sid = sidOf(t.accessToken);
    const r1 = await refreshSession(t.refreshToken, ctx);
    const again = await refreshSession(t.refreshToken, ctx); // the lost-race / retried request
    expect(again.refreshToken).toBe(r1.refreshToken);
    expect(again.accessToken).toBe(r1.accessToken);
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: sid } })).revokedAt).toBeNull();
    expect(await getSession(r1.accessToken)).not.toBeNull();
    // and the new token keeps working
    await expect(refreshSession(r1.refreshToken, ctx)).resolves.toMatchObject({ personId: t.personId });
  });
  it("two concurrent refreshes with the same token both succeed with the same pair, without revoking", async () => {
    const { t, ctx } = await signUp();
    const results = await Promise.allSettled([refreshSession(t.refreshToken, ctx), refreshSession(t.refreshToken, ctx)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: sidOf(t.accessToken) } })).revokedAt).toBeNull();
  });
  it("reuse AFTER the grace window is theft: the whole session is revoked", async () => {
    const { t, ctx } = await signUp();
    const sid = sidOf(t.accessToken);
    const r1 = await refreshSession(t.refreshToken, ctx);
    await ageRotation(sid);
    await expect(refreshSession(t.refreshToken, ctx)).rejects.toMatchObject({ code: "unauthenticated" });
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: sid } })).revokedAt).not.toBeNull();
    expect(await getSession(r1.accessToken)).toBeNull();
  });
  it("within the window but without the cached pair: fails WITHOUT revoking (no-op), never hands out anything", async () => {
    const { t, ctx } = await signUp();
    const sid = sidOf(t.accessToken);
    const r1 = await refreshSession(t.refreshToken, ctx);
    const { sha256 } = await import("../src/tokens");
    await redis.del(`rtgrace:${sha256(t.refreshToken)}`);
    await expect(refreshSession(t.refreshToken, ctx)).rejects.toMatchObject({ code: "unauthenticated" });
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: sid } })).revokedAt).toBeNull();
    expect(await getSession(r1.accessToken)).not.toBeNull();
  });
  it("the grace entry is encrypted (the refresh token is not readable in Redis) and a tampered entry is ignored", async () => {
    const { t, ctx } = await signUp();
    const r1 = await refreshSession(t.refreshToken, ctx);
    const { sha256 } = await import("../src/tokens");
    const key = `rtgrace:${sha256(t.refreshToken)}`;
    const raw = (await redis.get(key))!;
    expect(raw).not.toContain(r1.refreshToken);
    expect(Buffer.from(raw, "base64").toString("utf8")).not.toContain(r1.refreshToken);
    await redis.set(key, Buffer.from("garbage-garbage-garbage-garbage-garbage").toString("base64"), "EX", 20);
    await expect(refreshSession(t.refreshToken, ctx)).rejects.toMatchObject({ code: "unauthenticated" });
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: sidOf(t.accessToken) } })).revokedAt).toBeNull();
  });
  it("a different realm re-presenting the previous token in the window is not served the pair (revoked as theft)", async () => {
    const { t, ctx } = await signUp();
    const sid = sidOf(t.accessToken);
    await refreshSession(t.refreshToken, ctx);
    await expect(refreshSession(t.refreshToken, { ...ctx, realm: "seller" })).rejects.toMatchObject({ code: "unauthenticated" });
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: sid } })).revokedAt).not.toBeNull();
  });
});

describe("revocation marker when Redis fails", () => {
  it("a failed 'revoked' write deletes the cached valid marker, so the revoked session is not served from cache", async () => {
    const { t } = await signUp();
    const sid = sidOf(t.accessToken);
    expect(await redis.get(`sess:${sid}`)).toBe("1");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const realSet = redis.set.bind(redis);
    vi.spyOn(redis, "set").mockImplementation(((...a: unknown[]) => (a[1] === "revoked" ? Promise.reject(new Error("redis write failed")) : (realSet as (...x: unknown[]) => unknown)(...a))) as never);
    await signOut(t.refreshToken);
    expect(await redis.get(`sess:${sid}`)).toBeNull(); // valid marker gone, not left stale
    expect(await getSession(t.accessToken)).toBeNull(); // falls back to the DB, which is revoked
  });
  it("when even the delete fails it logs loudly (SECURITY) instead of silently keeping a stale marker", async () => {
    const { t } = await signUp();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const realSet = redis.set.bind(redis);
    vi.spyOn(redis, "set").mockImplementation(((...a: unknown[]) => (a[1] === "revoked" ? Promise.reject(new Error("w")) : (realSet as (...x: unknown[]) => unknown)(...a))) as never);
    vi.spyOn(redis, "del").mockRejectedValue(new Error("d"));
    await signOut(t.refreshToken);
    expect(err.mock.calls.some((c) => String(c[0]).startsWith("SECURITY:"))).toBe(true);
  });
});

describe("account pre-hijack on Google linking", () => {
  const claims = (email: string) => ({ sub: `g-${uid()}`, email, name: "Real Owner" });
  it("linking Google to an account whose email was never verified revokes every session and drops the password", async () => {
    const { email, t } = await signUp(); // sign-up never verifies the email: this is the attacker's pre-created account
    const attackerSession = t.accessToken;
    expect(await getSession(attackerSession)).not.toBeNull();
    const r = await upsertGoogleUser(claims(email));
    expect(r).toEqual({ personId: t.personId, isNew: false });
    const p = await prisma.person.findUniqueOrThrow({ where: { id: t.personId } });
    expect(p.passwordHash).toBeNull();
    expect(p.emailVerifiedAt).not.toBeNull();
    expect(await prisma.authSession.count({ where: { personId: t.personId, revokedAt: null } })).toBe(0);
    expect(await getSession(attackerSession)).toBeNull(); // cache flipped too: the already-minted access token dies now
    await expect(refreshSession(t.refreshToken, ctxFor())).rejects.toMatchObject({ code: "unauthenticated" });
  });
  it("an account whose email WAS verified keeps its sessions and password when Google is linked", async () => {
    const { email, t } = await signUp();
    await prisma.person.update({ where: { id: t.personId }, data: { emailVerifiedAt: new Date() } });
    await upsertGoogleUser(claims(email));
    const p = await prisma.person.findUniqueOrThrow({ where: { id: t.personId } });
    expect(p.passwordHash).not.toBeNull();
    expect(await getSession(t.accessToken)).not.toBeNull();
  });
});

describe("GSTIN control-proof port", () => {
  afterEach(() => setGstControlProvider(null));
  it("the mock accepts only its fixed code outside production and refuses to prove anything in production", async () => {
    const p = getGstControlProvider();
    expect(p).toBe(mockGstControlProvider);
    const ch = await p.start("27AAAAA0000A1Z5");
    expect(ch.maskedContact).toMatch(/X/);
    expect(await p.confirm(ch.ref, " 123456 ")).toBe(true);
    expect(await p.confirm(ch.ref, "000000")).toBe(false);
    expect(await p.confirm("", "123456")).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    await expect(p.start("27AAAAA0000A1Z5")).rejects.toMatchObject({ code: "validation" });
    expect(await p.confirm(ch.ref, "123456")).toBe(false);
  });
  it("a real provider can be swapped in", async () => {
    setGstControlProvider({ name: "x", start: async () => ({ ref: "r", maskedContact: "m" }), confirm: async () => true });
    expect(getGstControlProvider().name).toBe("x");
  });
});

describe("account mail queue and related edges", () => {
  it("enqueueAccountMail swallows queue failures (a queue hiccup must not be observable to the caller)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setJobQueue({ enqueue: async () => { throw new Error("queue down"); } } as never);
    await expect(enqueueAccountMail({ to: "a@example.test", subject: "s", text: "t" })).resolves.toBeUndefined();
    setJobQueue(new MemoryJobQueue());
  });
  it("sign-up that loses a create race for the same email gets the same non-revealing response and the owner is emailed", async () => {
    const q = new MemoryJobQueue();
    setJobQueue(q);
    const { email, t } = await signUp();
    vi.spyOn(prisma.person, "findUnique").mockResolvedValueOnce(null); // the pre-check misses; the unique index catches it
    const r = await signUpWithPassword({ email, password: "another long passphrase" }, ctxFor());
    expect(r.isNew).toBe(true);
    expect(r.personId).not.toBe(t.personId);
    expect(await getSession(r.accessToken)).toBeNull();
    const sent: string[] = [];
    await q.consume("identity.mail", "g", "c", async (m) => void sent.push(m.payload.to));
    expect(sent).toEqual([email]);
  });
  it("GstinClaimReleased recomputes the released business's trust score (drops the badge now, not at the next decay run)", async () => {
    const b = await prisma.business.create({ data: { name: "Released Co", isSeller: true, verificationTier: 0, trustScore: 90, badgeActive: true }, select: { id: true } });
    try {
      await trustHandlers.GstinClaimReleased!({ id: 1, type: "GstinClaimReleased", version: 1, aggregateType: "Business", aggregateId: b.id, occurredAt: new Date().toISOString(), payload: { businessId: b.id, gstin: "27AAAAA0000A1Z5", reason: "superseded" } } as never);
      const after = await prisma.business.findUniqueOrThrow({ where: { id: b.id } });
      expect(after.badgeActive).toBe(false);
      expect(after.trustScore).toBeLessThan(90);
    } finally {
      await prisma.domainEvent.deleteMany({ where: { aggregateId: b.id } });
      await prisma.business.delete({ where: { id: b.id } });
    }
  });
});

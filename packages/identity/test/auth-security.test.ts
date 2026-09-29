// Sign-up / sign-in / sessions / password reset: security-critical behaviour against the isolated test DB + Redis.
import { randomUUID } from "node:crypto";
import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

vi.mock("../src/password", async (orig) => {
  const m = await orig<typeof import("../src/password")>();
  return { ...m, dummyVerify: vi.fn(m.dummyVerify) };
});

import {
  getSession, listAuthSessions, refreshSession, requestPasswordReset, resetPassword, setMailer, signInWithPassword, signOut, signOutAllSessions,
  signUpWithPassword, erasePerson,
} from "../src";
import { dummyVerify } from "../src/password";
import { revokeAllSessions } from "../src/sessions";
import { sha256, signAccessToken } from "../src/tokens";
import { REALM_POLICY, type Realm } from "../src/constants";

const PW = "a fine long passphrase";
const made: string[] = [];
const uid = () => randomUUID();
const ctxFor = (realm?: Realm, extra: object = {}) => ({ ip: uid(), userAgent: "vitest", realm, ...extra });
const newEmail = () => `sec-${uid()}@example.test`;
async function signUp(realm?: Realm) {
  const email = newEmail();
  const t = await signUpWithPassword({ email, password: PW, name: "Sec Test" }, ctxFor(realm));
  made.push(t.personId);
  return { email, t };
}
const delKeys = async (pattern: string) => { const k = await redis.keys(pattern); if (k.length) await redis.del(...k); };
const sidOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).sid as string;

afterAll(async () => {
  await prisma.authSession.deleteMany({ where: { personId: { in: made } } });
  await prisma.consent.deleteMany({ where: { personId: { in: made } } });
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: made } } });
  await prisma.person.deleteMany({ where: { id: { in: made } } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(dummyVerify).mockClear();
});

describe("sign-up", () => {
  it("validates email, password policy and name with field messages", async () => {
    await expect(signUpWithPassword({ email: "nope", password: PW }, ctxFor())).rejects.toBeInstanceOf(ZodError);
    await expect(signUpWithPassword({ email: newEmail(), password: "short" }, ctxFor())).rejects.toBeInstanceOf(ZodError);
    await expect(signUpWithPassword({ email: newEmail(), password: PW, name: "x".repeat(101) }, ctxFor())).rejects.toBeInstanceOf(ZodError);
    await expect(signUpWithPassword({ email: `${"a".repeat(250)}@x.co`, password: PW }, ctxFor())).rejects.toBeInstanceOf(ZodError);
  });
  it("normalises email, treats blank name as null, writes granted AND denied consents + events, stores only a scrypt hash", async () => {
    const raw = `  Mixed-${uid()}@Example.TEST `;
    const t = await signUpWithPassword({ email: raw, password: PW, name: "   ", consents: { matching: true, marketing: false } }, ctxFor());
    made.push(t.personId);
    expect(t.isNew).toBe(true);
    const p = await prisma.person.findUniqueOrThrow({ where: { id: t.personId } });
    expect(p.email).toBe(raw.trim().toLowerCase());
    expect(p.name).toBeNull();
    expect(p.passwordHash).toMatch(/^scrypt\$/);
    expect(p.passwordHash).not.toContain(PW);
    const consents = await prisma.consent.findMany({ where: { personId: t.personId }, });
    expect(consents.map((c) => [c.purpose, c.granted]).sort()).toEqual([["marketing", false], ["matching", true]]);
    expect(await prisma.domainEvent.count({ where: { aggregateId: t.personId, type: "ConsentChanged" } })).toBe(2);
  });
  it("duplicate email (any case) is a conflict, not a leak of a 500", async () => {
    const { email } = await signUp();
    await expect(signUpWithPassword({ email: email.toUpperCase(), password: PW }, ctxFor())).rejects.toMatchObject({ code: "conflict" });
  });
  it("rate limit: 5 attempts per IP per hour allowed, 6th rejected (even before validation), window resets", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
    const ip = uid();
    for (let i = 0; i < 5; i++) await expect(signUpWithPassword({ email: "bad", password: PW }, { ip, userAgent: null })).rejects.toBeInstanceOf(ZodError);
    await expect(signUpWithPassword({ email: "bad", password: PW }, { ip, userAgent: null })).rejects.toMatchObject({ code: "rate_limited" });
    vi.setSystemTime(new Date("2031-01-01T00:59:59Z"));
    await expect(signUpWithPassword({ email: "bad", password: PW }, { ip, userAgent: null })).rejects.toMatchObject({ code: "rate_limited" });
    vi.setSystemTime(new Date("2031-01-01T01:00:00Z"));
    await expect(signUpWithPassword({ email: "bad", password: PW }, { ip, userAgent: null })).rejects.toBeInstanceOf(ZodError);
  });
  it("a null ip shares one 'unknown' bucket", async () => {
    await delKeys("rl:signup:ip:unknown:*");
    for (let i = 0; i < 5; i++) await expect(signUpWithPassword({ email: "bad", password: PW }, { ip: null, userAgent: null })).rejects.toBeInstanceOf(ZodError);
    await expect(signUpWithPassword({ email: "bad", password: PW }, { ip: null, userAgent: null })).rejects.toMatchObject({ code: "rate_limited" });
    await delKeys("rl:signup:ip:unknown:*");
  });
});

describe("sign-in: enumeration resistance", () => {
  it("unknown, malformed, passwordless, erased and wrong-password accounts return the identical error", async () => {
    const { email } = await signUp();
    const googleOnly = await prisma.person.create({ data: { email: newEmail() }, select: { id: true, email: true } });
    made.push(googleOnly.id);
    const erased = await signUp();
    await erasePerson(erased.t.personId);
    const cases: { email: string; password: string }[] = [
      { email, password: "definitely wrong pw" },
      { email: newEmail(), password: PW },
      { email: "not-an-email", password: PW },
      { email: googleOnly.email!, password: PW },
      { email: erased.email, password: PW },
    ];
    const errs = [];
    for (const c of cases) errs.push(await signInWithPassword(c, ctxFor()).catch((e) => e));
    for (const e of errs) expect(e).toMatchObject({ code: "unauthenticated", message: "Invalid email or password" });
    expect(new Set(errs.map((e) => e.message)).size).toBe(1);
  });
  it("burns a dummy scrypt verification on every no-account path but not when a real hash was checked", async () => {
    const { email } = await signUp();
    const googleOnly = await prisma.person.create({ data: { email: newEmail() }, select: { id: true, email: true } });
    made.push(googleOnly.id);
    vi.mocked(dummyVerify).mockClear();
    await signInWithPassword({ email: newEmail(), password: PW }, ctxFor()).catch(() => {});
    await signInWithPassword({ email: "garbage", password: PW }, ctxFor()).catch(() => {});
    await signInWithPassword({ email: googleOnly.email!, password: PW }, ctxFor()).catch(() => {});
    expect(dummyVerify).toHaveBeenCalledTimes(3);
    await signInWithPassword({ email, password: "wrong wrong wrong" }, ctxFor()).catch(() => {});
    expect(dummyVerify).toHaveBeenCalledTimes(3);
  });
  it("is case-insensitive on email, caps password length at 256 chars and tolerates non-string input", async () => {
    const { email, t } = await signUp();
    const ok = await signInWithPassword({ email: `  ${email.toUpperCase()} `, password: PW }, ctxFor());
    expect(ok).toMatchObject({ personId: t.personId, isNew: false });
    await expect(signInWithPassword({ email, password: undefined as unknown as string }, ctxFor())).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(signInWithPassword({ email: undefined as unknown as string, password: PW }, ctxFor())).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(signInWithPassword({ email, password: "y".repeat(100_000) }, ctxFor())).rejects.toMatchObject({ code: "unauthenticated" });
  });
  it("per-email limit: 5/min allowed then rate_limited; resets in the next window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2032-03-01T10:00:00Z"));
    const email = newEmail();
    const ip = () => ({ ip: uid(), userAgent: null });
    for (let i = 0; i < 5; i++) await expect(signInWithPassword({ email, password: "x" }, ip())).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(signInWithPassword({ email, password: "x" }, ip())).rejects.toMatchObject({ code: "rate_limited" });
    // the limiter cannot be dodged by changing case/whitespace of the email
    await expect(signInWithPassword({ email: ` ${email.toUpperCase()}`, password: "x" }, ip())).rejects.toMatchObject({ code: "rate_limited" });
    vi.setSystemTime(new Date("2032-03-01T10:01:00Z"));
    await expect(signInWithPassword({ email, password: "x" }, ip())).rejects.toMatchObject({ code: "unauthenticated" });
  });
  it("per-IP limit: 20/min allowed then rate_limited across different emails; resets", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2033-03-01T10:00:00Z"));
    const ip = uid();
    for (let i = 0; i < 20; i++) await expect(signInWithPassword({ email: `u${i}-${uid()}@x.test`, password: "x" }, { ip, userAgent: null })).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(signInWithPassword({ email: `z-${uid()}@x.test`, password: "x" }, { ip, userAgent: null })).rejects.toMatchObject({ code: "rate_limited" });
    vi.setSystemTime(new Date("2033-03-01T10:01:00Z"));
    await expect(signInWithPassword({ email: `y-${uid()}@x.test`, password: "x" }, { ip, userAgent: null })).rejects.toMatchObject({ code: "unauthenticated" });
  });
  it("records userAgent (truncated to 300) and ip on the session", async () => {
    const { email } = await signUp();
    const ip = `ip-${uid()}`;
    const t = await signInWithPassword({ email, password: PW }, { ip, userAgent: "u".repeat(500) });
    const row = await prisma.authSession.findUniqueOrThrow({ where: { id: sidOf(t.accessToken) } });
    expect(row.userAgent).toHaveLength(300);
    expect(row.ip).toBe(ip);
    expect(row.refreshTokenHash).toBe(sha256(t.refreshToken));
    expect(row.refreshTokenHash).not.toBe(t.refreshToken);
  });
});

describe("sessions per realm", () => {
  it("cross-realm access tokens and refresh tokens are rejected for every realm pair", async () => {
    const { email } = await signUp();
    const realms: Realm[] = ["web", "seller", "admin"];
    for (const a of realms) {
      const t = await signInWithPassword({ email, password: PW }, ctxFor(a));
      expect((await getSession(t.accessToken, a))?.personId).toBe(t.personId);
      for (const b of realms.filter((r) => r !== a)) {
        expect(await getSession(t.accessToken, b)).toBeNull();
        // refresh token used in the wrong realm fails AND burns the session (treated as theft)
        await expect(refreshSession(t.refreshToken, ctxFor(b))).rejects.toMatchObject({ code: "unauthenticated" });
        expect(await getSession(t.accessToken, a)).toBeNull();
        break;
      }
    }
  });
  it("realm is persisted on the session row and defaults to web", async () => {
    const { t } = await signUp();
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: sidOf(t.accessToken) } })).realm).toBe("web");
    const s = await signInWithPassword({ email: (await prisma.person.findUniqueOrThrow({ where: { id: t.personId } })).email!, password: PW }, ctxFor("seller"));
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: sidOf(s.accessToken) } })).realm).toBe("seller");
  });
  it("refresh lifetimes follow the realm policy and rotation never extends them (absolute cap)", async () => {
    const { email } = await signUp();
    for (const r of ["web", "seller", "admin"] as Realm[]) {
      const t = await signInWithPassword({ email, password: PW }, ctxFor(r));
      const ttl = new Date(t.refreshExpiresAt).getTime() - Date.now();
      expect(Math.abs(ttl - REALM_POLICY[r].refreshTtlSeconds * 1000)).toBeLessThan(5000);
      const r1 = await refreshSession(t.refreshToken, ctxFor(r));
      const r2 = await refreshSession(r1.refreshToken, ctxFor(r));
      expect(r2.refreshExpiresAt).toBe(t.refreshExpiresAt);
      expect(r1.isNew).toBe(false);
    }
  });
  it("admin refresh is refused after the 12h cap even if the token was just rotated", async () => {
    const { email } = await signUp();
    const t = await signInWithPassword({ email, password: PW }, ctxFor("admin"));
    const r1 = await refreshSession(t.refreshToken, ctxFor("admin"));
    await prisma.authSession.update({ where: { id: sidOf(t.accessToken) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(refreshSession(r1.refreshToken, ctxFor("admin"))).rejects.toMatchObject({ code: "unauthenticated" });
  });
  it("admission guard runs at sign-in AND at every refresh; failing it revokes the session", async () => {
    const { email } = await signUp();
    const guard = vi.fn(async () => true);
    const t = await signInWithPassword({ email, password: PW }, ctxFor("admin", { allowPerson: guard }));
    expect(guard).toHaveBeenCalledTimes(1);
    const r = await refreshSession(t.refreshToken, ctxFor("admin", { allowPerson: guard }));
    expect(guard).toHaveBeenCalledTimes(2);
    guard.mockResolvedValue(false);
    await expect(refreshSession(r.refreshToken, ctxFor("admin", { allowPerson: guard }))).rejects.toMatchObject({ code: "unauthenticated" });
    expect(await getSession(r.accessToken, "admin")).toBeNull();
    // and a rejected sign-in creates no session row at all
    const before = await prisma.authSession.count({ where: { personId: t.personId } });
    await expect(signInWithPassword({ email, password: PW }, ctxFor("admin", { allowPerson: async () => false }))).rejects.toMatchObject({ message: "Invalid email or password" });
    expect(await prisma.authSession.count({ where: { personId: t.personId } })).toBe(before);
  });
  it("signOut(realm) only ends sessions of that realm; signOutAllSessions(realm) is per app, no realm = everywhere", async () => {
    const { email, t: web } = await signUp();
    const seller = await signInWithPassword({ email, password: PW }, ctxFor("seller"));
    const admin = await signInWithPassword({ email, password: PW }, ctxFor("admin"));
    await signOut(seller.refreshToken, "web"); // wrong realm: no-op
    expect(await getSession(seller.accessToken, "seller")).not.toBeNull();
    await signOut(seller.refreshToken, "seller");
    expect(await getSession(seller.accessToken, "seller")).toBeNull();
    await signOutAllSessions(web.personId, "admin");
    expect(await getSession(admin.accessToken, "admin")).toBeNull();
    expect(await getSession(web.accessToken, "web")).not.toBeNull();
    await signOutAllSessions(web.personId);
    expect(await getSession(web.accessToken, "web")).toBeNull();
  });
  it("signOut also accepts the previous (rotated) token, and ignores empty/unknown tokens", async () => {
    const { t } = await signUp();
    const r = await refreshSession(t.refreshToken, ctxFor());
    await signOut("");
    await signOut("unknown-token");
    expect(await getSession(r.accessToken)).not.toBeNull();
    await signOut(t.refreshToken);
    expect(await getSession(r.accessToken)).toBeNull();
  });
  it("listAuthSessions lists live sessions only, per realm, flagging the current one", async () => {
    const { email, t } = await signUp();
    const s = await signInWithPassword({ email, password: PW }, ctxFor("seller"));
    const dead = await signInWithPassword({ email, password: PW }, ctxFor("web"));
    await signOut(dead.refreshToken);
    const all = await listAuthSessions(t.personId, sidOf(t.accessToken));
    expect(all).toHaveLength(2);
    expect(all.find((x) => x.current)?.id).toBe(sidOf(t.accessToken));
    const onlySeller = await listAuthSessions(t.personId, undefined, "seller");
    expect(onlySeller.map((x) => x.id)).toEqual([sidOf(s.accessToken)]);
    expect(onlySeller[0]!.current).toBeUndefined();
    await prisma.authSession.update({ where: { id: sidOf(s.accessToken) }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect(await listAuthSessions(t.personId, undefined, "seller")).toHaveLength(0);
  });
});

describe("refresh rotation", () => {
  it("rejects empty, unknown and expired refresh tokens", async () => {
    await expect(refreshSession("", ctxFor())).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(refreshSession("nope", ctxFor())).rejects.toMatchObject({ code: "unauthenticated" });
    const { t } = await signUp();
    await prisma.authSession.update({ where: { id: sidOf(t.accessToken) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(refreshSession(t.refreshToken, ctxFor())).rejects.toMatchObject({ code: "unauthenticated" });
  });
  it("rejects a revoked session's refresh token", async () => {
    const { t } = await signUp();
    await signOut(t.refreshToken);
    await expect(refreshSession(t.refreshToken, ctxFor())).rejects.toMatchObject({ code: "unauthenticated" });
  });
  it("concurrent refreshes with the same token: exactly one wins (compare-and-swap)", async () => {
    for (let round = 0; round < 3; round++) {
      const { t } = await signUp();
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => refreshSession(t.refreshToken, ctxFor())));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "unauthenticated" });
    }
  });
  it("reuse of a rotated token revokes the whole session in Redis and the DB", async () => {
    const { t } = await signUp();
    const sid = sidOf(t.accessToken);
    const r1 = await refreshSession(t.refreshToken, ctxFor());
    await expect(refreshSession(t.refreshToken, ctxFor())).rejects.toMatchObject({ code: "unauthenticated" });
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: sid } })).revokedAt).not.toBeNull();
    expect(await redis.get(`sess:${sid}`)).toBe("revoked");
    expect(await getSession(r1.accessToken)).toBeNull();
  });
  it("keeps the previous userAgent/ip when the refresh context omits them, otherwise updates", async () => {
    const { t } = await signUp();
    const sid = sidOf(t.accessToken);
    const r1 = await refreshSession(t.refreshToken, { ip: null, userAgent: null });
    const row = await prisma.authSession.findUniqueOrThrow({ where: { id: sid } });
    expect(row.userAgent).toBe("vitest");
    await refreshSession(r1.refreshToken, { ip: "9.9.9.9", userAgent: "Other/1.0" });
    const row2 = await prisma.authSession.findUniqueOrThrow({ where: { id: sid } });
    expect(row2).toMatchObject({ userAgent: "Other/1.0", ip: "9.9.9.9" });
  });
});

describe("getSession", () => {
  it("returns null for missing/garbage/expired tokens and for erased people", async () => {
    expect(await getSession(undefined)).toBeNull();
    expect(await getSession(null)).toBeNull();
    expect(await getSession("")).toBeNull();
    expect(await getSession("a.b.c")).toBeNull();
    const { t } = await signUp();
    const expired = await signAccessToken(t.personId, sidOf(t.accessToken), Date.now() - 20 * 60_000);
    expect(await getSession(expired.token)).toBeNull();
    await prisma.person.update({ where: { id: t.personId }, data: { erasedAt: new Date() } });
    expect(await getSession(t.accessToken)).toBeNull();
  });
  it("a valid token for a session that never existed is rejected (cold cache, no DB row)", async () => {
    const { t } = await signUp();
    const ghost = uid();
    const { token } = await signAccessToken(t.personId, ghost);
    expect(await getSession(token)).toBeNull();
    expect(await redis.get(`sess:${ghost}`)).toBe("revoked"); // negative result cached
  });
  it("revocation is visible with a cold cache, an expired session too", async () => {
    const { t } = await signUp();
    const sid = sidOf(t.accessToken);
    await redis.del(`sess:${sid}`);
    expect(await getSession(t.accessToken)).not.toBeNull(); // DB fallback repopulates
    expect(await redis.get(`sess:${sid}`)).toBe("1");
    await prisma.authSession.update({ where: { id: sid }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await redis.del(`sess:${sid}`);
    expect(await getSession(t.accessToken)).toBeNull();
  });
  it("Redis down: falls back to the DB (revoked stays revoked, live stays live) and never throws", async () => {
    const live = await signUp();
    const dead = await signUp();
    await prisma.authSession.updateMany({ where: { personId: dead.t.personId }, data: { revokedAt: new Date() } });
    vi.spyOn(redis, "get").mockRejectedValue(new Error("redis down"));
    vi.spyOn(redis, "set").mockRejectedValue(new Error("redis down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await getSession(live.t.accessToken))?.personId).toBe(live.t.personId);
    expect(await getSession(dead.t.accessToken)).toBeNull();
    expect(err).toHaveBeenCalled(); // cache write failures are logged, not thrown
  });
  it("Redis cache write failure at sign-in does not break issuing a session", async () => {
    const { email } = await signUp();
    vi.spyOn(redis, "set").mockRejectedValue(new Error("redis down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await signInWithPassword({ email, password: PW }, ctxFor());
    expect(t.accessToken).toBeTruthy();
  });
  it("a cached 'revoked' marker wins over a live DB row (fail closed)", async () => {
    const { t } = await signUp();
    await redis.set(`sess:${sidOf(t.accessToken)}`, "revoked", "EX", 60);
    expect(await getSession(t.accessToken)).toBeNull();
  });
  it("exposes the person's active business or null", async () => {
    const { t } = await signUp();
    const s = await getSession(t.accessToken);
    expect(s).toMatchObject({ business: null, phoneVerified: false, preferredLanguage: expect.any(String) });
  });
  it("revokeAllSessions returns the ids it revoked and is idempotent", async () => {
    const { email, t } = await signUp();
    await signInWithPassword({ email, password: PW }, ctxFor("seller"));
    const ids = await revokeAllSessions(t.personId);
    expect(ids).toHaveLength(2);
    expect(await revokeAllSessions(t.personId)).toEqual([]);
  });
});

describe("password reset", () => {
  let sent: { to: string; subject: string; text: string }[] = [];
  beforeEach(() => {
    sent = [];
    setMailer({ async send(m) { sent.push(m); } });
  });
  afterEach(async () => {
    const { consoleMailer } = await import("../src/mailer");
    setMailer(consoleMailer);
  });
  const tokenOf = (text: string) => /token=([\w-]+)/.exec(text)![1]!;

  it("emails a single-use link whose token is stored only as a hash with a 30 min TTL; revokes sessions in ALL realms", async () => {
    const { email, t } = await signUp();
    const seller = await signInWithPassword({ email, password: PW }, ctxFor("seller"));
    const admin = await signInWithPassword({ email, password: PW }, ctxFor("admin"));
    await requestPasswordReset(`  ${email.toUpperCase()} `, ctxFor());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: email, subject: "Reset your password" });
    const token = tokenOf(sent[0]!.text);
    expect(await redis.get(`pwreset:${token}`)).toBeNull(); // raw token is never a key
    const ttl = await redis.ttl(`pwreset:${sha256(token)}`);
    expect(ttl).toBeGreaterThan(29 * 60);
    expect(ttl).toBeLessThanOrEqual(30 * 60);
    await resetPassword(token, "brand new passphrase");
    expect(await getSession(t.accessToken, "web")).toBeNull();
    expect(await getSession(seller.accessToken, "seller")).toBeNull();
    expect(await getSession(admin.accessToken, "admin")).toBeNull();
    await expect(signInWithPassword({ email, password: PW }, ctxFor())).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(signInWithPassword({ email, password: "brand new passphrase" }, ctxFor())).resolves.toBeTruthy();
  });
  it("token is single-use even under concurrent redemption", async () => {
    const { email } = await signUp();
    await requestPasswordReset(email, ctxFor());
    const token = tokenOf(sent[0]!.text);
    const res = await Promise.allSettled([resetPassword(token, "concurrent passphrase 1"), resetPassword(token, "concurrent passphrase 2")]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(res.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "validation" } });
  });
  it("rejects empty/unknown/expired tokens and weak passwords WITHOUT consuming the token", async () => {
    const { email } = await signUp();
    await requestPasswordReset(email, ctxFor());
    const token = tokenOf(sent[0]!.text);
    await expect(resetPassword("", "brand new passphrase")).rejects.toMatchObject({ code: "validation" });
    await expect(resetPassword("unknown", "brand new passphrase")).rejects.toMatchObject({ code: "validation" });
    await expect(resetPassword(token, "short")).rejects.toBeInstanceOf(ZodError);
    expect(await redis.exists(`pwreset:${sha256(token)}`)).toBe(1);
    await redis.del(`pwreset:${sha256(token)}`); // simulates TTL expiry
    await expect(resetPassword(token, "brand new passphrase")).rejects.toMatchObject({ code: "validation" });
  });
  it("does not reveal (or email) unknown, malformed or erased accounts", async () => {
    const erased = await signUp();
    await erasePerson(erased.t.personId);
    await expect(requestPasswordReset(newEmail(), ctxFor())).resolves.toBeUndefined();
    await expect(requestPasswordReset("not-an-email", ctxFor())).resolves.toBeUndefined();
    await expect(requestPasswordReset(erased.email, ctxFor())).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });
  it("link points at the realm's app URL", async () => {
    const { email } = await signUp();
    vi.stubEnv("ADMIN_APP_URL", "https://admin.example.test");
    await requestPasswordReset(email, ctxFor("admin"));
    expect(sent[0]!.text).toContain("https://admin.example.test/reset-password?token=");
    vi.unstubAllEnvs();
  });
  it("rate limit: 3 per email per hour; the 4th is rejected and the window resets", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2034-05-05T00:00:00Z"));
    const { email } = await signUp();
    for (let i = 0; i < 3; i++) await requestPasswordReset(email, ctxFor());
    expect(sent).toHaveLength(3);
    await expect(requestPasswordReset(email, ctxFor())).rejects.toMatchObject({ code: "rate_limited" });
    // limiter applies equally to unknown emails so it cannot be used to enumerate
    const ghost = newEmail();
    for (let i = 0; i < 3; i++) await requestPasswordReset(ghost, ctxFor());
    await expect(requestPasswordReset(ghost, ctxFor())).rejects.toMatchObject({ code: "rate_limited" });
    vi.setSystemTime(new Date("2034-05-05T01:00:01Z"));
    await requestPasswordReset(email, ctxFor());
    expect(sent).toHaveLength(4);
  });
});

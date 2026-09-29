import { randomUUID } from "node:crypto";
import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { enforceLimit } from "../src/limits";
import { getSession, refreshSession, signInWithPassword, signOut, signUpWithPassword, getConsents, setConsent, erasePerson, resetPassword, requestPasswordReset, setMailer } from "../src";
import { sha256 } from "../src/tokens";

const ctx = { ip: `test-${randomUUID()}`, userAgent: "vitest" };
const emails: string[] = [];
const newEmail = () => {
  const e = `t-${randomUUID()}@example.test`;
  emails.push(e);
  return e;
};
const PW = "a fine long passphrase";

afterAll(async () => {
  const people = await prisma.person.findMany({ where: { OR: [{ email: { in: emails } }, { erasedAt: { not: null }, name: null, email: null, id: { in: created } }] }, select: { id: true } });
  const ids = [...new Set([...people.map((p) => p.id), ...created])];
  await prisma.authSession.deleteMany({ where: { personId: { in: ids } } });
  await prisma.consent.deleteMany({ where: { personId: { in: ids } } });
  await prisma.person.deleteMany({ where: { id: { in: ids } } });
});
const created: string[] = [];
const signUp = async (email = newEmail()) => {
  const t = await signUpWithPassword({ email, password: PW, name: "Test", consents: { matching: true } }, { ...ctx, ip: randomUUID() });
  created.push(t.personId);
  return { email, t };
};

describe("sessions", () => {
  it("signs up, resolves session, rotates refresh and detects reuse", async () => {
    const { t } = await signUp();
    expect((await getSession(t.accessToken))?.personId).toBe(t.personId);

    const t2 = await refreshSession(t.refreshToken, ctx);
    expect(t2.refreshToken).not.toBe(t.refreshToken);
    expect((await getSession(t2.accessToken))?.personId).toBe(t.personId);

    // Reusing the previous token revokes the whole session, including the newest token.
    await expect(refreshSession(t.refreshToken, ctx)).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(refreshSession(t2.refreshToken, ctx)).rejects.toMatchObject({ code: "unauthenticated" });
    expect(await getSession(t2.accessToken)).toBeNull();
  });

  it("signOut revokes the session immediately", async () => {
    const { t } = await signUp();
    await signOut(t.refreshToken);
    expect(await getSession(t.accessToken)).toBeNull();
  });

  it("keeps realms apart: tokens and refresh sessions never cross apps", async () => {
    const { email } = await signUp();
    const seller = await signInWithPassword({ email, password: PW }, { ...ctx, ip: randomUUID(), realm: "seller" });
    expect((await getSession(seller.accessToken, "seller"))?.personId).toBe(seller.personId);
    expect(await getSession(seller.accessToken, "web")).toBeNull();
    expect(await getSession(seller.accessToken, "admin")).toBeNull();

    // A seller refresh token presented to the admin realm is rejected AND burns the seller session.
    await expect(refreshSession(seller.refreshToken, { ...ctx, realm: "admin" })).rejects.toMatchObject({ code: "unauthenticated" });
    expect(await getSession(seller.accessToken, "seller")).toBeNull();
  });

  it("admission guard blocks the session and looks like bad credentials", async () => {
    const { email } = await signUp();
    const deny = async () => false;
    await expect(signInWithPassword({ email, password: PW }, { ...ctx, ip: randomUUID(), realm: "admin", allowPerson: deny })).rejects.toMatchObject({
      code: "unauthenticated",
      message: "Invalid email or password",
    });
    let allowed = true;
    const guard = async () => allowed;
    const t = await signInWithPassword({ email, password: PW }, { ...ctx, ip: randomUUID(), realm: "admin", allowPerson: guard });
    // Guard is re-checked on refresh: revoking staff access ends the admin session.
    allowed = false;
    await expect(refreshSession(t.refreshToken, { ...ctx, realm: "admin", allowPerson: guard })).rejects.toMatchObject({ code: "unauthenticated" });
    expect(await getSession(t.accessToken, "admin")).toBeNull();
  });

  it("admin refresh sessions are capped at 12 hours from sign-in", async () => {
    const { email } = await signUp();
    const t = await signInWithPassword({ email, password: PW }, { ...ctx, ip: randomUUID(), realm: "admin" });
    const hours = (new Date(t.refreshExpiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThanOrEqual(12);
    const r = await refreshSession(t.refreshToken, { ...ctx, realm: "admin" });
    expect(r.refreshExpiresAt).toBe(t.refreshExpiresAt);
  });

  it("revocation is seen even when the Redis cache is cold", async () => {
    const { t } = await signUp();
    const claims = JSON.parse(Buffer.from(t.accessToken.split(".")[1]!, "base64url").toString());
    await prisma.authSession.update({ where: { id: claims.sid }, data: { revokedAt: new Date() } });
    await redis.del(`sess:${claims.sid}`);
    expect(await getSession(t.accessToken)).toBeNull();
  });
});

describe("password sign-in", () => {
  it("accepts the right password, gives a generic error otherwise", async () => {
    const { email } = await signUp();
    const c = { ...ctx, ip: randomUUID() };
    expect((await signInWithPassword({ email: email.toUpperCase(), password: PW }, c)).isNew).toBe(false);
    await expect(signInWithPassword({ email, password: "nope nope nope" }, c)).rejects.toThrow("Invalid email or password");
    await expect(signInWithPassword({ email: newEmail(), password: PW }, c)).rejects.toThrow("Invalid email or password");
  });
  it("rate-limits 5/min per email", async () => {
    const email = newEmail();
    const c = { ...ctx, ip: randomUUID() };
    for (let i = 0; i < 5; i++) await expect(signInWithPassword({ email, password: "x" }, c)).rejects.toThrow("Invalid email or password");
    await expect(signInWithPassword({ email, password: "x" }, c)).rejects.toMatchObject({ code: "rate_limited" });
  });
  it("rejects duplicate sign-up", async () => {
    const { email } = await signUp();
    await expect(signUpWithPassword({ email, password: PW }, { ...ctx, ip: randomUUID() })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("rate limit helper", () => {
  it("allows up to the limit then throws rate_limited", async () => {
    const key = `test:${randomUUID()}`;
    for (let i = 0; i < 3; i++) await enforceLimit(key, 3, 60);
    await expect(enforceLimit(key, 3, 60)).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("password reset", () => {
  it("is single-use and revokes sessions", async () => {
    const { email, t } = await signUp();
    let link = "";
    setMailer({ async send(m) { link = m.text; } });
    await requestPasswordReset(email, ctx);
    const token = /token=([\w-]+)/.exec(link)![1]!;
    expect(await redis.get(`pwreset:${sha256(token)}`)).toBeTruthy();
    await resetPassword(token, "another long passphrase");
    await expect(resetPassword(token, "yet another passphrase")).rejects.toMatchObject({ code: "validation" });
    expect(await getSession(t.accessToken)).toBeNull();
    const c = { ...ctx, ip: randomUUID() };
    await signInWithPassword({ email, password: "another long passphrase" }, c);
  });
  it("does not reveal unknown emails", async () => {
    await expect(requestPasswordReset(newEmail(), ctx)).resolves.toBeUndefined();
  });
});

describe("consent + erasure", () => {
  it("keeps an append-only ledger and tombstones on erasure", async () => {
    const { t } = await signUp();
    expect((await getConsents(t.personId)).matching).toBe(true);
    await setConsent(t.personId, "matching", false, "web");
    expect((await getConsents(t.personId)).matching).toBe(false);
    expect(await prisma.consent.count({ where: { personId: t.personId, purpose: "matching" } })).toBe(2);

    await erasePerson(t.personId);
    const p = await prisma.person.findUniqueOrThrow({ where: { id: t.personId } });
    expect(p).toMatchObject({ email: null, name: null, passwordHash: null });
    expect(p.erasedAt).not.toBeNull();
    expect(await getSession(t.accessToken)).toBeNull();
  });
});

import { DomainError, redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS } from "./constants";
import { randomToken, sha256, signAccessToken, verifyAccessToken } from "./tokens";
import type { AuthContext, AuthTokens, Session } from "./types";

const sessKey = (sid: string) => `sess:${sid}`;
/** Cache lives a little past the access-token TTL so a revoked marker outlives every token minted from it. */
const CACHE_TTL = ACCESS_TTL_SECONDS + 60;

async function cacheState(sid: string, state: "1" | "revoked") {
  try {
    await redis.set(sessKey(sid), state, "EX", CACHE_TTL);
  } catch (err) {
    console.error("session cache write failed", err);
  }
}

async function mint(personId: string, sessionId: string, refreshToken: string, isNew: boolean, refreshExpiresAt: Date): Promise<AuthTokens> {
  const access = await signAccessToken(personId, sessionId);
  return {
    personId,
    isNew,
    accessToken: access.token,
    accessExpiresAt: access.expiresAt.toISOString(),
    refreshToken,
    refreshExpiresAt: refreshExpiresAt.toISOString(),
  };
}

/** Creates a durable session and its first token pair. */
export async function issueTokens(personId: string, ctx: AuthContext, isNew = false): Promise<AuthTokens> {
  const refreshToken = randomToken(32);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);
  const row = await prisma.authSession.create({
    data: {
      personId,
      refreshTokenHash: sha256(refreshToken),
      userAgent: ctx.userAgent?.slice(0, 300) ?? null,
      ip: ctx.ip,
      expiresAt,
    },
    select: { id: true },
  });
  await cacheState(row.id, "1");
  return mint(personId, row.id, refreshToken, isNew, expiresAt);
}

async function revokeById(sessionId: string) {
  await prisma.authSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  await cacheState(sessionId, "revoked");
}

/** Rotates the refresh token. Reuse of an old token revokes the whole session (token theft signal). */
export async function refreshSession(refreshToken: string, ctx: AuthContext): Promise<AuthTokens> {
  const fail = () => new DomainError("unauthenticated", "Session expired. Please sign in again.");
  if (!refreshToken) throw fail();
  const hash = sha256(refreshToken);
  const session = await prisma.authSession.findUnique({ where: { refreshTokenHash: hash } });
  if (!session) {
    const reused = await prisma.authSession.findFirst({ where: { prevTokenHash: hash }, select: { id: true } });
    if (reused) await revokeById(reused.id);
    throw fail();
  }
  if (session.revokedAt || session.expiresAt <= new Date()) throw fail();

  const next = randomToken(32);
  // Compare-and-swap on the current hash so two concurrent refreshes cannot both win.
  const swapped = await prisma.authSession.updateMany({
    where: { id: session.id, refreshTokenHash: hash, revokedAt: null },
    data: {
      refreshTokenHash: sha256(next),
      prevTokenHash: hash,
      lastUsedAt: new Date(),
      userAgent: ctx.userAgent?.slice(0, 300) ?? session.userAgent,
      ip: ctx.ip ?? session.ip,
    },
  });
  if (swapped.count !== 1) throw fail();
  await cacheState(session.id, "1");
  return mint(session.personId, session.id, next, false, session.expiresAt);
}

async function sessionActive(sid: string): Promise<boolean> {
  try {
    const hit = await redis.get(sessKey(sid));
    if (hit === "1") return true;
    if (hit === "revoked") return false;
  } catch {
    /* Redis down: fall back to the DB (fail closed on revocation, not on availability) */
  }
  const row = await prisma.authSession.findUnique({ where: { id: sid }, select: { revokedAt: true, expiresAt: true } });
  const ok = !!row && !row.revokedAt && row.expiresAt > new Date();
  await cacheState(sid, ok ? "1" : "revoked");
  return ok;
}

export async function getSession(accessToken: string | undefined | null): Promise<Session | null> {
  if (!accessToken) return null;
  const claims = await verifyAccessToken(accessToken);
  if (!claims) return null;
  if (!(await sessionActive(claims.sessionId))) return null;

  const person = await prisma.person.findUnique({
    where: { id: claims.personId },
    include: { memberships: { include: { business: true }, orderBy: [{ role: "asc" }, { business: { createdAt: "asc" } }], take: 1 } },
  });
  if (!person || person.erasedAt) return null;
  const b = person.memberships[0]?.business;
  return {
    sessionId: claims.sessionId,
    personId: person.id,
    email: person.email,
    phone: person.phone,
    phoneVerified: !!person.phoneVerifiedAt,
    name: person.name,
    avatarUrl: person.avatarUrl,
    preferredLanguage: person.preferredLanguage,
    business: b
      ? {
          id: b.id,
          name: b.name,
          isSeller: b.isSeller,
          isBuyer: b.isBuyer,
          verificationTier: b.verificationTier,
          trustScore: b.trustScore,
          badgeActive: b.badgeActive,
        }
      : null,
  };
}

export async function signOut(refreshToken: string): Promise<void> {
  if (!refreshToken) return;
  const hash = sha256(refreshToken);
  const s = await prisma.authSession.findFirst({ where: { OR: [{ refreshTokenHash: hash }, { prevTokenHash: hash }] }, select: { id: true } });
  if (s) await revokeById(s.id);
}

/** Revokes every live session of a person (optionally inside a caller's tx-less flow). Returns revoked ids. */
export async function revokeAllSessions(personId: string): Promise<string[]> {
  const live = await prisma.authSession.findMany({ where: { personId, revokedAt: null }, select: { id: true } });
  await prisma.authSession.updateMany({ where: { personId, revokedAt: null }, data: { revokedAt: new Date() } });
  await Promise.all(live.map((s) => cacheState(s.id, "revoked")));
  return live.map((s) => s.id);
}

export async function signOutAllSessions(personId: string): Promise<void> {
  await revokeAllSessions(personId);
}

export async function listAuthSessions(personId: string, currentSessionId?: string) {
  const rows = await prisma.authSession.findMany({
    where: { personId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    userAgent: r.userAgent,
    ip: r.ip,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt.toISOString(),
    current: currentSessionId ? r.id === currentSessionId : undefined,
  }));
}

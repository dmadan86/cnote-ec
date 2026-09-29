import { DomainError, redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { REALM_POLICY, type Realm } from "./constants";
import { randomToken, sha256, signAccessToken, verifyAccessToken } from "./tokens";
import type { AuthContext, AuthTokens, Session } from "./types";

const sessKey = (sid: string) => `sess:${sid}`;
/** Cache lives a little past the longest access-token TTL so a revoked marker outlives every token minted from it. */
const CACHE_TTL = Math.max(...Object.values(REALM_POLICY).map((p) => p.accessTtlSeconds)) + 60;

const realmOf = (ctx: Pick<AuthContext, "realm">): Realm => ctx.realm ?? "web";

async function cacheState(sid: string, state: "1" | "revoked") {
  try {
    await redis.set(sessKey(sid), state, "EX", CACHE_TTL);
  } catch (err) {
    console.error("session cache write failed", err);
  }
}

async function mint(personId: string, sessionId: string, refreshToken: string, isNew: boolean, refreshExpiresAt: Date, realm: Realm): Promise<AuthTokens> {
  const access = await signAccessToken(personId, sessionId, Date.now(), realm);
  return {
    personId,
    isNew,
    accessToken: access.token,
    accessExpiresAt: access.expiresAt.toISOString(),
    refreshToken,
    refreshExpiresAt: refreshExpiresAt.toISOString(),
  };
}

/**
 * Creates a durable session in the caller's realm and its first token pair. Runs the realm's
 * admission guard first (e.g. admin requires active staff); a rejection is reported exactly like
 * bad credentials so it can't be used to probe who is staff.
 */
export async function issueTokens(personId: string, ctx: AuthContext, isNew = false): Promise<AuthTokens> {
  const realm = realmOf(ctx);
  if (ctx.allowPerson && !(await ctx.allowPerson(personId))) {
    throw new DomainError("unauthenticated", "Invalid email or password");
  }
  const refreshToken = randomToken(32);
  // Refresh lifetime is absolute from sign-in: rotation never extends it.
  const expiresAt = new Date(Date.now() + REALM_POLICY[realm].refreshTtlSeconds * 1000);
  const row = await prisma.authSession.create({
    data: {
      personId,
      realm,
      refreshTokenHash: sha256(refreshToken),
      userAgent: ctx.userAgent?.slice(0, 300) ?? null,
      ip: ctx.ip,
      expiresAt,
    },
    select: { id: true },
  });
  await cacheState(row.id, "1");
  return mint(personId, row.id, refreshToken, isNew, expiresAt, realm);
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
  // A refresh token only works in the realm it was issued for (never mint admin tokens from a
  // buyer session, etc.). A cross-realm attempt is treated as theft of that session.
  const realm = realmOf(ctx);
  if (session.realm !== realm) {
    await revokeById(session.id);
    throw fail();
  }
  // Re-check admission on every rotation so e.g. a deactivated staff member loses access within one access TTL.
  if (ctx.allowPerson && !(await ctx.allowPerson(session.personId))) {
    await revokeById(session.id);
    throw fail();
  }

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
  return mint(session.personId, session.id, next, false, session.expiresAt, realm);
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

/** Session for an access token of `realm` (default "web"); tokens from other realms return null. */
export async function getSession(accessToken: string | undefined | null, realm: Realm = "web"): Promise<Session | null> {
  if (!accessToken) return null;
  const claims = await verifyAccessToken(accessToken, undefined, realm);
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

export async function signOut(refreshToken: string, realm?: Realm): Promise<void> {
  if (!refreshToken) return;
  const hash = sha256(refreshToken);
  const s = await prisma.authSession.findFirst({
    where: { OR: [{ refreshTokenHash: hash }, { prevTokenHash: hash }], ...(realm ? { realm } : {}) },
    select: { id: true },
  });
  if (s) await revokeById(s.id);
}

/** Revokes every live session of a person — all realms, or only `realm`. Returns revoked ids. */
export async function revokeAllSessions(personId: string, realm?: Realm): Promise<string[]> {
  const where = { personId, revokedAt: null, ...(realm ? { realm } : {}) };
  const live = await prisma.authSession.findMany({ where, select: { id: true } });
  await prisma.authSession.updateMany({ where, data: { revokedAt: new Date() } });
  await Promise.all(live.map((s) => cacheState(s.id, "revoked")));
  return live.map((s) => s.id);
}

/** "Sign out everywhere" for one app (realm); pass no realm to end every session in every app. */
export async function signOutAllSessions(personId: string, realm?: Realm): Promise<void> {
  await revokeAllSessions(personId, realm);
}

export async function listAuthSessions(personId: string, currentSessionId?: string, realm?: Realm) {
  const rows = await prisma.authSession.findMany({
    where: { personId, revokedAt: null, expiresAt: { gt: new Date() }, ...(realm ? { realm } : {}) },
    orderBy: { lastUsedAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    userAgent: r.userAgent,
    ip: r.ip,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt.toISOString(),
    realm: r.realm,
    current: currentSessionId ? r.id === currentSessionId : undefined,
  }));
}

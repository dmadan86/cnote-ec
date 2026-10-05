import { randomUUID, createCipheriv, createDecipheriv, hkdfSync, randomBytes as nodeRandomBytes } from "node:crypto";
import { DomainError, redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { REALM_POLICY, type Realm } from "./constants";
import { jwtKey, randomToken, sha256, signAccessToken, verifyAccessToken } from "./tokens";
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
    if (state !== "revoked") return;
    // A failed "revoked" write must never leave a stale "valid" marker behind: that would keep a revoked session alive
    // for up to CACHE_TTL. Delete it (readers then fall back to the DB, which is already updated).
    try {
      await redis.del(sessKey(sid));
    } catch (delErr) {
      // Redis is unreachable for writes. The marker (if any) expires on its own; getSession falls back to the DB when
      // Redis reads fail too. Surface it loudly so on-call can see revocations that rely on that expiry.
      console.error(`SECURITY: could not mark session ${sid} revoked or clear its valid marker in Redis; relying on cache expiry`, delErr);
    }
  }
}

/** Marks sessions revoked in the Redis cache; use after a transaction that revoked them commits. */
export async function markSessionsRevoked(ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => cacheState(id, "revoked")));
}

/** Refresh-token rotation grace: a client that lost the race (two tabs, a retry after a dropped response) can re-present the previous token. */
export const REFRESH_GRACE_MS = 10_000;
const graceKey = (prevHash: string) => `rtgrace:${prevHash}`;
const graceKeyBytes = () => new Uint8Array(hkdfSync("sha256", jwtKey(), "cnote-refresh-grace", "aes-256-gcm", 32));

/** The freshly rotated pair is kept for the grace window, AES-GCM encrypted (it contains a refresh token), keyed from the JWT secret. */
async function graceStore(prevHash: string, pair: AuthTokens): Promise<void> {
  try {
    const iv = nodeRandomBytes(12);
    const c = createCipheriv("aes-256-gcm", graceKeyBytes(), iv);
    const enc = Buffer.concat([c.update(JSON.stringify(pair), "utf8"), c.final()]);
    await redis.set(graceKey(prevHash), Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64"), "EX", Math.ceil(REFRESH_GRACE_MS / 1000) + 2);
  } catch (err) {
    console.error("refresh grace cache write failed", err);
  }
}
async function graceLoad(prevHash: string): Promise<AuthTokens | null> {
  try {
    const raw = await redis.get(graceKey(prevHash));
    if (!raw) return null;
    const b = Buffer.from(raw, "base64");
    const d = createDecipheriv("aes-256-gcm", graceKeyBytes(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8")) as AuthTokens;
  } catch {
    return null;
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
 * Durable "last approached us" marker for the inactivity erasure (DPDP Rules 2025 Third Schedule; @cnote/compliance). Written at most
 * once a day per person, best effort: a failure here must never block a sign-in.
 */
export async function touchLastActive(personId: string, now = new Date()): Promise<void> {
  try {
    await prisma.person.updateMany({
      where: { id: personId, OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: new Date(now.getTime() - 86_400_000) } }] },
      data: { lastActiveAt: now },
    });
  } catch {
    /* the marker is a convenience for retention; sign-in must not depend on it */
  }
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
  await touchLastActive(personId);
  return mint(personId, row.id, refreshToken, isNew, expiresAt, realm);
}

/**
 * Session-shaped tokens that are NOT backed by any session row (and a refresh token that matches nothing). Used where the
 * response must look like a success without disclosing a fact (sign-up for an already-registered email). The access
 * token verifies as a JWT but getSession() rejects it because no such session exists.
 */
export async function decoyTokens(ctx: Pick<AuthContext, "realm">): Promise<AuthTokens> {
  const realm = realmOf(ctx);
  const expiresAt = new Date(Date.now() + REALM_POLICY[realm].refreshTtlSeconds * 1000);
  return mint(randomUUID(), randomUUID(), randomToken(32), true, expiresAt, realm);
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
    const reused = await prisma.authSession.findFirst({ where: { prevTokenHash: hash }, select: { id: true, revokedAt: true, expiresAt: true, realm: true, lastUsedAt: true } });
    if (reused) {
      // Rotation just happened (lastUsedAt = rotation time): this is almost certainly the same client losing a race, not
      // theft. Hand back the pair already minted for it, or fail WITHOUT revoking. Outside the window it is token reuse.
      const inGrace = !reused.revokedAt && reused.expiresAt > new Date() && reused.realm === realmOf(ctx) && Date.now() - reused.lastUsedAt.getTime() <= REFRESH_GRACE_MS;
      if (inGrace) {
        const pair = await graceLoad(hash);
        if (pair) return pair;
        throw fail();
      }
      await revokeById(reused.id);
    }
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
  await touchLastActive(session.personId);
  const pair = await mint(session.personId, session.id, next, false, session.expiresAt, realm);
  await graceStore(hash, pair);
  return pair;
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
  const ids = await revokeAllSessionsTx(prisma, personId, realm);
  await markSessionsRevoked(ids);
  return ids;
}

/**
 * DB half of revokeAllSessions, runnable inside the caller's transaction (e.g. account linking). Callers must call
 * markSessionsRevoked(ids) AFTER the transaction commits so the Redis markers flip too.
 */
export async function revokeAllSessionsTx(db: Pick<typeof prisma, "authSession">, personId: string, realm?: Realm): Promise<string[]> {
  const where = { personId, revokedAt: null, ...(realm ? { realm } : {}) };
  const live = await db.authSession.findMany({ where, select: { id: true } });
  await db.authSession.updateMany({ where, data: { revokedAt: new Date() } });
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

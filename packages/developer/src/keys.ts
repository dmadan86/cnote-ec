import { DomainError, rateLimit, redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { z } from "zod";
import { EXPIRY_OPTIONS, expiryToDate, type ExpiryOption } from "./expiry";
import { isBusinessMember } from "./membership";
import { generateSecret, hashSecret, prefixOf } from "./secret";
import { isScope, SCOPES, scopeNeedsBusiness, type Scope } from "./scopes";
import type { ApiKeyView } from "./types";

export const MAX_ACTIVE_KEYS = 25;
export const cacheKey = (hash: string) => `apikey:${hash}`;

type Row = {
  id: string; name: string; prefix: string; scopes: string[]; businessId: string | null; expiresAt: Date | null;
  lastUsedAt: Date | null; lastUsedIp: string | null; revokedAt: Date | null; createdAt: Date;
};

export function statusOf(row: { revokedAt: Date | null; expiresAt: Date | null }, now = new Date()): ApiKeyView["status"] {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

export function toView(r: Row, now = new Date()): ApiKeyView {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopes.filter(isScope),
    businessId: r.businessId,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: r.lastUsedIp,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    status: statusOf(r, now),
  };
}

const createSchema = z.object({
  name: z.string().trim().min(1, "Give the key a name").max(60, "Name is too long (60 characters max)"),
  scopes: z
    .array(z.enum(SCOPES))
    .min(1, "Pick at least one permission")
    .transform((s) => [...new Set(s)]),
  expiry: z.enum(EXPIRY_OPTIONS),
  businessId: z.uuid().nullish(),
});

/** Creates a key; the full secret is returned ONCE and never stored (sha256 only). Max 25 active keys/person. */
export async function createApiKey(
  personId: string,
  input: { name: string; scopes: Scope[]; expiry: ExpiryOption; businessId?: string | null },
): Promise<{ key: ApiKeyView; secret: string }> {
  const data = createSchema.parse(input);
  const businessId = data.businessId ?? null;

  if (!(await rateLimit(`apikey:create:${personId}`, 10, 3600))) {
    throw new DomainError("rate_limited", "You're creating keys too quickly. Try again in an hour.", undefined, "developer.youreCreatingKeysTooQuickly");
  }
  if (businessId) {
    if (!(await isBusinessMember(personId, businessId))) throw new DomainError("forbidden", "You're not a member of that business.", undefined, "developer.youreNotMemberBusiness");
  } else if (data.scopes.some(scopeNeedsBusiness)) {
    throw new DomainError("validation", "Choose a business for the permissions you selected.", { field: "businessId" }, "developer.chooseBusinessPermissionsSelected");
  }

  const now = new Date();
  const active = await prisma.apiKey.count({
    where: { personId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
  });
  if (active >= MAX_ACTIVE_KEYS) {
    throw new DomainError("conflict", `You can have up to ${MAX_ACTIVE_KEYS} active keys. Revoke one to create another.`, undefined, "developer.upActiveKeysRevokeOne", { maxActiveKeys: MAX_ACTIVE_KEYS });
  }

  // The 4 random chars in the display prefix are unique-indexed; regenerate on the rare collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const secret = generateSecret();
    try {
      const row = await prisma.apiKey.create({
        data: {
          personId, businessId, name: data.name, prefix: prefixOf(secret), secretHash: hashSecret(secret),
          scopes: data.scopes, expiresAt: expiryToDate(data.expiry, now),
        },
      });
      return { key: toView(row, now), secret };
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") continue;
      throw err;
    }
  }
  throw new Error("could not allocate a unique API key prefix");
}

export async function listApiKeys(personId: string): Promise<ApiKeyView[]> {
  const now = new Date();
  const rows = await prisma.apiKey.findMany({ where: { personId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return rows.map((r) => toView(r, now));
}

async function revoke(where: { id: string; personId?: string }, revokedBy: string | null): Promise<void> {
  const row = await prisma.apiKey.findFirst({ where, select: { id: true, secretHash: true, revokedAt: true } });
  if (!row) throw new DomainError("not_found", "API key not found.", undefined, "developer.apiKeyNotFound");
  if (!row.revokedAt) {
    await prisma.apiKey.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date(), revokedBy } });
  }
  await redis.del(cacheKey(row.secretHash));
}

export async function revokeApiKey(personId: string, keyId: string): Promise<void> {
  if (!z.uuid().safeParse(keyId).success) throw new DomainError("not_found", "API key not found.", undefined, "developer.apiKeyNotFound");
  await revoke({ id: keyId, personId }, null);
}

/** Staff revoke (admin app wraps in audited()). */
export async function revokeApiKeyAsStaff(keyId: string, staffId: string): Promise<void> {
  if (!z.uuid().safeParse(keyId).success) throw new DomainError("not_found", "API key not found.", undefined, "developer.apiKeyNotFound");
  await revoke({ id: keyId }, staffId);
}

/** Revoke every active key of a person (data erasure). Returns how many were revoked. */
export async function revokeAllApiKeysForPerson(personId: string): Promise<number> {
  const rows = await prisma.apiKey.findMany({ where: { personId, revokedAt: null }, select: { id: true, secretHash: true } });
  if (rows.length === 0) return 0;
  await prisma.apiKey.updateMany({ where: { id: { in: rows.map((r) => r.id) }, revokedAt: null }, data: { revokedAt: new Date() } });
  await redis.del(...rows.map((r) => cacheKey(r.secretHash)));
  return rows.length;
}

import { DomainError, rateLimit, redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { cacheKey } from "./keys";
import { hashSecret, isWellFormedSecret, safeEqualHex } from "./secret";
import { isScope } from "./scopes";
import { bumpUsage } from "./usage";
import type { ApiPrincipal } from "./types";

const POSITIVE_TTL = 60;
const NEGATIVE_TTL = 30;
const LIMITS = { rest: 600, mcp: 120 } as const;

interface CachedKey {
  keyId: string;
  personId: string;
  businessId: string | null;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
}

/**
 * Verify a bearer secret: hash lookup (Redis-cached ~60s, revocation busts cache), rejects
 * expired/revoked, per-key rate limit (throws DomainError "rate_limited"), records usage.
 * Returns null when invalid.
 */
export async function verifyApiKey(secret: string, ctx: { ip: string | null; kind: "rest" | "mcp" }): Promise<ApiPrincipal | null> {
  if (!isWellFormedSecret(secret)) return null;
  const hash = hashSecret(secret);
  const ck = cacheKey(hash);

  let entry: CachedKey | null;
  const hit = await redis.get(ck);
  if (hit !== null) {
    entry = JSON.parse(hit) as CachedKey | null;
  } else {
    const row = await prisma.apiKey.findUnique({ where: { secretHash: hash } });
    // constant-time confirmation of the indexed lookup
    entry = row && safeEqualHex(row.secretHash, hash)
      ? {
          keyId: row.id, personId: row.personId, businessId: row.businessId, scopes: row.scopes,
          expiresAt: row.expiresAt?.toISOString() ?? null, revokedAt: row.revokedAt?.toISOString() ?? null,
        }
      : null;
    let ttl = entry ? POSITIVE_TTL : NEGATIVE_TTL;
    if (entry?.expiresAt) ttl = Math.max(1, Math.min(ttl, Math.floor((Date.parse(entry.expiresAt) - Date.now()) / 1000)));
    await redis.set(ck, JSON.stringify(entry), "EX", ttl);
  }

  if (!entry || entry.revokedAt) return null;
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) return null;

  const limit = Number(process.env[ctx.kind === "mcp" ? "API_KEY_RATE_MCP" : "API_KEY_RATE_REST"]) || LIMITS[ctx.kind];
  if (!(await rateLimit(`apikey:${ctx.kind}:${entry.keyId}`, limit, 60))) {
    throw new DomainError("rate_limited", "API key rate limit exceeded. Slow down and retry shortly.");
  }

  await bumpUsage(entry.keyId, ctx.kind, ctx.ip).catch((e) => console.error("[developer] usage counter failed", e));
  return { keyId: entry.keyId, personId: entry.personId, businessId: entry.businessId, scopes: entry.scopes.filter(isScope) };
}

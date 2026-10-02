import { cachedManyTagged, cachedTagged, cacheTags, DomainError, emit, invalidateTags } from "@cnote/core";
import { createHash } from "node:crypto";
import { prisma } from "@cnote/db";
import { z } from "zod";
import { GST_STATES } from "./gstin";
import type { CreateBusinessInput, TrustProfile } from "./types";

const createSchema = z.object({
  name: z.string().trim().min(2, "Enter your business name.").max(120),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  pincode: z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit pincode.").optional().or(z.literal("").transform(() => undefined)),
  isSeller: z.boolean(),
  languages: z.array(z.string().min(2).max(8)).max(12).optional(),
});

/** Creates a Business owned by the person; emits BusinessCreated (billing grants free-plan credits). */
export async function createBusiness(personId: string, input: CreateBusinessInput): Promise<{ businessId: string }> {
  const d = createSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const person = await tx.person.findUnique({ where: { id: personId }, select: { id: true, erasedAt: true } });
    if (!person || person.erasedAt) throw new DomainError("not_found", "Account not found.", undefined, "account.accountNotFound");
    const b = await tx.business.create({
      data: {
        name: d.name,
        city: d.city || null,
        state: d.state || null,
        pincode: d.pincode || null,
        isSeller: d.isSeller,
        isBuyer: true,
        languages: d.languages?.length ? d.languages : ["en"],
        members: { create: { personId, role: "owner" } },
      },
      select: { id: true },
    });
    await emit(tx, "BusinessCreated", { type: "Business", id: b.id }, { businessId: b.id, personId, isSeller: d.isSeller });
    return { businessId: b.id };
  }).then(async (r) => {
    await bustSellerCaches(r.businessId);
    return r;
  });
}

/**
 * A buyer-side system business for an external network (e.g. key "ondc" for ONDC network buyers, ADR-017). Network orders
 * are booked to it so Order.buyerBusinessId stays non-null and every order event keeps its shape. Deterministic id from the
 * key; no members, so nobody can sign in as it; never a seller. Idempotent.
 */
export async function ensureSystemBuyerBusiness(key: string, name: string): Promise<string> {
  if (!/^[a-z0-9_-]{2,40}$/.test(key)) throw new DomainError("validation", "Invalid system business key.");
  const h = createHash("sha256").update(`cnote:system-buyer:${key}`).digest("hex");
  // RFC 4122 layout with version nibble 5 and variant 10xx, so it passes uuid validation everywhere.
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
  await prisma.business.upsert({ where: { id }, create: { id, name: name.slice(0, 120), isSeller: false, isBuyer: true }, update: {} });
  return id;
}

export async function updateProfile(personId: string, input: { name?: string; preferredLanguage?: string }): Promise<void> {
  const d = z
    .object({
      name: z.string().trim().min(1, "Enter your name.").max(100).optional(),
      preferredLanguage: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, "Invalid language.").optional(),
    })
    .parse(input);
  await prisma.person.update({ where: { id: personId }, data: d });
}

const toProfile = (b: {
  id: string; name: string; city: string | null; state: string | null; pincode: string | null;
  verificationTier: number; trustScore: number; badgeActive: boolean; languages: string[];
}): TrustProfile => ({
  businessId: b.id,
  name: b.name,
  city: b.city,
  state: b.state,
  pincode: b.pincode,
  verificationTier: b.verificationTier,
  trustScore: b.trustScore,
  badgeActive: b.badgeActive,
  languages: b.languages,
});

/** Drops cached trust profiles + seller lists after a business/trust write. Never throws. */
export async function bustSellerCaches(businessId: string): Promise<void> {
  await invalidateTags([cacheTags.seller(businessId), cacheTags.sellers, cacheTags.sitemap]);
}

/** Cached per business (120s fresh + SWR); TrustScoreChanged/BusinessVerified and profile writes invalidate `seller:<id>`. */
export async function getTrustProfiles(businessIds: string[]): Promise<Map<string, TrustProfile>> {
  if (businessIds.length === 0) return new Map();
  return cachedManyTagged<TrustProfile>(businessIds, {
    prefix: "identity:trust:v1",
    tags: (id) => [cacheTags.seller(id)],
    ttlSeconds: 120,
    staleSeconds: 600,
    load: async (missing) => {
      const rows = await prisma.business.findMany({ where: { id: { in: missing } } });
      return new Map(rows.map((b) => [b.id, toProfile(b)]));
    },
  });
}

/** Verified sellers, trust-ranked, for manufacturer discovery pages. Cached per query for 2 minutes (SWR). */
export async function listSellers(opts: { q?: string; city?: string; limit?: number; offset?: number }): Promise<TrustProfile[]> {
  const q = opts.q?.trim();
  const city = opts.city?.trim();
  const take = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const skip = Math.max(opts.offset ?? 0, 0);
  return cachedTagged(
    `identity:sellers:v1:${JSON.stringify([q?.toLowerCase() ?? "", city?.toLowerCase() ?? "", take, skip])}`,
    (v: TrustProfile[]) => [cacheTags.sellers, ...v.map((p) => cacheTags.seller(p.businessId))],
    120,
    async () => {
      const rows = await prisma.business.findMany({
        where: {
          isSeller: true,
          ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
          ...(city ? { city: { equals: city, mode: "insensitive" } } : {}),
        },
        orderBy: [{ badgeActive: "desc" }, { trustScore: "desc" }, { createdAt: "asc" }],
        take,
        skip,
      });
      return rows.map(toProfile);
    },
    { staleSeconds: 600 },
  );
}

/** Lightweight seller index for sitemaps (id + created date), stable order, cached 10 min. */
export async function listSellerIndex(opts: { offset: number; limit: number }): Promise<{ businessId: string; createdAt: string }[]> {
  const offset = Math.max(0, Math.trunc(opts.offset));
  const limit = Math.max(1, Math.min(10_000, Math.trunc(opts.limit)));
  return cachedTagged(
    `identity:seller-index:v1:${offset}:${limit}`,
    [cacheTags.sitemap, cacheTags.sellers],
    600,
    async () => {
      const rows = await prisma.business.findMany({ where: { isSeller: true }, select: { id: true, createdAt: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: limit, skip: offset });
      return rows.map((r) => ({ businessId: r.id, createdAt: r.createdAt.toISOString() }));
    },
    { staleSeconds: 3600 },
  );
}

export interface BuyerBusinessProfile {
  businessId: string;
  name: string;
  gstin: string | null;
  legalName: string | null;
  gstState: string | null;
  gstStatus: string | null;
  gstVerifiedAt: string | null;
  verificationTier: number;
}

/** Business-profile view for the buyer account: GSTIN plus what the last GST verification returned (legal name, state). */
export async function getBuyerBusinessProfile(businessId: string): Promise<BuyerBusinessProfile | null> {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { id: true, name: true, gstin: true, legalName: true, gstStatus: true, gstVerifiedAt: true, verificationTier: true } });
  if (!b) return null;
  return {
    businessId: b.id,
    name: b.name,
    gstin: b.gstin,
    legalName: b.legalName,
    gstState: b.gstin ? (GST_STATES[b.gstin.slice(0, 2)] ?? null) : null,
    gstStatus: b.gstStatus,
    gstVerifiedAt: b.gstVerifiedAt?.toISOString() ?? null,
    verificationTier: b.verificationTier,
  };
}

export async function listVerificationRecords(businessId: string) {
  const rows = await prisma.verificationRecord.findMany({ where: { businessId }, orderBy: { createdAt: "desc" } });
  return rows.map((r) => ({ id: r.id, tier: r.tier, kind: r.kind, status: r.status, provider: r.provider, createdAt: r.createdAt.toISOString() }));
}

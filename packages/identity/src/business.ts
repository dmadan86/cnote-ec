import { cachedManyTagged, cachedTagged, cacheTags, DomainError, emit, invalidateTags } from "@cnote/core";
import { createHash } from "node:crypto";
import { prisma } from "@cnote/db";
import { z } from "zod";
import { getGstnProvider, isValidGstin, isValidUdyam, normaliseGstin } from "./gstin";
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

/** T1: GSTIN checksum + GSTN provider lookup (mock in dev), Udyam optional. Emits BusinessVerified. */
export async function verifyGstin(businessId: string, gstinInput: string, udyamInput?: string): Promise<{ passed: boolean; tier: number; reason?: string }> {
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { id: true, verificationTier: true } });
  if (!business) throw new DomainError("not_found", "Business not found.", undefined, "account.businessNotFound");
  const gstin = normaliseGstin(gstinInput);
  const udyam = udyamInput?.trim() ? udyamInput.trim().toUpperCase() : undefined;
  const provider = getGstnProvider();

  const fail = async (reason: string, details: object = {}) => {
    await prisma.verificationRecord.create({
      data: { businessId, tier: 1, kind: "gstin", status: "failed", provider: provider.name, details: { gstin, reason, ...details } },
    });
    return { passed: false, tier: business.verificationTier, reason };
  };

  if (!isValidGstin(gstin)) return fail("Invalid GSTIN. Check the 15 characters and try again.");
  if (udyam && !isValidUdyam(udyam)) return fail("Invalid Udyam number. Expected format UDYAM-XX-00-0000000.");
  const record = await provider.lookup(gstin);
  if (!record) return fail("GSTIN not found in the GST registry.");
  if (record.status !== "Active") return fail(`GSTIN is ${record.status.toLowerCase()}.`, { status: record.status });

  const tier = Math.max(business.verificationTier, 1);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.business.update({ where: { id: businessId }, data: { gstin, ...(udyam ? { udyam } : {}), verificationTier: tier } });
      await tx.verificationRecord.create({
        data: { businessId, tier: 1, kind: "gstin", status: "passed", provider: provider.name, details: { gstin, legalName: record.legalName, state: record.state, status: record.status } },
      });
      if (udyam) {
        await tx.verificationRecord.create({ data: { businessId, tier: 1, kind: "udyam", status: "passed", provider: "format-check", details: { udyam } } });
      }
      await emit(tx, "BusinessVerified", { type: "Business", id: businessId }, { businessId, tier, kind: "gstin" });
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return fail("This GSTIN is already registered to another business.");
    throw err;
  }
  await bustSellerCaches(businessId);
  return { passed: true, tier };
}

export async function listVerificationRecords(businessId: string) {
  const rows = await prisma.verificationRecord.findMany({ where: { businessId }, orderBy: { createdAt: "desc" } });
  return rows.map((r) => ({ id: r.id, tier: r.tier, kind: r.kind, status: r.status, provider: r.provider, createdAt: r.createdAt.toISOString() }));
}

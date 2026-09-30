import { auditWorkerJobs } from "./audits";
import { emit, redis, type EventHandlers, type ModuleWorker } from "@cnote/core";
import { prisma } from "@cnote/db";
import { bustSellerCaches } from "./business";
import { gstWorkerJobs } from "./gst/continuous";
import { computeTrustScore, emptySignals, RESPONSE_SLA_MS, type TrustSignals } from "./trust";

const counterKey = (businessId: string) => `trust:${businessId}`;
const DAY = 24 * 60 * 60 * 1000;

function signalsFrom(tier: number, h: Record<string, string>, createdAt: Date, now: number): TrustSignals {
  const n = (k: string) => Number(h[k] ?? 0) || 0;
  const last = Number(h.lastActivityAt) || createdAt.getTime();
  return {
    ...emptySignals(tier),
    acceptedFast: n("acceptedFast"),
    acceptedSlow: n("acceptedSlow"),
    declined: n("declined"),
    expired: n("expired"),
    moderationRejections: n("modRejected"),
    dealsWon: n("dealsWon"),
    disputesLost: n("disputesLost"),
    offersBroken: n("offersBroken"),
    inactiveDays: Math.max(0, Math.floor((now - last) / DAY)),
  };
}

/** Recomputes from Redis counters + DB tier; persists and emits TrustScoreChanged only on change. */
export async function recomputeTrust(businessId: string, now = Date.now()): Promise<{ changed: boolean; score: number } | null> {
  const b = await prisma.business.findUnique({ where: { id: businessId } });
  if (!b) return null;
  const h = await redis.hgetall(counterKey(businessId));
  const { score, badgeActive } = computeTrustScore(signalsFrom(b.verificationTier, h, b.createdAt, now));
  if (score === b.trustScore && badgeActive === b.badgeActive) return { changed: false, score };
  // updateMany, not update: the business may be erased between the read and the write (DPDP erasure, cleanup).
  const updated = await prisma.$transaction(async (tx) => {
    const r = await tx.business.updateMany({ where: { id: businessId }, data: { trustScore: score, badgeActive } });
    if (r.count === 0) return false;
    await emit(tx, "TrustScoreChanged", { type: "Business", id: businessId }, { businessId, from: b.trustScore, to: score, badgeActive });
    return true;
  });
  if (!updated) return null;
  await bustSellerCaches(businessId);
  return { changed: true, score };
}

/**
 * At-least-once delivery: dedupe by event id so counters are incremented once. The marker is released only if the
 * counters were NOT applied (otherwise a retry would double count); a redelivery of an already-counted event still
 * recomputes, so a transient recompute failure heals on retry.
 */
async function once(eventId: number, businessId: string, bump: (pipe: ReturnType<typeof redis.pipeline>) => void) {
  const dedupe = `trust:ev:${eventId}`;
  if ((await redis.set(dedupe, "1", "EX", 7 * 86400, "NX")) === null) {
    await recomputeTrust(businessId);
    return;
  }
  try {
    const pipe = redis.pipeline();
    bump(pipe);
    pipe.hset(counterKey(businessId), "lastActivityAt", Date.now());
    await pipe.exec();
  } catch (err) {
    await redis.del(dedupe);
    throw err;
  }
  await recomputeTrust(businessId);
}

export const trustHandlers: EventHandlers = {
  async LeadAccepted(e) {
    const field = e.payload.responseMs <= RESPONSE_SLA_MS ? "acceptedFast" : "acceptedSlow";
    await once(e.id, e.payload.sellerBusinessId, (p) => p.hincrby(counterKey(e.payload.sellerBusinessId), field, 1));
  },
  async LeadDeclined(e) {
    await once(e.id, e.payload.sellerBusinessId, (p) => p.hincrby(counterKey(e.payload.sellerBusinessId), "declined", 1));
  },
  async LeadExpired(e) {
    await once(e.id, e.payload.sellerBusinessId, (p) => p.hincrby(counterKey(e.payload.sellerBusinessId), "expired", 1));
  },
  async ListingModerated(e) {
    if (e.payload.status !== "rejected") return;
    await once(e.id, e.payload.sellerBusinessId, (p) => p.hincrby(counterKey(e.payload.sellerBusinessId), "modRejected", 1));
  },
  async OfferHonourDecided(e) {
    if (!e.payload.upheld) return;
    await once(e.id, e.payload.sellerBusinessId, (p) => p.hincrby(counterKey(e.payload.sellerBusinessId), "offersBroken", 1));
  },
  // ADR-013: a dispute decided against a business counts as a lost dispute (withdrawn/no-fault outcomes carry null).
  async DisputeResolved(e) {
    const fault = e.payload.faultBusinessId;
    if (!fault) return;
    await once(e.id, fault, (p) => p.hincrby(counterKey(fault), "disputesLost", 1));
  },
  async BusinessVerified(e) {
    const dedupe = `trust:ev:${e.id}`;
    if ((await redis.set(dedupe, "1", "EX", 7 * 86400, "NX")) === null) return;
    await recomputeTrust(e.payload.businessId); // idempotent by nature; the marker only saves work
  },
};

/** Daily inactivity decay over all sellers (paged by id). */
export async function runTrustDecay(opts: { pageSize?: number } = {}): Promise<number> {
  let cursor: string | undefined;
  let changed = 0;
  for (;;) {
    // Keyset (id > last), not Prisma's row cursor: if the cursor row is deleted mid-run (erasure, cleanup) a row
    // cursor yields an empty page and the run would silently stop early.
    const page = await prisma.business.findMany({
      where: { isSeller: true, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true },
      orderBy: { id: "asc" },
      take: opts.pageSize ?? 200,
    });
    if (page.length === 0) break;
    for (const { id } of page) if ((await recomputeTrust(id))?.changed) changed++;
    cursor = page[page.length - 1]!.id;
  }
  return changed;
}

export const worker: ModuleWorker = {
  name: "identity",
  handlers: trustHandlers,
  jobs: [{ name: "identity.trust-decay", everyMs: DAY, run: async () => void (await runTrustDecay()) }, ...gstWorkerJobs, ...auditWorkerJobs],
};

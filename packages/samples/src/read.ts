// Reads: lists for the buyer and the seller inbox, one request, seller stats (the trust read model), private photo access.
import { prisma } from "@cnote/db";
import { getTrustProfiles } from "@cnote/identity";
import { sampleConfig } from "./config";
import { UUID, roleOf, status, summariesOf, viewOf } from "./internal";
import { photoStore } from "./ports";
import { OPEN_STATUSES, approvalRate, type SampleStatus } from "./state";
import type { Actor, SampleSummary, SampleView, SellerSampleStats } from "./types";

export async function getSample(actor: Actor, id: string): Promise<SampleView | null> {
  if (!UUID.test(id)) return null;
  const r = await prisma.sampleRequest.findUnique({ where: { id }, select: { buyerBusinessId: true, sellerBusinessId: true } });
  if (!r || !roleOf(r, actor.businessId)) return null;
  return viewOf(id, actor);
}

export interface SampleListOptions {
  /** "open" = requested/accepted/dispatched/delivered; "done" = every final status; or one exact status */
  filter?: "open" | "done" | SampleStatus;
  limit?: number;
}

function where(filter: SampleListOptions["filter"]) {
  if (!filter) return {};
  if (filter === "open") return { status: { in: OPEN_STATUSES } };
  if (filter === "done") return { status: { notIn: OPEN_STATUSES } };
  return { status: filter };
}

async function list(actor: Actor, role: "buyer" | "seller", opts: SampleListOptions): Promise<SampleSummary[]> {
  const rows = await prisma.sampleRequest.findMany({
    where: { ...(role === "buyer" ? { buyerBusinessId: actor.businessId } : { sellerBusinessId: actor.businessId }), ...where(opts.filter) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.max(1, Math.min(opts.limit ?? 50, 200)),
  });
  const names = await getTrustProfiles([...new Set(rows.map((r) => (role === "buyer" ? r.sellerBusinessId : r.buyerBusinessId)))]);
  return summariesOf(rows, role, names);
}

export const listBuyerSamples = (actor: Actor, opts: SampleListOptions = {}) => list(actor, "buyer", opts);
export const listSellerSamples = (actor: Actor, opts: SampleListOptions = {}) => list(actor, "seller", opts);

/** Requests waiting for the seller to answer (nav badge). */
export async function countSellerPending(sellerBusinessId: string): Promise<number> {
  return prisma.sampleRequest.count({ where: { sellerBusinessId, status: "requested", respondBy: { gt: new Date() } } });
}

/** Samples that need the buyer: delivered and waiting for a verdict, or dispatched and waiting for "received". */
export async function countBuyerActionable(buyerBusinessId: string): Promise<number> {
  return prisma.sampleRequest.count({ where: { buyerBusinessId, status: { in: ["dispatched", "delivered"] } } });
}

/**
 * Per-seller sample track record, from the request table. Approval rate is withheld (null) until `minEvaluatedForRate` samples were
 * evaluated, so a single early verdict cannot brand a seller. The supplier TRUST SCORE is fed separately, by SampleEvaluated /
 * SampleExpired events (identity's trust worker); nothing here is read by ranking.
 */
export async function getSellerSampleStats(sellerBusinessIds: string[]): Promise<Map<string, SellerSampleStats>> {
  const ids = [...new Set(sellerBusinessIds.filter((i) => UUID.test(i)))];
  const out = new Map<string, SellerSampleStats>();
  if (ids.length === 0) return out;
  const groups = await prisma.sampleRequest.groupBy({ by: ["sellerBusinessId", "status"], where: { sellerBusinessId: { in: ids } }, _count: { _all: true } });
  const min = sampleConfig().minEvaluatedForRate;
  for (const id of ids) {
    const n = (s: SampleStatus) => groups.find((g) => g.sellerBusinessId === id && g.status === s)?._count._all ?? 0;
    const approved = n("approved");
    const evaluated = approved + n("rejected");
    out.set(id, {
      sellerBusinessId: id, evaluated, approved, approvalRate: approvalRate(approved, evaluated, min), expired: n("expired"),
      responded: n("accepted") + n("declined") + n("dispatched") + n("delivered") + evaluated,
    });
  }
  return out;
}

/** Streams an evaluation photo to a party of the request only (never public, never cacheable). */
export async function readSamplePhoto(actor: Actor, sampleId: string, photoId: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!UUID.test(sampleId) || !UUID.test(photoId)) return null;
  const s = await prisma.sampleRequest.findUnique({ where: { id: sampleId }, select: { buyerBusinessId: true, sellerBusinessId: true } });
  if (!s || !roleOf(s, actor.businessId)) return null;
  const m = await prisma.sampleMedia.findFirst({ where: { id: photoId, sampleId } });
  if (!m || m.purgedAt) return null;
  return photoStore().get(m.key);
}

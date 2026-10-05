// Shared internals: guards, row locking, status log, view mapping.
import { DomainError } from "@cnote/core";
import { prisma, type SampleMedia, type SampleRequest, type SampleStatusLog, type Tx } from "@cnote/db";
import { getTrustProfiles } from "@cnote/identity";
import { samplesEnabled } from "./config";
import type { Actor, SampleRole, SampleStatus, SampleView, SampleSummary, TimelineEntry, ShipTo, DeclineReason, RejectReason } from "./types";

export const UUID = /^[0-9a-f-]{36}$/i;

export function requireEnabled(): void {
  if (!samplesEnabled()) throw new DomainError("forbidden", "Sample requests are not available yet.", undefined, "samples.notEnabled");
}

export const status = (r: Pick<SampleRequest, "status">) => r.status as SampleStatus;

export function roleOf(r: Pick<SampleRequest, "buyerBusinessId" | "sellerBusinessId">, businessId: string): SampleRole | null {
  if (r.buyerBusinessId === businessId) return "buyer";
  if (r.sellerBusinessId === businessId) return "seller";
  return null;
}

/** Row lock on the request (own table) so concurrent actions serialise. */
export async function lockSample(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM sample_requests WHERE id = ${id}::uuid FOR UPDATE`;
}

/** Loads a request the actor is party to; anyone else gets not_found (indistinguishable from missing). */
export async function loadForParty(actor: Actor, id: string, tx: Pick<Tx, "sampleRequest"> = prisma): Promise<{ r: SampleRequest; role: SampleRole }> {
  if (!UUID.test(id)) throw new DomainError("not_found", "Sample request not found");
  const r = await tx.sampleRequest.findUnique({ where: { id } });
  const role = r ? roleOf(r, actor.businessId) : null;
  if (!r || !role) throw new DomainError("not_found", "Sample request not found");
  return { r, role };
}

export async function logStatus(tx: Pick<Tx, "sampleStatusLog">, sampleId: string, to: SampleStatus, actor: "buyer" | "seller" | "system", note?: string | null): Promise<void> {
  await tx.sampleStatusLog.create({ data: { sampleId, status: to, actor, note: note ?? null } });
}

export const isUniqueViolation = (err: unknown): boolean => typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";

export const paise = (v: bigint | null | undefined): number => (v == null ? 0 : Number(v));

const MASKED_BEFORE_ACCEPT: SampleStatus[] = ["requested", "declined", "expired", "cancelled"];

function shipOf(r: SampleRequest, role: SampleRole): ShipTo | null {
  if (!r.shipLine1 || !r.shipName || !r.shipCity || !r.shipPincode || r.personalDataPurgedAt) return null;
  // ADR-002 spirit: the buyer's address reaches the seller only once the seller agreed to send the sample.
  if (role === "seller" && MASKED_BEFORE_ACCEPT.includes(status(r))) return null;
  return { name: r.shipName, phone: r.shipPhone, line1: r.shipLine1, line2: r.shipLine2, city: r.shipCity, pincode: r.shipPincode };
}

type Row = SampleRequest & { media: SampleMedia[]; log: SampleStatusLog[] };

export function canDo(r: SampleRequest, role: SampleRole, now = Date.now()): SampleView["can"] {
  const st = status(r);
  const overdue = st === "requested" && r.respondBy.getTime() <= now;
  return {
    cancel: role === "buyer" && (st === "requested" || st === "accepted"),
    respond: role === "seller" && st === "requested" && !overdue,
    dispatch: role === "seller" && st === "accepted",
    markDelivered: st === "dispatched",
    recordPayment: role === "seller" && (st === "accepted" || st === "dispatched" || st === "delivered" || st === "approved" || st === "rejected") && r.amountPaise > 0n && !r.paymentReceivedAt,
    evaluate: role === "buyer" && st === "delivered",
    requestBulk: role === "buyer" && st === "approved" && !r.bulkEnquiryId,
    acceptLinkedQuote: role === "buyer" && st === "approved" && !!r.quoteId && !r.bulkRequestedAt,
  };
}

export async function toViews(rows: Row[], role: SampleRole, now = Date.now()): Promise<SampleView[]> {
  const ids = [...new Set(rows.flatMap((r) => [r.buyerBusinessId, r.sellerBusinessId]))];
  const profiles = ids.length ? await getTrustProfiles(ids) : new Map();
  return rows.map((r) => {
    const st = status(r);
    const evaluated = st === "approved" || st === "rejected";
    const buyerProfile = profiles.get(r.buyerBusinessId);
    return {
      id: r.id, role, status: st, subject: r.subject, listingId: r.listingId, enquiryId: r.enquiryId, matchId: r.matchId, quoteId: r.quoteId,
      quantity: r.quantity, unit: r.unit, buyerNote: r.personalDataPurgedAt ? null : r.buyerNote,
      buyer: { businessId: r.buyerBusinessId, name: buyerProfile?.name ?? "Buyer", verificationTier: r.buyerTier },
      seller: { businessId: r.sellerBusinessId, name: profiles.get(r.sellerBusinessId)?.name ?? "Seller" },
      shipTo: shipOf(r, role),
      payment: { amountPaise: paise(r.amountPaise), adjustableAgainstBulk: r.adjustableAgainstBulk, note: r.paymentNote, receivedAt: r.paymentReceivedAt?.toISOString() ?? null, free: r.amountPaise === 0n },
      respondBy: r.respondBy.toISOString(),
      overdue: st === "requested" && r.respondBy.getTime() <= now,
      respondedAt: r.respondedAt?.toISOString() ?? null,
      declineReason: (r.declineReason as DeclineReason | null) ?? null,
      declineNote: r.declineNote,
      expectedDispatchBy: r.expectedDispatchBy?.toISOString() ?? null,
      courier: r.courier, trackingRef: r.trackingRef,
      dispatchedAt: r.dispatchedAt?.toISOString() ?? null, deliveredAt: r.deliveredAt?.toISOString() ?? null,
      deliveredBy: (r.deliveredBy as "buyer" | "seller" | null) ?? null,
      evaluation: evaluated && r.evaluatedAt
        ? { approved: st === "approved", reasons: r.evaluationReasons as RejectReason[], notes: r.personalDataPurgedAt ? null : r.evaluationNotes, photos: r.media.filter((m) => !m.purgedAt).map((m) => ({ id: m.id })), at: r.evaluatedAt.toISOString() }
        : null,
      bulkEnquiryId: r.bulkEnquiryId,
      createdAt: r.createdAt.toISOString(),
      timeline: [...r.log].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((l): TimelineEntry => ({ status: l.status as SampleStatus, actor: l.actor as TimelineEntry["actor"], note: l.note, at: l.createdAt.toISOString() })),
      can: canDo(r, role, now),
    };
  });
}

export const viewInclude = { media: { orderBy: { createdAt: "asc" as const } }, log: true };

export async function viewOf(id: string, actor: Actor): Promise<SampleView> {
  const { r, role } = await loadForParty(actor, id);
  const full = await prisma.sampleRequest.findUniqueOrThrow({ where: { id: r.id }, include: viewInclude });
  return (await toViews([full], role))[0]!;
}

export function summariesOf(rows: SampleRequest[], role: SampleRole, names: Map<string, { name: string }>, now = Date.now()): SampleSummary[] {
  return rows.map((r) => {
    const st = status(r);
    const counterId = role === "buyer" ? r.sellerBusinessId : r.buyerBusinessId;
    const c = canDo(r, role, now);
    return {
      id: r.id, role, status: st, subject: r.subject, quantity: r.quantity, unit: r.unit,
      counterparty: { businessId: counterId, name: names.get(counterId)?.name ?? (role === "buyer" ? "Seller" : "Buyer") },
      respondBy: r.respondBy.toISOString(), overdue: st === "requested" && r.respondBy.getTime() <= now, createdAt: r.createdAt.toISOString(),
      needsMyAction: c.respond || c.dispatch || c.evaluate || (role === "buyer" && st === "dispatched") || c.requestBulk,
    };
  });
}

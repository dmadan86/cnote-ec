// The sample's journey after the request: seller accepts/declines, dispatches; either side marks delivered; the buyer evaluates.
import { randomUUID } from "node:crypto";
import { DomainError, emit } from "@cnote/core";
import { getPublicListing } from "@cnote/catalogue";
import { prisma } from "@cnote/db";
import { sniffImageMime, IMAGE_EXT } from "@cnote/media";
import { z } from "zod";
import { DAY_MS } from "./config";
import { loadForParty, lockSample, logStatus, requireEnabled, status, viewOf } from "./internal";
import { photoKey, photoStore } from "./ports";
import { DECLINE_REASONS, MAX_EVALUATION_PHOTOS, MAX_PHOTO_BYTES, REJECT_REASONS, assertTransition } from "./state";
import type { AcceptSampleInput, Actor, DeclineSampleInput, DispatchSampleInput, EvaluateSampleInput, SampleView } from "./types";

const seller = async (actor: Actor, id: string) => {
  const { r, role } = await loadForParty(actor, id);
  if (role !== "seller") throw new DomainError("forbidden", "Only the supplier can do this.");
  return r;
};

const acceptSchema = z.object({
  amountPaise: z.number().int().min(0).max(100_000_000).nullish(),
  adjustableAgainstBulk: z.boolean().optional().default(false),
  paymentNote: z.string().trim().max(500).nullish(),
});

/** The seller agrees to send the sample. Payment is recorded only (off-platform in Phase 1). */
export async function acceptSample(actor: Actor, id: string, raw: AcceptSampleInput = {}): Promise<SampleView> {
  requireEnabled();
  const p = acceptSchema.safeParse(raw);
  if (!p.success) throw new DomainError("validation", p.error.issues[0]?.message ?? "Invalid input");
  const pre = await seller(actor, id);
  // Dispatch promise from the live listing, when the request came from one. A lookup failure never blocks the answer.
  const dispatchDays = pre.listingId ? (await getPublicListing(pre.listingId).catch(() => null))?.trade?.sampleDispatchDays ?? null : null;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await lockSample(tx, id);
    const r = await tx.sampleRequest.findUniqueOrThrow({ where: { id } });
    assertTransition(status(r), "accepted");
    if (r.respondBy.getTime() <= now.getTime()) throw new DomainError("conflict", "This request is past its response deadline and has expired.", undefined, "samples.expired");
    const amount = p.data.amountPaise ?? Number(r.amountPaise);
    const expectedDispatchBy = dispatchDays === null ? null : new Date(now.getTime() + dispatchDays * DAY_MS);
    await tx.sampleRequest.update({
      where: { id },
      data: {
        status: "accepted", respondedAt: now, respondedByPersonId: actor.personId, amountPaise: BigInt(amount), adjustableAgainstBulk: p.data.adjustableAgainstBulk,
        paymentNote: p.data.paymentNote || null, expectedDispatchBy,
      },
    });
    await logStatus(tx, id, "accepted", "seller");
    await emit(tx, "SampleAccepted", { type: "sample", id }, {
      sampleId: id, buyerBusinessId: r.buyerBusinessId, sellerBusinessId: r.sellerBusinessId, amountPaise: amount, adjustableAgainstBulk: p.data.adjustableAgainstBulk,
      expectedDispatchBy: expectedDispatchBy?.toISOString() ?? null, responseMs: now.getTime() - r.createdAt.getTime(),
    });
  });
  return viewOf(id, actor);
}

const declineSchema = z.object({ reason: z.enum(DECLINE_REASONS), note: z.string().trim().max(500).nullish() });

export async function declineSample(actor: Actor, id: string, raw: DeclineSampleInput): Promise<SampleView> {
  requireEnabled();
  const p = declineSchema.safeParse(raw);
  if (!p.success) throw new DomainError("validation", "Choose a reason for declining.");
  await seller(actor, id);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await lockSample(tx, id);
    const r = await tx.sampleRequest.findUniqueOrThrow({ where: { id } });
    assertTransition(status(r), "declined");
    await tx.sampleRequest.update({
      where: { id },
      data: { status: "declined", respondedAt: now, respondedByPersonId: actor.personId, declineReason: p.data.reason, declineNote: p.data.note || null, activeKey: null },
    });
    await logStatus(tx, id, "declined", "seller", p.data.reason);
    await emit(tx, "SampleDeclined", { type: "sample", id }, {
      sampleId: id, buyerBusinessId: r.buyerBusinessId, sellerBusinessId: r.sellerBusinessId, reason: p.data.reason, responseMs: now.getTime() - r.createdAt.getTime(),
    });
  });
  return viewOf(id, actor);
}

const dispatchSchema = z.object({ courier: z.string().trim().min(2, "Enter the courier or how it is being sent").max(60), trackingRef: z.string().trim().max(80).nullish() });

export async function dispatchSample(actor: Actor, id: string, raw: DispatchSampleInput): Promise<SampleView> {
  requireEnabled();
  const p = dispatchSchema.safeParse(raw);
  if (!p.success) throw new DomainError("validation", p.error.issues[0]?.message ?? "Invalid input");
  await seller(actor, id);
  await prisma.$transaction(async (tx) => {
    await lockSample(tx, id);
    const r = await tx.sampleRequest.findUniqueOrThrow({ where: { id } });
    assertTransition(status(r), "dispatched");
    await tx.sampleRequest.update({ where: { id }, data: { status: "dispatched", courier: p.data.courier, trackingRef: p.data.trackingRef || null, dispatchedAt: new Date() } });
    await logStatus(tx, id, "dispatched", "seller", p.data.courier);
    await emit(tx, "SampleDispatched", { type: "sample", id }, {
      sampleId: id, buyerBusinessId: r.buyerBusinessId, sellerBusinessId: r.sellerBusinessId, courier: p.data.courier, trackingRef: p.data.trackingRef || null,
    });
  });
  return viewOf(id, actor);
}

/** Either party confirms arrival; the buyer's confirmation is the normal path, the seller's covers couriers that report delivery. */
export async function markSampleDelivered(actor: Actor, id: string): Promise<SampleView> {
  requireEnabled();
  const { role } = await loadForParty(actor, id);
  await prisma.$transaction(async (tx) => {
    await lockSample(tx, id);
    const r = await tx.sampleRequest.findUniqueOrThrow({ where: { id } });
    assertTransition(status(r), "delivered");
    await tx.sampleRequest.update({ where: { id }, data: { status: "delivered", deliveredAt: new Date(), deliveredBy: role } });
    await logStatus(tx, id, "delivered", role);
    await emit(tx, "SampleDelivered", { type: "sample", id }, { sampleId: id, buyerBusinessId: r.buyerBusinessId, sellerBusinessId: r.sellerBusinessId, deliveredBy: role });
  });
  return viewOf(id, actor);
}

/** The seller records that the (off-platform) sample payment arrived. Record only: no money moves on the platform in Phase 1. */
export async function recordSamplePayment(actor: Actor, id: string, note?: string | null): Promise<SampleView> {
  requireEnabled();
  await seller(actor, id);
  await prisma.$transaction(async (tx) => {
    await lockSample(tx, id);
    const r = await tx.sampleRequest.findUniqueOrThrow({ where: { id } });
    if (r.amountPaise === 0n) throw new DomainError("conflict", "This sample is free, so there is no payment to record.");
    if (["requested", "declined", "expired", "cancelled"].includes(r.status)) throw new DomainError("conflict", "Payment can be recorded once the request is accepted.");
    if (r.paymentReceivedAt) return;
    await tx.sampleRequest.update({ where: { id }, data: { paymentReceivedAt: new Date(), ...(note?.trim() ? { paymentNote: note.trim().slice(0, 500) } : {}) } });
  });
  return viewOf(id, actor);
}

const evaluateSchema = z.object({
  approved: z.boolean(),
  reasons: z.array(z.enum(REJECT_REASONS)).max(REJECT_REASONS.length).optional().default([]),
  notes: z.string().trim().max(2000).nullish(),
});

/**
 * The buyer's verdict on a delivered sample. A rejection needs at least one structured reason; photos (0 to 5, JPEG/PNG/WebP) are
 * validated from magic bytes BEFORE anything is stored, then written to the private bucket. An approval makes the sample the
 * "golden sample" the bulk order is judged against.
 */
export async function evaluateSample(actor: Actor, id: string, raw: EvaluateSampleInput): Promise<SampleView> {
  requireEnabled();
  const p = evaluateSchema.safeParse(raw);
  if (!p.success) throw new DomainError("validation", p.error.issues[0]?.message ?? "Invalid input");
  const { r: pre, role } = await loadForParty(actor, id);
  if (role !== "buyer") throw new DomainError("forbidden", "Only the buyer can evaluate a sample.");
  const reasons = [...new Set(p.data.reasons)];
  if (!p.data.approved && reasons.length === 0) throw new DomainError("validation", "Choose at least one reason for rejecting the sample.", undefined, "samples.reasonsRequired");
  const photos = raw.photos ?? [];
  if (photos.length > MAX_EVALUATION_PHOTOS) throw new DomainError("validation", `Attach at most ${MAX_EVALUATION_PHOTOS} photos.`, undefined, "samples.tooManyPhotos", { max: MAX_EVALUATION_PHOTOS });
  const checked = photos.map((ph) => {
    const mime = ph.bytes.length > 0 && ph.bytes.length <= MAX_PHOTO_BYTES ? sniffImageMime(ph.bytes) : null;
    if (!mime) throw new DomainError("validation", "Photos must be JPEG, PNG or WebP, up to 5 MB each.", undefined, "samples.photoType");
    return { id: randomUUID(), bytes: ph.bytes, mime, ext: IMAGE_EXT[mime] };
  });
  // Cheap pre-check so a wrong status never writes files.
  assertTransition(status(pre), p.data.approved ? "approved" : "rejected");

  const stored: string[] = [];
  const cleanup = async () => { await Promise.all(stored.map((k) => photoStore().delete(k).catch(() => undefined))); };
  try {
    for (const c of checked) {
      const key = photoKey(id, c.id, c.ext);
      await photoStore().put(key, c.bytes, c.mime);
      stored.push(key);
    }
    const now = new Date();
    const next = p.data.approved ? "approved" : "rejected";
    await prisma.$transaction(async (tx) => {
      await lockSample(tx, id);
      const r = await tx.sampleRequest.findUniqueOrThrow({ where: { id } });
      assertTransition(status(r), next);
      await tx.sampleRequest.update({
        where: { id },
        data: { status: next, evaluatedAt: now, evaluatedByPersonId: actor.personId, evaluationReasons: p.data.approved ? [] : reasons, evaluationNotes: p.data.notes || null, activeKey: null },
      });
      for (const [i, c] of checked.entries()) {
        await tx.sampleMedia.create({ data: { id: c.id, sampleId: id, key: stored[i]!, mimeType: c.mime, sizeBytes: c.bytes.length, createdByPersonId: actor.personId } });
      }
      await logStatus(tx, id, next, "buyer", p.data.approved ? null : reasons.join(","));
      await emit(tx, "SampleEvaluated", { type: "sample", id }, {
        sampleId: id, buyerBusinessId: r.buyerBusinessId, sellerBusinessId: r.sellerBusinessId, approved: p.data.approved, reasons: p.data.approved ? [] : reasons, photoCount: checked.length,
      });
    });
  } catch (err) {
    await cleanup();
    throw err;
  }
  return viewOf(id, actor);
}

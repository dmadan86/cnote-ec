// Moderation appeals (ADR-010: "content moderation and takedown workflow with appeal").
//
// Ownership + "was actually rejected" are verified through the OWNING modules' public getters only:
//   listing_version    catalogue.getVersionForReview      (status "rejected", seller.businessId)
//   listing_image      catalogue.getImageForModeration    (status "rejected", sellerBusinessId)
//   review / comment   reviews.getModerationItem          (status "rejected", authorPersonId)
//   storefront_version storefront.getStorefrontVersionForReview (status "rejected", sellerBusinessId)
//
// DECISION POLICY. An upheld appeal ("resolved") is applied automatically ONLY where the owning module's staff
// function can safely flip a rejected item back: images (catalogue.moderateListingImage), reviews and comments
// (reviews.moderate). Listing and storefront VERSIONS are immutable review records whose review functions only accept
// items still "in_review", so re-approving a rejected version would need a new "reopen" function in those modules.
// For those two types the appeal is marked resolved with a "[follow-up]" note: the seller resubmits and staff
// fast-track the review. `needsFollowUp` is surfaced in the admin appeals queue.
import { DomainError, emit } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { getImageForModeration, getVersionForReview, moderateListingImage } from "@cnote/catalogue";
import { getModerationItem, moderate } from "@cnote/reviews";
import { getStorefrontVersionForReview } from "@cnote/storefront";
import { z } from "zod";
import { isUuid, parse } from "./util";

export const APPEAL_SUBJECT_TYPES = ["listing_version", "listing_image", "review", "comment", "storefront_version"] as const;
export type AppealSubjectType = (typeof APPEAL_SUBJECT_TYPES)[number];
export type AppealStatus = "open" | "in_progress" | "resolved" | "rejected";

/** Who appeals: the signed-in person and (for seller content) their active business from the session. */
export interface AppealActor {
  personId: string;
  businessId?: string | null;
}

/** What the owning module says about the moderated item; also drives the admin side-by-side view. */
export interface AppealSubject {
  type: AppealSubjectType;
  id: string;
  title: string;
  /** the content that was rejected (text summary) */
  content: string;
  status: string;
  rejected: boolean;
  /** the reason shown to the owner on rejection */
  moderationNote: string | null;
  ownerPersonId: string | null;
  ownerBusinessId: string | null;
}

export interface AppealView {
  id: string;
  personId: string;
  businessId: string | null;
  subjectType: AppealSubjectType;
  subjectId: string;
  reason: string;
  status: AppealStatus;
  decisionNote: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  /** upheld appeal on a versioned subject: staff must fast-track the resubmission (see file header) */
  needsFollowUp: boolean;
}

type Row = Prisma.ModerationAppealGetPayload<object>;
const MANUAL_TYPES: readonly AppealSubjectType[] = ["listing_version", "storefront_version"];

const view = (r: Row): AppealView => ({
  id: r.id,
  personId: r.personId,
  businessId: r.businessId,
  subjectType: r.subjectType as AppealSubjectType,
  subjectId: r.subjectId,
  reason: r.reason,
  status: r.status,
  decisionNote: r.decisionNote,
  decidedBy: r.decidedBy,
  decidedAt: r.decidedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
  needsFollowUp: r.status === "resolved" && MANUAL_TYPES.includes(r.subjectType as AppealSubjectType),
});

/** Loads the moderated item via the owning module. Null when it does not exist. */
export async function describeSubject(type: AppealSubjectType, id: string): Promise<AppealSubject | null> {
  if (!isUuid(id)) return null;
  switch (type) {
    case "listing_version": {
      const v = await getVersionForReview(id);
      if (!v) return null;
      return {
        type, id, title: v.listingTitle, content: JSON.stringify(v.version.snapshot, null, 2), status: v.version.status, rejected: v.version.status === "rejected",
        moderationNote: v.version.reviewNote, ownerPersonId: null, ownerBusinessId: v.seller?.businessId ?? null,
      };
    }
    case "listing_image": {
      const im = await getImageForModeration(id);
      if (!im) return null;
      return {
        type, id, title: im.listingTitle, content: im.altText ? `Image (alt: ${im.altText})` : "Image", status: im.status, rejected: im.status === "rejected",
        moderationNote: im.moderationNote, ownerPersonId: null, ownerBusinessId: im.sellerBusinessId,
      };
    }
    case "review":
    case "comment": {
      const m = await getModerationItem(type, id);
      if (!m) return null;
      return {
        type, id, title: m.title ?? (type === "review" ? "Review" : "Comment"), content: m.body, status: m.status, rejected: m.status === "rejected",
        moderationNote: m.moderationNote, ownerPersonId: m.authorPersonId || null, ownerBusinessId: null,
      };
    }
    case "storefront_version": {
      const s = await getStorefrontVersionForReview(id);
      if (!s) return null;
      return {
        type, id, title: `${s.item.businessName} storefront v${s.item.version}`, content: JSON.stringify(s.document, null, 2), status: s.item.status,
        rejected: s.item.status === "rejected", moderationNote: s.item.reviewNote, ownerPersonId: null, ownerBusinessId: s.item.sellerBusinessId,
      };
    }
  }
}

const fileSchema = z.object({
  subjectType: z.enum(APPEAL_SUBJECT_TYPES, "Unknown decision type"),
  subjectId: z.string(),
  reason: z.string().trim().min(10, "Explain why the decision should change (at least 10 characters)").max(2000),
});

/**
 * File an appeal against a rejection. Forbidden unless the actor owns the subject; conflict unless the subject is
 * rejected. One appeal per (subject, person): an open one blocks a new one, and a decided one is final for that decision.
 */
export async function fileAppeal(actor: AppealActor, input: z.input<typeof fileSchema>): Promise<AppealView> {
  const i = parse(fileSchema, input);
  if (!isUuid(actor.personId)) throw new DomainError("unauthenticated", "Sign in to appeal", undefined, "compliance.signAppeal");
  const subject = await describeSubject(i.subjectType, i.subjectId);
  if (!subject) throw new DomainError("not_found", "That decision could not be found", undefined, "compliance.decisionCouldNotFound");
  const owns = subject.ownerPersonId ? subject.ownerPersonId === actor.personId : !!subject.ownerBusinessId && subject.ownerBusinessId === actor.businessId;
  if (!owns) throw new DomainError("forbidden", "You can only appeal decisions about your own content", undefined, "compliance.onlyAppealDecisionsAboutOwn");
  if (!subject.rejected) throw new DomainError("conflict", "Only rejected content can be appealed", undefined, "compliance.onlyRejectedContentAppealed");
  const existing = await prisma.moderationAppeal.findUnique({
    where: { subjectType_subjectId_personId: { subjectType: i.subjectType, subjectId: i.subjectId, personId: actor.personId } },
  });
  if (existing) throw new DomainError("conflict", existing.status === "open" || existing.status === "in_progress" ? "You already have an open appeal for this decision" : "This decision has already been appealed");
  try {
    const row = await prisma.$transaction(async (tx) => {
      const a = await tx.moderationAppeal.create({
        data: { personId: actor.personId, businessId: subject.ownerBusinessId ?? actor.businessId ?? null, subjectType: i.subjectType, subjectId: i.subjectId, reason: i.reason },
      });
      await emit(tx, "AppealFiled", { type: "ModerationAppeal", id: a.id }, { appealId: a.id, personId: a.personId, subjectType: a.subjectType, subjectId: a.subjectId });
      return a;
    });
    return view(row);
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new DomainError("conflict", "You already have an open appeal for this decision", undefined, "compliance.alreadyOpenAppealDecision");
    throw e;
  }
}

/** The person's own appeals, newest first. */
export async function listMyAppeals(personId: string): Promise<AppealView[]> {
  if (!isUuid(personId)) return [];
  return (await prisma.moderationAppeal.findMany({ where: { personId }, orderBy: { createdAt: "desc" }, take: 100 })).map(view);
}

export async function listAppeals(f: { status?: AppealStatus; limit?: number } = {}): Promise<AppealView[]> {
  const rows = await prisma.moderationAppeal.findMany({ where: { status: f.status }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: Math.min(Math.max(f.limit ?? 50, 1), 200) });
  return rows.map(view);
}

/** Appeal plus the original decision as the owning module reports it now (admin side-by-side view). */
export async function getAppealDetail(id: string): Promise<{ appeal: AppealView; subject: AppealSubject | null } | null> {
  const r = isUuid(id) ? await prisma.moderationAppeal.findUnique({ where: { id } }) : null;
  if (!r) return null;
  return { appeal: view(r), subject: await describeSubject(r.subjectType as AppealSubjectType, r.subjectId) };
}

const decideSchema = z.object({
  decision: z.enum(["resolved", "rejected"]),
  note: z.string().trim().min(5, "Write a note the person will see (at least 5 characters)").max(500),
});

/** Re-approves via the owning module's existing staff function. A conflict ("already approved") counts as success. */
async function reinstate(a: Row, staffId: string): Promise<void> {
  const note = "Reinstated on appeal";
  try {
    if (a.subjectType === "listing_image") await moderateListingImage(a.subjectId, "approved", note, staffId);
    else if (a.subjectType === "review" || a.subjectType === "comment") await moderate(a.subjectType, a.subjectId, "approved", note, staffId);
  } catch (e) {
    if (!(e instanceof DomainError && e.code === "conflict")) throw e;
  }
}

/**
 * Staff decision. "resolved" = appeal upheld: the content is re-approved through the owning module (see file header
 * for versioned subjects). "rejected" = decision stands. Call inside admin.audited(ctx, "compliance.manage", ...).
 */
export async function decideAppeal(id: string, decision: "resolved" | "rejected", note: string, staffId: string, now = new Date()): Promise<AppealView> {
  const i = parse(decideSchema, { decision, note });
  if (!isUuid(staffId)) throw new DomainError("forbidden", "Staff member required");
  const a = isUuid(id) ? await prisma.moderationAppeal.findUnique({ where: { id } }) : null;
  if (!a) throw new DomainError("not_found", "Appeal not found", undefined, "compliance.appealNotFound");
  if (a.status === "resolved" || a.status === "rejected") throw new DomainError("conflict", `Appeal is already ${a.status}`);
  let decisionNote = i.note;
  if (i.decision === "resolved") {
    if (MANUAL_TYPES.includes(a.subjectType as AppealSubjectType)) decisionNote = `${i.note}\n[follow-up] Upheld: the seller should resubmit; staff to fast-track the review.`;
    else await reinstate(a, staffId);
  }
  const row = await prisma.$transaction(async (tx) => {
    const res = await tx.moderationAppeal.updateMany({
      where: { id, status: { in: ["open", "in_progress"] } },
      data: { status: i.decision, decisionNote, decidedBy: staffId, decidedAt: now },
    });
    if (res.count === 0) throw new DomainError("conflict", "Appeal was already decided");
    await emit(tx, "AppealDecided", { type: "ModerationAppeal", id }, { appealId: id, personId: a.personId, subjectType: a.subjectType, subjectId: a.subjectId, status: i.decision });
    return tx.moderationAppeal.findUniqueOrThrow({ where: { id } });
  });
  return view(row);
}

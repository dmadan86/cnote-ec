import { DomainError, rateLimit } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import * as ai from "@cnote/ai";
import { REACTIONS_PER_HOUR } from "./constants";
import { countCredibleReporters, reportPolicy } from "./report-policy";
import { bustQaCaches, bustReviewCaches } from "./cache";
import { syncAnswered } from "./qa-state";
import { recomputeSummary } from "./summary";
import type { Actor } from "./types";
import { reportReason } from "./validate";

export type ReactionKind = "helpful" | "report";
export type ReactionSubject = "review" | "comment" | "question" | "answer";
export interface ReactInput {
  subjectType: ReactionSubject;
  subjectId: string;
  kind: ReactionKind;
  /** required for "report" */
  reason?: string;
  /** client IP (from clientIp()); reports are rate limited per IP as well as per person */
  ip?: string | null;
}

const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
const HELPFUL_SUBJECTS: ReactionSubject[] = ["review", "answer"];

interface Subject {
  authorPersonId: string;
  status: string;
  listingId: string;
}

async function loadSubject(tx: Prisma.TransactionClient, type: ReactionSubject, id: string): Promise<Subject | null> {
  const select = { authorPersonId: true, status: true, listingId: true } as const;
  switch (type) {
    case "review": return tx.productReview.findUnique({ where: { id }, select });
    case "comment": return tx.productComment.findUnique({ where: { id }, select });
    case "question": {
      // only public (answered) questions can be reported; private ones are handled by their asker/seller/staff
      const q = await tx.productQuestion.findUnique({ where: { id }, select: { ...select, answeredAt: true } });
      return q?.answeredAt ? q : null;
    }
    case "answer": {
      // an answer is only reactable while its question is public too
      const a = await tx.productAnswer.findUnique({ where: { id }, select: { ...select, question: { select: { status: true, answeredAt: true } } } });
      return a && a.question.status === "approved" && a.question.answeredAt ? a : null;
    }
  }
}

async function bumpReport(tx: Prisma.TransactionClient, type: ReactionSubject, id: string): Promise<number> {
  const data = { reportCount: { increment: 1 } };
  const select = { reportCount: true } as const;
  switch (type) {
    case "review": return (await tx.productReview.update({ where: { id }, data, select })).reportCount;
    case "comment": return (await tx.productComment.update({ where: { id }, data, select })).reportCount;
    case "question": return (await tx.productQuestion.update({ where: { id }, data, select })).reportCount;
    case "answer": return (await tx.productAnswer.update({ where: { id }, data, select })).reportCount;
  }
}

/** Hides an approved item that crossed the report threshold until staff re-approve it. Returns whether it changed. */
async function flagIfApproved(tx: Prisma.TransactionClient, type: ReactionSubject, id: string, listingId: string): Promise<boolean> {
  const where = { id, status: "approved" as const };
  const data = { status: "flagged" as const };
  switch (type) {
    case "review": {
      const { count } = await tx.productReview.updateMany({ where, data });
      if (count) await recomputeSummary(tx, listingId);
      return count > 0;
    }
    case "comment": return (await tx.productComment.updateMany({ where, data })).count > 0;
    case "question": {
      const { count } = await tx.productQuestion.updateMany({ where, data });
      if (count) await syncAnswered(tx, id);
      return count > 0;
    }
    case "answer": {
      const { count } = await tx.productAnswer.updateMany({ where, data });
      if (count) {
        const a = await tx.productAnswer.findUniqueOrThrow({ where: { id }, select: { questionId: true } });
        await syncAnswered(tx, a.questionId);
      }
      return count > 0;
    }
  }
}

/**
 * "helpful" (reviews and answers, counted while public) and "report" (abuse, any subject). One of each per person per
 * item; repeats are no-ops (`changed: false`). An approved item is auto-hidden ("flagged": hidden until staff re-approve,
 * out of the rating aggregate / public Q&A list) only when the reports come from enough DISTINCT, CREDIBLE accounts
 * (verified and aged, see report-policy.ts). Reports from fresh or unverified accounts past the threshold are queued for
 * staff review without hiding the item, so brigading with throw-away accounts cannot silence a competitor.
 * Reports are rate limited per person and per IP.
 */
export async function react(actor: Actor, input: ReactInput): Promise<{ changed: boolean }> {
  const { subjectType, subjectId, kind } = input;
  if (kind === "helpful" && !HELPFUL_SUBJECTS.includes(subjectType)) throw new DomainError("validation", "Only reviews can be marked helpful.", undefined, "reviews.onlyReviewsMarkedHelpful");
  const reason = kind === "report" ? reportReason.parse(input.reason) : null;
  if (!(await rateLimit(`reviews:react:${actor.personId}`, REACTIONS_PER_HOUR, 3_600))) throw new DomainError("rate_limited", "Too many actions. Please slow down.");

  const policy = reportPolicy();
  if (kind === "report") {
    if (!(await rateLimit(`reviews:report:${actor.personId}:h`, policy.perPersonPerHour, 3_600)) || !(await rateLimit(`reviews:report:${actor.personId}:d`, policy.perPersonPerDay, 86_400)))
      throw new DomainError("rate_limited", "You have reported a lot recently. Please try again later.");
    if (input.ip && !(await rateLimit(`reviews:report:ip:${input.ip}`, policy.perIpPerHour, 3_600))) throw new DomainError("rate_limited", "Too many reports from this network. Please try again later.");
  }

  let touched: string | null = null;
  let contested: { reports: number; credible: number } | null = null;
  try {
    const res = await prisma.$transaction(async (tx) => {
      const subject = await loadSubject(tx, subjectType, subjectId);
      if (!subject || subject.status !== "approved") throw new DomainError("not_found", "Nothing to react to here.", undefined, "reviews.nothingReactHere");
      touched = subject.listingId;
      if (subject.authorPersonId === actor.personId) throw new DomainError("forbidden", kind === "helpful" ? "You can't vote on your own review." : "You can't report your own post.");

      const dup = await tx.ugcReaction.findUnique({ where: { subjectType_subjectId_personId_kind: { subjectType, subjectId, personId: actor.personId, kind } } });
      if (dup) return { changed: false };
      await tx.ugcReaction.create({ data: { subjectType, subjectId, personId: actor.personId, kind, reason } });

      if (kind === "helpful") {
        if (subjectType === "review") await tx.productReview.update({ where: { id: subjectId }, data: { helpfulCount: { increment: 1 } } });
        else await tx.productAnswer.update({ where: { id: subjectId }, data: { helpfulCount: { increment: 1 } } });
        return { changed: true };
      }
      const reports = await bumpReport(tx, subjectType, subjectId);
      if (reports >= policy.threshold) {
        const reporters = await tx.ugcReaction.findMany({ where: { subjectType, subjectId, kind: "report" }, select: { personId: true }, take: 200 });
        const credible = await countCredibleReporters(reporters.map((r) => r.personId), new Date(), policy);
        if (credible >= policy.credibleThreshold) await flagIfApproved(tx, subjectType, subjectId, subject.listingId);
        else if (reports % policy.threshold === 0) contested = { reports, credible }; // queue for staff, item stays visible
      }
      return { changed: true };
    });
    if (res.changed && contested) {
      const c = contested as { reports: number; credible: number };
      // best effort: the staff queue must never fail a report that was already recorded
      await ai.enqueueReview({ subject: { type: "message", id: subjectId }, reason: `Reported ${c.reports}x (${c.credible} from verified, aged accounts): ${subjectType} not auto-hidden, please review` }).catch(() => undefined);
    }
    if (res.changed && touched) {
      if (subjectType === "question" || subjectType === "answer") await bustQaCaches(touched); // helpful counts and auto-flags change the public list
      else if (kind === "report") await bustReviewCaches(touched); // may have auto-flagged (hidden) the item
    }
    return res;
  } catch (e) {
    if (isUniqueViolation(e)) return { changed: false }; // concurrent duplicate
    throw e;
  }
}

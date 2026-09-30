// Resolution: auto-resolution finalisation (after the escalation window) and human adjudication (ADR-013).
// DisputeResolved carries refundPaise/releasePaise/faultBusinessId; the escrow module reacts to it (this package never moves money).
import { DomainError, emit } from "@cnote/core";
import { prisma, type Dispute, type Tx } from "@cnote/db";
import { z } from "zod";
import { UUID, lockDispute, status } from "./internal";
import { logOutcomeLabel } from "./label";
import { assertTransition, faultFor, validateSplit, type DisputeOutcome } from "./state";
import type { AdjudicateInput } from "./types";

interface Resolution {
  outcome: DisputeOutcome;
  refundPaise: number;
  releasePaise: number;
  decidedBy: "auto" | "staff";
  staffPersonId?: string;
  rationale: string;
  faultBusinessId: string | null;
}
interface Resolved { disputeId: string; type: string; briefDecisionId: string | null; recommended: DisputeOutcome | null; res: Resolution; faultRole: "buyer" | "seller" | null }

/** Buyer/seller business ids for a dispute, from the opener's role (no cross-module table reads). */
export const partyIds = (d: Pick<Dispute, "openedByBusinessId" | "againstBusinessId" | "openedByRole">) =>
  d.openedByRole === "buyer" ? { buyerId: d.openedByBusinessId, sellerId: d.againstBusinessId } : { buyerId: d.againstBusinessId, sellerId: d.openedByBusinessId };

/** Writes the decision, closes the dispute (frees the order's dispute slot) and emits DisputeResolved, all in `tx`. */
async function applyResolution(tx: Tx, d: Dispute, res: Resolution): Promise<Resolved> {
  assertTransition(status(d), "resolved");
  const brief = await tx.disputeBrief.findFirst({ where: { disputeId: d.id }, orderBy: { version: "desc" } });
  const now = new Date();
  await tx.disputeDecision.create({
    data: {
      disputeId: d.id, outcome: res.outcome, refundPaise: BigInt(res.refundPaise), releasePaise: BigInt(res.releasePaise), faultBusinessId: res.faultBusinessId,
      decidedBy: res.decidedBy, decidedByStaffPersonId: res.staffPersonId ?? null, briefId: brief?.id ?? null,
      followedRecommendation: brief ? brief.recommendedOutcome === res.outcome && Number(brief.recommendedRefundPaise) === res.refundPaise : false, rationale: res.rationale,
    },
  });
  await tx.dispute.update({ where: { id: d.id }, data: { status: "resolved", resolvedAt: now, activeOrderId: null } });
  await emit(tx, "DisputeResolved", { type: "dispute", id: d.id }, {
    disputeId: d.id, orderId: d.orderId, outcome: res.outcome, refundPaise: res.refundPaise, releasePaise: res.releasePaise, decidedBy: res.decidedBy, faultBusinessId: res.faultBusinessId,
  });
  const { buyerId } = partyIds(d);
  return {
    disputeId: d.id, type: d.type, briefDecisionId: brief?.aiDecisionId ?? null, recommended: (brief?.recommendedOutcome as DisputeOutcome | undefined) ?? null, res,
    faultRole: res.faultBusinessId === null ? null : res.faultBusinessId === buyerId ? "buyer" : "seller",
  };
}

const label = (r: Resolved) => logOutcomeLabel({
  disputeId: r.disputeId, briefDecisionId: r.briefDecisionId, recommended: r.recommended, final: r.res.outcome, decidedBy: r.res.decidedBy,
  faultRole: r.faultRole, type: r.type, refundPaise: r.res.refundPaise, releasePaise: r.res.releasePaise,
});

/** Applies auto-resolutions whose escalation window closed without an escalation. Idempotent (status + unique decision). */
export async function finalizeAutoResolutions(now = new Date(), limit = 100): Promise<number> {
  const due = await prisma.dispute.findMany({ where: { status: "auto_resolved", escalationDeadline: { lte: now } }, select: { id: true }, take: limit });
  let n = 0;
  for (const { id } of due) {
    const r = await prisma.$transaction(async (tx) => {
      await lockDispute(tx, id);
      const d = await tx.dispute.findUniqueOrThrow({ where: { id } });
      if (status(d) !== "auto_resolved" || !d.proposedOutcome || d.proposedOutcome === "withdrawn") return null;
      const { buyerId, sellerId } = partyIds(d);
      return applyResolution(tx, d, {
        outcome: d.proposedOutcome, refundPaise: Number(d.proposedRefundPaise ?? 0n), releasePaise: Number(d.proposedReleasePaise ?? 0n), decidedBy: "auto",
        rationale: "Automatic resolution: clear, low-value, high-confidence case; neither party escalated within the window.",
        faultBusinessId: d.proposedFaultBusinessId ?? faultFor(d.proposedOutcome, buyerId, sellerId),
      });
    }).catch((err) => { console.error("[disputes] auto-resolution failed", id, err instanceof Error ? err.message : err); return null; });
    if (r) { n++; await label(r); }
  }
  return n;
}

const adjudicateSchema = z.object({
  outcome: z.enum(["buyer_favour", "seller_favour", "split"]),
  refundPaise: z.number().int().min(0).optional(),
  releasePaise: z.number().int().min(0).optional(),
  rationale: z.string().trim().min(10, "Give a reason of at least 10 characters").max(2000),
  acceptRecommendation: z.boolean().optional(),
});

/**
 * A staff adjudicator decides. Callers gate on `disputes.adjudicate` and wrap this in `audited()`. With
 * `acceptRecommendation` the latest AI brief's outcome and amounts are used verbatim; otherwise the adjudicator supplies
 * them (a modified decision). Refund + release must equal the amount held.
 */
export async function adjudicateDispute(staffPersonId: string, id: string, raw: AdjudicateInput): Promise<void> {
  if (!UUID.test(id)) throw new DomainError("not_found", "Dispute not found");
  const parsed = adjudicateSchema.safeParse(raw);
  if (!parsed.success) throw new DomainError("validation", parsed.error.issues[0]?.message ?? "Invalid decision");
  const input = parsed.data;
  const r = await prisma.$transaction(async (tx) => {
    await lockDispute(tx, id);
    const d = await tx.dispute.findUnique({ where: { id } });
    if (!d) throw new DomainError("not_found", "Dispute not found");
    if (!["evidence", "brief_ready", "awaiting_adjudication"].includes(status(d))) {
      throw new DomainError("conflict", status(d) === "auto_resolved" ? "An automatic resolution is pending; it can be decided once a party escalates or the window closes." : `A dispute that is ${status(d).replace("_", " ")} cannot be adjudicated.`);
    }
    const atStake = Number(d.atStakePaise);
    let { outcome, refundPaise, releasePaise } = { outcome: input.outcome as DisputeOutcome, refundPaise: input.refundPaise, releasePaise: input.releasePaise };
    if (input.acceptRecommendation) {
      const brief = await tx.disputeBrief.findFirst({ where: { disputeId: id }, orderBy: { version: "desc" } });
      if (!brief) throw new DomainError("conflict", "There is no AI brief to accept yet.");
      outcome = brief.recommendedOutcome as DisputeOutcome;
      refundPaise = Number(brief.recommendedRefundPaise);
      releasePaise = Number(brief.recommendedReleasePaise);
    } else {
      // Convenience: a full-outcome decision needs no amounts; a split needs the refund (release is the remainder).
      if (outcome === "buyer_favour") { refundPaise ??= atStake; releasePaise ??= 0; }
      else if (outcome === "seller_favour") { refundPaise ??= 0; releasePaise ??= atStake; }
      else if (refundPaise !== undefined) releasePaise ??= atStake - refundPaise;
      if (refundPaise === undefined || releasePaise === undefined) throw new DomainError("validation", "Enter the refund amount for a split decision.");
    }
    validateSplit(outcome, refundPaise, releasePaise, atStake);
    const { buyerId, sellerId } = partyIds(d);
    return applyResolution(tx, d, { outcome, refundPaise, releasePaise, decidedBy: "staff", staffPersonId, rationale: input.rationale, faultBusinessId: faultFor(outcome, buyerId, sellerId) });
  });
  await label(r);
}

const appealSchema = z.object({
  status: z.enum(["upheld", "modified"]),
  note: z.string().trim().min(10, "Give a reason of at least 10 characters").max(2000),
  newOutcome: z.enum(["buyer_favour", "seller_favour", "split"]).optional(),
  newRefundPaise: z.number().int().min(0).optional(),
  newReleasePaise: z.number().int().min(0).optional(),
});

/**
 * Second human review of an appeal (callers gate on `disputes.adjudicate`, audited). Does NOT re-emit DisputeResolved:
 * escrow has already settled the original decision, so a modified outcome is recorded here for finance to settle
 * (see docs/design/disputes.md, open legal items).
 */
export async function decideAppeal(staffPersonId: string, appealId: string, raw: z.input<typeof appealSchema>): Promise<void> {
  if (!UUID.test(appealId)) throw new DomainError("not_found", "Appeal not found");
  const p = appealSchema.safeParse(raw);
  if (!p.success) throw new DomainError("validation", p.error.issues[0]?.message ?? "Invalid appeal decision");
  const input = p.data;
  await prisma.$transaction(async (tx) => {
    const a = await tx.disputeAppeal.findUnique({ where: { id: appealId } });
    if (!a) throw new DomainError("not_found", "Appeal not found");
    await lockDispute(tx, a.disputeId);
    const fresh = await tx.disputeAppeal.findUniqueOrThrow({ where: { id: appealId } });
    if (fresh.status !== "open") throw new DomainError("conflict", "This appeal has already been decided.");
    const d = await tx.dispute.findUniqueOrThrow({ where: { id: a.disputeId } });
    let data: Parameters<typeof tx.disputeAppeal.update>[0]["data"] = { status: input.status, resolutionNote: input.note, decidedByStaffPersonId: staffPersonId, decidedAt: new Date() };
    if (input.status === "modified") {
      if (!input.newOutcome || input.newRefundPaise === undefined || input.newReleasePaise === undefined) throw new DomainError("validation", "A modified decision needs the new outcome, refund and release.");
      validateSplit(input.newOutcome, input.newRefundPaise, input.newReleasePaise, Number(d.atStakePaise));
      data = { ...data, newOutcome: input.newOutcome, newRefundPaise: BigInt(input.newRefundPaise), newReleasePaise: BigInt(input.newReleasePaise) };
    }
    await tx.disputeAppeal.update({ where: { id: appealId }, data });
  });
}

/** Staff message into one party's thread. */
export async function staffPostDisputeMessage(staffPersonId: string, disputeId: string, partyBusinessId: string, body: string): Promise<void> {
  const text = body.trim();
  if (!text || text.length > 2000) throw new DomainError("validation", "Write a message of up to 2000 characters.");
  if (!UUID.test(disputeId) || !UUID.test(partyBusinessId)) throw new DomainError("not_found", "Dispute not found");
  const d = await prisma.dispute.findUnique({ where: { id: disputeId } });
  if (!d || ![d.openedByBusinessId, d.againstBusinessId].includes(partyBusinessId)) throw new DomainError("not_found", "Dispute not found");
  await prisma.disputeMessage.create({ data: { disputeId, partyBusinessId, authorType: "staff", authorPersonId: staffPersonId, body: text } });
}

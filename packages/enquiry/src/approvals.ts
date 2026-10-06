// Buyer approval chains for RFQ publish and quote acceptance (docs/design/buyer-approvals.md). This module consults @cnote/approvals
// (it depends on it, never the reverse): a held RFQ sits in status "pending_approval" and is never matched; a held quote acceptance
// stays undecided. Both resume from the ApprovalApproved event (idempotent handlers: delivery is at-least-once).
import * as approvals from "@cnote/approvals";
import { DomainError, type DomainEvent } from "@cnote/core";
import { prisma } from "@cnote/db";
import { can, getMemberRole, type Capability } from "@cnote/identity";
import { runMatching } from "./matching";
import type { Actor } from "./types";

/**
 * Members whose role lacks the capability are refused. Callers that are not team members at all (system/agent actors, legacy
 * rows) are unchanged: authentication is the caller's job, and approvals/roles only govern people on a team.
 */
export async function assertCan(actor: Actor, cap: Capability): Promise<boolean> {
  const role = await getMemberRole(actor.personId, actor.businessId);
  if (role && !can(role, cap)) throw new DomainError("forbidden", "Your role does not allow this.");
  return role !== null;
}

/** Rough RFQ value for threshold checks: per-unit target (or the top of the budget) x quantity. Unknown = 0 (only an "any amount" rule applies). */
export function rfqEstimatePaise(i: { targetPricePaise?: number | null; budgetMaxPaise?: number | null; quantity?: number | null }): number {
  const unit = i.targetPricePaise ?? i.budgetMaxPaise ?? 0;
  const total = unit * (i.quantity ?? 1);
  return Number.isSafeInteger(total) && total >= 0 ? total : 0;
}

export async function consult(actor: Actor, input: Omit<approvals.RequireApprovalInput, "businessId" | "actorId">, isMember: boolean): Promise<approvals.RequireApprovalResult> {
  if (!isMember) return { status: "not_required", requestId: null };
  return approvals.requireApproval({ ...input, businessId: actor.businessId, actorId: actor.personId });
}

// ---- resume handlers (registered in worker.ts) ----------------------------------------------------------------------------

type Approved = DomainEvent<"ApprovalApproved">["payload"];
type Rejected = DomainEvent<"ApprovalRejected">["payload"];

/** An approved RFQ leaves the hold: back to "review" (moderation still pending) or "scoring" and matched. */
export async function resumeApprovedEnquiry(p: Approved): Promise<void> {
  const e = await prisma.enquiry.findUnique({ where: { id: p.subjectId }, select: { status: true, buyerBusinessId: true, moderationStatus: true } });
  if (!e || e.buyerBusinessId !== p.businessId || e.status !== "pending_approval") return;
  const next = e.moderationStatus === "review" ? "review" : "scoring";
  const claimed = await prisma.enquiry.updateMany({ where: { id: p.subjectId, status: "pending_approval" }, data: { status: next } });
  if (claimed.count > 0 && next === "scoring") await runMatching(p.subjectId);
}

/** A rejected / withdrawn / expired RFQ approval closes the requirement; it was never offered to a seller. */
export async function closeUnapprovedEnquiry(p: Rejected): Promise<void> {
  await prisma.enquiry.updateMany({ where: { id: p.subjectId, buyerBusinessId: p.businessId, status: "pending_approval" }, data: { status: "closed" } });
}

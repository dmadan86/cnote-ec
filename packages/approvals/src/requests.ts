// Approval requests: raise (requireApproval), decide, withdraw, list. Decisions are append-only (Postgres trigger) and every
// state change emits a versioned event in the same transaction, so callers resume held actions from ApprovalApproved /
// ApprovalRejected (docs/design/buyer-approvals.md). This module knows nothing about RFQs, quotes or POs: subjects are opaque.
import { DomainError, emit } from "@cnote/core";
import { prisma, type Tx } from "@cnote/db";
import { can, getMemberRole } from "@cnote/identity";
import { z } from "zod";
import { slaMs } from "./config";
import { activeDelegations, deciderRight, eligibleFor, teamRoles, withDelegates, type ActiveDelegation } from "./eligibility";
import { matchPolicy } from "./policies";
import { getSpendLimitPaise, getSpentPaise } from "./spend";
import {
  APPROVAL_ACTIONS, MAX_LEVELS, SPEND_ACTIONS,
  type ApprovalActionName, type ApprovalStatusName, type ChainLevel, type DecisionView, type RequestView, type RequireApprovalInput, type RequireApprovalResult,
} from "./types";
import type { TeamRole } from "@cnote/identity";

const MAX_PAISE = 10_000_000_000_000;
const inputSchema = z.object({
  businessId: z.uuid(),
  actorId: z.uuid(),
  action: z.enum(APPROVAL_ACTIONS),
  amountPaise: z.number().int().min(0).max(MAX_PAISE),
  subject: z.object({ type: z.string().trim().min(1).max(40), id: z.string().trim().min(1).max(80), summary: z.string().trim().min(1).max(200) }),
});
const COMMENT_MAX = 1000;

const keyOf = (businessId: string, action: string, type: string, id: string) => `${businessId}|${action}|${type}|${id}`;
const isUnique = (e: unknown) => (e as { code?: string })?.code === "P2002";
const san = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

type ReqRow = NonNullable<Awaited<ReturnType<typeof loadRow>>>;
const loadRow = (id: string, db: Pick<typeof prisma, "approvalRequest"> = prisma) => db.approvalRequest.findUnique({ where: { id }, include: { decisions: { orderBy: { createdAt: "asc" } } } });

const chainOf = (r: { levels: unknown }): ChainLevel[] => (r.levels as ChainLevel[]) ?? [];
const humanDeciders = (r: ReqRow): Set<string> => {
  const s = new Set<string>([r.requesterPersonId]);
  for (const d of r.decisions) {
    if (d.deciderPersonId) s.add(d.deciderPersonId);
    if (d.onBehalfOfPersonId) s.add(d.onBehalfOfPersonId);
  }
  return s;
};

function payloadBase(r: { id: string; businessId: string; action: string; subjectType: string; subjectId: string; subjectSummary: string; amountPaise: bigint; requesterPersonId: string }) {
  return { requestId: r.id, businessId: r.businessId, action: r.action, subjectType: r.subjectType, subjectId: r.subjectId, subjectSummary: r.subjectSummary, amountPaise: Number(r.amountPaise), requesterPersonId: r.requesterPersonId };
}

/**
 * Does `action` on `subject` need sign-off from someone else, and if so where does it stand?
 *  - not_required: no policy matches and the member is within their spend limit: go ahead.
 *  - pending: a request exists / was just raised; hold the action and resume on the ApprovalApproved event.
 *  - approved: the chain approved (or nobody else could decide, see `reason`): go ahead.
 *  - rejected: a previous request for this subject was rejected; the action must not proceed.
 * Idempotent per (business, action, subject): asking again returns the open or approved request instead of raising another.
 */
export async function requireApproval(input: RequireApprovalInput, now = new Date()): Promise<RequireApprovalResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new DomainError("validation", "Invalid approval request.");
  const { businessId, actorId, action, amountPaise } = parsed.data;
  const subject = { ...parsed.data.subject, summary: san(parsed.data.subject.summary) };
  if (!(await getMemberRole(actorId, businessId))) throw new DomainError("forbidden", "You are not part of this business.");

  const latest = await prisma.approvalRequest.findFirst({ where: { businessId, action, subjectType: subject.type, subjectId: subject.id }, orderBy: { createdAt: "desc" } });
  if (latest) {
    if (latest.status === "pending") return { status: "pending", requestId: latest.id, reason: latest.reason as "policy" | "spend_limit" };
    if (latest.status === "approved" && Number(latest.amountPaise) >= amountPaise) return { status: "approved", requestId: latest.id, reason: latest.reason as "policy" | "spend_limit" };
    if (latest.status === "rejected") return { status: "rejected", requestId: latest.id, reason: latest.reason as "policy" | "spend_limit" };
    // cancelled / expired / approved for a smaller amount: evaluate afresh
  }

  const policy = await matchPolicy(businessId, action, amountPaise);
  let overLimit = false;
  if (SPEND_ACTIONS.includes(action)) {
    const cap = await getSpendLimitPaise(businessId, actorId);
    overLimit = cap !== null && (await getSpentPaise(businessId, actorId, now)) + amountPaise > cap;
  }
  let chain: ChainLevel[] = (policy?.levels ?? []).filter((l) => amountPaise >= l.minAmountPaise).map((l, i) => ({ level: i + 1, role: l.role, personIds: l.personIds }));
  if (overLimit && !chain.some((l) => l.role === "admin" || l.role === "owner")) {
    // spend-limit escalation: an owner/admin must also sign off, as the last level (replacing the last when the chain is full)
    if (chain.length >= MAX_LEVELS) chain = chain.slice(0, MAX_LEVELS - 1);
    chain.push({ level: chain.length + 1, role: "admin", personIds: [] });
  }
  if (chain.length === 0) return { status: "not_required", requestId: null, reason: "none" };
  const reason = overLimit ? "spend_limit" : "policy";

  // Find the first level somebody other than the requester can decide; earlier empty levels are recorded as auto-approved.
  const [roles, delegs] = await Promise.all([teamRoles(businessId), activeDelegations(businessId, now)]);
  const exclude = new Set([actorId]);
  const skipped: ChainLevel[] = [];
  let active: ChainLevel | null = null;
  let approvers: string[] = [];
  for (const l of chain) {
    approvers = eligibleFor(l, roles, exclude);
    if (approvers.length > 0) { active = l; break; }
    skipped.push(l);
  }
  const base = { businessId, action, subjectType: subject.type, subjectId: subject.id, subjectSummary: subject.summary, amountPaise: BigInt(amountPaise), requesterPersonId: actorId, policyId: policy?.id ?? null, reason, levels: chain as object };

  if (!active) {
    // Nobody but the requester could ever approve (e.g. a one-person business): a deadlock helps no one. Approve, but leave the trail.
    const row = await prisma.$transaction(async (tx) => {
      const r = await tx.approvalRequest.create({ data: { ...base, status: "approved", currentLevel: chain.length, dueAt: now, resolvedAt: now } });
      await tx.approvalDecision.createMany({ data: chain.map((l) => ({ requestId: r.id, level: l.level, kind: "auto_approved" as const, createdAt: now })) });
      return r;
    });
    return { status: "approved", requestId: row.id, reason: "no_eligible_approver" };
  }

  try {
    const row = await prisma.$transaction(async (tx) => {
      const r = await tx.approvalRequest.create({
        data: { ...base, status: "pending", currentLevel: active!.level, activeKey: keyOf(businessId, action, subject.type, subject.id), dueAt: new Date(now.getTime() + slaMs()) },
      });
      if (skipped.length) await tx.approvalDecision.createMany({ data: skipped.map((l) => ({ requestId: r.id, level: l.level, kind: "auto_approved" as const, createdAt: now })) });
      await emit(tx, "ApprovalRequested", { type: "approval", id: r.id }, { ...payloadBase(r), level: active!.level, totalLevels: chain.length, approverPersonIds: withDelegates(approvers, delegs, roles, exclude) });
      return r;
    });
    return { status: "pending", requestId: row.id, reason };
  } catch (e) {
    if (!isUnique(e)) throw e;
    const open = await prisma.approvalRequest.findFirst({ where: { activeKey: keyOf(businessId, action, subject.type, subject.id) } });
    if (!open) throw e;
    return { status: "pending", requestId: open.id, reason: open.reason as "policy" | "spend_limit" };
  }
}

export interface DecideInput {
  requestId: string;
  deciderId: string;
  decision: "approve" | "reject";
  comment?: string | null;
}

/** Records one decision on the current level. The requester can never decide (nor on behalf of an approver who is the requester). */
export async function decide(input: DecideInput, now = new Date()): Promise<{ status: ApprovalStatusName; level: number }> {
  if (!z.uuid().safeParse(input.requestId).success || !z.uuid().safeParse(input.deciderId).success) throw new DomainError("not_found", "Request not found");
  if (input.decision !== "approve" && input.decision !== "reject") throw new DomainError("validation", "Invalid decision");
  const comment = input.comment ? san(input.comment).slice(0, COMMENT_MAX) : null;
  if (input.decision === "reject" && (comment?.length ?? 0) < 3) throw new DomainError("validation", "Say why you are rejecting.");

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM approval_requests WHERE id = ${input.requestId}::uuid FOR UPDATE`;
    const r = await loadRow(input.requestId, tx);
    if (!r) throw new DomainError("not_found", "Request not found");
    if (r.status !== "pending") throw new DomainError("conflict", "This request has already been decided.");
    if (r.requesterPersonId === input.deciderId) throw new DomainError("forbidden", "You cannot approve your own request.");

    const [roles, delegations] = await Promise.all([teamRoles(r.businessId), activeDelegations(r.businessId, now)]);
    const exclude = humanDeciders(r);
    const chain = chainOf(r);
    const cur = chain.find((l) => l.level === r.currentLevel);
    if (!cur) throw new DomainError("conflict", "This request is no longer open.");
    const eligible = eligibleFor(cur, roles, exclude);
    const right = deciderRight(input.deciderId, eligible, delegations, roles, exclude);
    if (!right) {
      // a person who already decided an earlier level gets a specific message
      const again = r.decisions.some((d) => d.deciderPersonId === input.deciderId);
      throw new DomainError("forbidden", again ? "A different person must approve each level." : "You cannot decide this request.");
    }

    const kind = input.decision === "approve" ? "approved" : "rejected";
    await tx.approvalDecision.create({ data: { requestId: r.id, level: r.currentLevel, kind, deciderPersonId: input.deciderId, onBehalfOfPersonId: right.onBehalfOfPersonId, comment, createdAt: now } });
    await emit(tx, "ApprovalDecided", { type: "approval", id: r.id }, { requestId: r.id, businessId: r.businessId, level: r.currentLevel, decision: kind, deciderPersonId: input.deciderId, onBehalfOfPersonId: right.onBehalfOfPersonId });

    if (kind === "rejected") {
      await close(tx, r, "rejected", now, input.deciderId);
      return { status: "rejected" as const, level: r.currentLevel };
    }

    // advance to the next level somebody else can decide; levels with nobody left are logged as auto-approved
    const nextExclude = new Set(exclude).add(input.deciderId);
    if (right.onBehalfOfPersonId) nextExclude.add(right.onBehalfOfPersonId);
    for (const l of chain.filter((x) => x.level > r.currentLevel)) {
      const approvers = eligibleFor(l, roles, nextExclude);
      if (approvers.length === 0) {
        await tx.approvalDecision.create({ data: { requestId: r.id, level: l.level, kind: "auto_approved", createdAt: now } });
        continue;
      }
      await tx.approvalRequest.update({ where: { id: r.id }, data: { currentLevel: l.level, dueAt: new Date(now.getTime() + slaMs()), reminderCount: 0, lastReminderAt: null } });
      await emit(tx, "ApprovalRequested", { type: "approval", id: r.id }, { ...payloadBase(r), level: l.level, totalLevels: chain.length, approverPersonIds: withDelegates(approvers, delegations, roles, nextExclude) });
      return { status: "pending" as const, level: l.level };
    }
    await tx.approvalRequest.update({ where: { id: r.id }, data: { status: "approved", activeKey: null, resolvedAt: now } });
    await emit(tx, "ApprovalApproved", { type: "approval", id: r.id }, payloadBase(r));
    return { status: "approved" as const, level: r.currentLevel };
  });
}

/** Ends a pending request without approval: writes the log row (for cancel/expire) and emits ApprovalRejected. */
async function close(tx: Tx, r: ReqRow, cause: "rejected" | "cancelled" | "expired", now: Date, deciderId: string | null): Promise<void> {
  await tx.approvalRequest.update({ where: { id: r.id }, data: { status: cause, activeKey: null, resolvedAt: now } });
  await emit(tx, "ApprovalRejected", { type: "approval", id: r.id }, { ...payloadBase(r), cause, deciderPersonId: deciderId });
}

/** The requester (or an owner/admin) withdraws a pending request. */
export async function cancelRequest(input: { requestId: string; actorId: string; comment?: string | null }, now = new Date()): Promise<void> {
  if (!z.uuid().safeParse(input.requestId).success) throw new DomainError("not_found", "Request not found");
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM approval_requests WHERE id = ${input.requestId}::uuid FOR UPDATE`;
    const r = await loadRow(input.requestId, tx);
    if (!r) throw new DomainError("not_found", "Request not found");
    const role = await getMemberRole(input.actorId, r.businessId);
    if (!role || (r.requesterPersonId !== input.actorId && !can(role, "policy.manage"))) throw new DomainError("not_found", "Request not found");
    if (r.status !== "pending") throw new DomainError("conflict", "This request has already been decided.");
    await tx.approvalDecision.create({ data: { requestId: r.id, level: r.currentLevel, kind: "cancelled", deciderPersonId: input.actorId, comment: input.comment ? san(input.comment).slice(0, COMMENT_MAX) : null, createdAt: now } });
    await close(tx, r, "cancelled", now, input.actorId);
  });
}

/** System expiry (SLA sweep). Idempotent: only a still-pending request moves. */
export async function expireRequest(requestId: string, now = new Date()): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM approval_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
    const r = await loadRow(requestId, tx);
    if (!r || r.status !== "pending") return false;
    await tx.approvalDecision.create({ data: { requestId: r.id, level: r.currentLevel, kind: "expired", createdAt: now } });
    await close(tx, r, "expired", now, null);
    return true;
  });
}

/** Cancels a pending request on behalf of the system (its requester left the team). Idempotent. */
export async function systemCancel(requestId: string, now = new Date()): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM approval_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
    const r = await loadRow(requestId, tx);
    if (!r || r.status !== "pending") return false;
    await tx.approvalDecision.create({ data: { requestId: r.id, level: r.currentLevel, kind: "cancelled", createdAt: now } });
    await close(tx, r, "cancelled", now, null);
    return true;
  });
}

// ---- reads ---------------------------------------------------------------------------------------------------------------

const decisionView = (d: ReqRow["decisions"][number]): DecisionView => ({
  id: d.id, level: d.level, kind: d.kind, deciderPersonId: d.deciderPersonId, onBehalfOfPersonId: d.onBehalfOfPersonId, comment: d.comment, createdAt: d.createdAt.toISOString(),
});

function toView(r: ReqRow, roles: Map<string, TeamRole>): RequestView {
  const chain = chainOf(r);
  const cur = chain.find((l) => l.level === r.currentLevel);
  return {
    id: r.id,
    businessId: r.businessId,
    action: r.action as ApprovalActionName,
    subject: { type: r.subjectType, id: r.subjectId, summary: r.subjectSummary },
    amountPaise: Number(r.amountPaise),
    requesterPersonId: r.requesterPersonId,
    status: r.status,
    reason: r.reason as "policy" | "spend_limit",
    currentLevel: r.currentLevel,
    totalLevels: chain.length,
    approverPersonIds: r.status === "pending" && cur ? eligibleFor(cur, roles, humanDeciders(r)) : [],
    dueAt: r.dueAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
    decisions: r.decisions.map(decisionView),
  };
}

export async function getRequest(businessId: string, requestId: string): Promise<RequestView | null> {
  if (!z.uuid().safeParse(requestId).success) return null;
  const r = await prisma.approvalRequest.findFirst({ where: { id: requestId, businessId }, include: { decisions: { orderBy: { createdAt: "asc" } } } });
  return r ? toView(r, await teamRoles(businessId)) : null;
}

/** Requests the person can decide right now (directly or as an active delegate), oldest first. */
export async function listPending(input: { businessId: string; personId: string; now?: Date; take?: number }): Promise<(RequestView & { onBehalfOfPersonId: string | null })[]> {
  const now = input.now ?? new Date();
  const [rows, roles, delegations] = await Promise.all([
    prisma.approvalRequest.findMany({ where: { businessId: input.businessId, status: "pending" }, include: { decisions: { orderBy: { createdAt: "asc" } } }, orderBy: { createdAt: "asc" }, take: 500 }),
    teamRoles(input.businessId),
    activeDelegations(input.businessId, now),
  ]);
  const out: (RequestView & { onBehalfOfPersonId: string | null })[] = [];
  for (const r of rows) {
    const cur = chainOf(r).find((l) => l.level === r.currentLevel);
    if (!cur) continue;
    const exclude = humanDeciders(r);
    const right = deciderRight(input.personId, eligibleFor(cur, roles, exclude), delegations as ActiveDelegation[], roles, exclude);
    if (right) out.push({ ...toView(r, roles), onBehalfOfPersonId: right.onBehalfOfPersonId });
    if (out.length >= (input.take ?? 100)) break;
  }
  return out;
}

/** The person's own requests (`mine`) or every request of the business (`all`, for owners/admins/finance), newest first. */
export async function listRequests(input: { businessId: string; personId: string; scope: "mine" | "all"; status?: ApprovalStatusName; take?: number }): Promise<RequestView[]> {
  const role = await getMemberRole(input.personId, input.businessId);
  if (!role) return [];
  const all = input.scope === "all" && (can(role, "policy.manage") || can(role, "spend.manage"));
  const rows = await prisma.approvalRequest.findMany({
    where: { businessId: input.businessId, ...(all ? {} : { requesterPersonId: input.personId }), ...(input.status ? { status: input.status } : {}) },
    include: { decisions: { orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "desc" },
    take: Math.min(input.take ?? 50, 200),
  });
  const roles = await teamRoles(input.businessId);
  return rows.map((r) => toView(r, roles));
}

/** Every approval request about one subject with its decisions: the audit trail shown on the subject page. */
export async function getSubjectTrail(businessId: string, subjectType: string, subjectId: string): Promise<RequestView[]> {
  const rows = await prisma.approvalRequest.findMany({
    where: { businessId, subjectType, subjectId },
    include: { decisions: { orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  if (rows.length === 0) return [];
  const roles = await teamRoles(businessId);
  return rows.map((r) => toView(r, roles));
}

/** Latest approval status per subject id (for list pages): subjects with no request are absent from the map. */
export async function getSubjectStatuses(businessId: string, subjectType: string, subjectIds: string[]): Promise<Map<string, { status: ApprovalStatusName; requestId: string }>> {
  if (subjectIds.length === 0) return new Map();
  const rows = await prisma.approvalRequest.findMany({ where: { businessId, subjectType, subjectId: { in: subjectIds.slice(0, 500) } }, orderBy: { createdAt: "asc" }, select: { id: true, subjectId: true, status: true } });
  return new Map(rows.map((r) => [r.subjectId, { status: r.status, requestId: r.id }]));
}

/** Number of requests waiting for the person (nav badge). */
export async function countPending(businessId: string, personId: string, now = new Date()): Promise<number> {
  return (await listPending({ businessId, personId, now, take: 99 })).length;
}

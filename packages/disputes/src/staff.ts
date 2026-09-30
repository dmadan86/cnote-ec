// Back-office reads (callers gate on `disputes.read`; adjudication on `disputes.adjudicate`, wrapped in audited()).
import { prisma, type Dispute, type DisputeBrief } from "@cnote/db";
import { UUID, num, status } from "./internal";
import { evidenceStore } from "./ports";
import { appealView } from "./parties";
import { isActive, type DisputeOutcome, type DisputeStatus } from "./state";
import type { BriefView, StaffDisputeSummary, StaffDisputeView, StaffEvidenceView } from "./types";
import { partyIds } from "./resolve";

const briefView = (b: DisputeBrief): BriefView => ({
  id: b.id, version: b.version, classifiedType: b.classifiedType, summary: b.summary,
  citedEvidenceIds: Array.isArray(b.citedEvidenceIds) ? (b.citedEvidenceIds as string[]) : [],
  specChecks: Array.isArray(b.specChecks) ? (b.specChecks as BriefView["specChecks"]) : [],
  specVerdict: b.specVerdict, recommendedOutcome: b.recommendedOutcome as BriefView["recommendedOutcome"],
  recommendedRefundPaise: Number(b.recommendedRefundPaise), recommendedReleasePaise: Number(b.recommendedReleasePaise), rationale: b.rationale,
  confidence: b.confidence, autoResolvable: b.autoResolvable, needsReview: b.needsReview, evidenceCount: b.evidenceCount, provider: b.provider, modelId: b.modelId,
  promptVersion: b.promptVersion, createdAt: b.createdAt.toISOString(),
});

function staffSummary(d: Dispute, briefConfidence: number | null, hasOpenAppeal: boolean, now: number): StaffDisputeSummary {
  const { buyerId, sellerId } = partyIds(d);
  const msToDue = d.dueAt.getTime() - now;
  return {
    id: d.id, orderId: d.orderId, status: status(d), type: d.type, buyerBusinessId: buyerId, sellerBusinessId: sellerId, amountPaise: num(d.amountPaise),
    atStakePaise: Number(d.atStakePaise), createdAt: d.createdAt.toISOString(), dueAt: d.dueAt.toISOString(), overdue: isActive(status(d)) && msToDue < 0, msToDue,
    escalated: d.escalatedAt !== null, hasOpenAppeal, briefConfidence,
  };
}

export interface QueueFilter { status?: DisputeStatus; onlyActive?: boolean; limit?: number }

/** Adjudicator queue: active cases first, soonest SLA deadline first (overdue at the top); then closed cases newest first. */
export async function listDisputeQueue(f: QueueFilter = {}): Promise<StaffDisputeSummary[]> {
  const limit = Math.max(1, Math.min(f.limit ?? 100, 300));
  const rows = await prisma.dispute.findMany({
    where: f.status ? { status: f.status } : f.onlyActive ? { status: { in: ["open", "evidence", "brief_ready", "auto_resolved", "awaiting_adjudication"] } } : {},
    orderBy: [{ dueAt: "asc" }], take: limit * 2,
  });
  const ids = rows.map((r) => r.id);
  const [briefs, appeals] = await Promise.all([
    prisma.disputeBrief.findMany({ where: { disputeId: { in: ids } }, orderBy: { version: "desc" }, select: { disputeId: true, confidence: true } }),
    prisma.disputeAppeal.findMany({ where: { disputeId: { in: ids }, status: "open" }, select: { disputeId: true } }),
  ]);
  const conf = new Map<string, number>();
  for (const b of briefs) if (!conf.has(b.disputeId)) conf.set(b.disputeId, b.confidence);
  const openAppeal = new Set(appeals.map((a) => a.disputeId));
  const now = Date.now();
  const out = rows.map((d) => staffSummary(d, conf.get(d.id) ?? null, openAppeal.has(d.id), now));
  const rank = (s: StaffDisputeSummary) => (isActive(s.status) ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || (isActive(a.status) ? a.msToDue - b.msToDue : Date.parse(b.createdAt) - Date.parse(a.createdAt))).slice(0, limit);
}

/** Count of cases waiting on a human (awaiting adjudication, or with an open appeal). */
export async function countDisputesNeedingStaff(): Promise<number> {
  const [a, b] = await Promise.all([
    prisma.dispute.count({ where: { status: "awaiting_adjudication" } }),
    prisma.disputeAppeal.count({ where: { status: "open" } }),
  ]);
  return a + b;
}

export async function getDisputeForStaff(id: string): Promise<StaffDisputeView | null> {
  if (!UUID.test(id)) return null;
  const d = await prisma.dispute.findUnique({ where: { id }, include: { evidence: { orderBy: { createdAt: "asc" } }, briefs: { orderBy: { version: "desc" } }, decision: true, messages: { orderBy: { createdAt: "asc" } }, appeals: { orderBy: { createdAt: "asc" } } } });
  if (!d) return null;
  const base = staffSummary(d, d.briefs[0]?.confidence ?? null, d.appeals.some((a) => a.status === "open"), Date.now());
  const evidence: StaffEvidenceView[] = d.evidence.map((e) => ({
    id: e.id, party: e.party, kind: e.kind, text: e.text, hasFile: e.mediaKey !== null, mimeType: e.mimeType, source: e.source, purged: e.purgedAt !== null,
    createdAt: e.createdAt.toISOString(), submittedByBusinessId: e.submittedByBusinessId, language: e.language,
  }));
  const latest = d.briefs[0];
  const threads = new Map<string, StaffDisputeView["threads"][number]["messages"]>();
  for (const m of d.messages) {
    const list = threads.get(m.partyBusinessId) ?? [];
    list.push({ id: m.id, authorType: m.authorType as "buyer" | "seller" | "staff" | "system", body: m.body, createdAt: m.createdAt.toISOString(), authorPersonId: m.authorPersonId });
    threads.set(m.partyBusinessId, list);
  }
  return {
    ...base, openedByBusinessId: d.openedByBusinessId, againstBusinessId: d.againstBusinessId, description: d.description, language: d.language,
    responseDueAt: d.responseDueAt.toISOString(), counterpartyRespondedAt: d.counterpartyRespondedAt?.toISOString() ?? null,
    evidence, briefs: d.briefs.map(briefView),
    evidenceAfterBrief: latest ? d.evidence.filter((e) => e.createdAt > latest.createdAt && e.purgedAt === null).length : 0,
    proposal: d.proposedOutcome && d.proposedOutcome !== "withdrawn" && d.escalationDeadline
      ? { outcome: d.proposedOutcome, refundPaise: Number(d.proposedRefundPaise ?? 0n), releasePaise: Number(d.proposedReleasePaise ?? 0n), escalationDeadline: d.escalationDeadline.toISOString() }
      : null,
    decision: d.decision && {
      outcome: d.decision.outcome, refundPaise: Number(d.decision.refundPaise), releasePaise: Number(d.decision.releasePaise), decidedBy: d.decision.decidedBy as "auto" | "staff",
      rationale: d.decision.rationale, faultBusinessId: d.decision.faultBusinessId, createdAt: d.decision.createdAt.toISOString(),
      followedRecommendation: d.decision.followedRecommendation, decidedByStaffPersonId: d.decision.decidedByStaffPersonId,
    },
    threads: [...threads].map(([partyBusinessId, messages]) => ({ partyBusinessId, messages })),
    appeals: d.appeals.map((a) => ({
      ...appealView(a), byBusinessId: a.byBusinessId, newOutcome: a.newOutcome as DisputeOutcome | null, newRefundPaise: num(a.newRefundPaise), newReleasePaise: num(a.newReleasePaise),
    })),
  };
}

/** Evidence bytes for the back-office viewer (route gates on `disputes.read`). */
export async function readEvidenceFileForStaff(disputeId: string, evidenceId: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!UUID.test(disputeId) || !UUID.test(evidenceId)) return null;
  const e = await prisma.disputeEvidence.findFirst({ where: { id: evidenceId, disputeId } });
  if (!e?.mediaKey || e.purgedAt) return null;
  return evidenceStore().get(e.mediaKey);
}

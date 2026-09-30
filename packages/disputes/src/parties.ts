// Party-facing actions (buyer or seller of the order): open, respond, add evidence, withdraw, escalate, appeal, message, read.
import { randomUUID } from "node:crypto";
import { DomainError, emit } from "@cnote/core";
import { getOrder } from "@cnote/enquiry";
import { prisma, type Dispute } from "@cnote/db";
import { z } from "zod";
import { APPEAL_WINDOW_DAYS, DISPUTE_TYPES, DAY_MS, disputeConfig } from "./config";
import { enqueueBrief, enqueueCollect } from "./jobs";
import { UUID, isUniqueViolation, loadForParty, lockDispute, num, prepareEvidence, requireEnabled, roleOf, status, toEvidenceView, MAX_EVIDENCE_PER_PARTY } from "./internal";
import { escrowPort, evidenceStore } from "./ports";
import { assertTransition, deadlines, EVIDENCE_OPEN_STATUSES, isActive } from "./state";
import { logOutcomeLabel } from "./label";
import type {
  Actor, AddEvidenceInput, AppealView, DecisionView, DisputeSummary, DisputeView, EvidenceView, MessageView, OpenDisputeInput, ProposalView, RespondInput,
} from "./types";

const LANGS = ["en", "hi", "kn", "ta", "te", "mr", "gu", "bn"] as const;
/** Orders that exist only as a draft or were cancelled cannot be disputed. */
const DISPUTABLE_ORDER = ["confirmed", "dispatched", "delivered", "completed"];

const openSchema = z.object({
  orderId: z.string().regex(UUID, "Choose an order"),
  type: z.enum(DISPUTE_TYPES),
  description: z.string().trim().max(4000).optional().default(""),
  amountPaise: z.number().int().min(0).max(100_000_000_000).nullish(),
  language: z.enum(LANGS).optional().default("en"),
});

const zodMessage = (err: z.ZodError) => err.issues[0]?.message ?? "Invalid input";

// ------------------------------------------------------------------------------------------------
// Open
// ------------------------------------------------------------------------------------------------
export async function openDispute(actor: Actor, raw: OpenDisputeInput): Promise<DisputeView> {
  requireEnabled();
  const parsed = openSchema.safeParse(raw);
  if (!parsed.success) throw new DomainError("validation", zodMessage(parsed.error));
  const input = parsed.data;

  const order = await getOrder(actor, input.orderId);
  if (!order) throw new DomainError("not_found", "Order not found"); // only parties to the order (enquiry enforces it)
  if (!DISPUTABLE_ORDER.includes(order.status)) throw new DomainError("conflict", `An order that is ${order.status} cannot be disputed.`);
  if (await prisma.dispute.findFirst({ where: { activeOrderId: order.id }, select: { id: true } })) {
    throw new DomainError("conflict", "There is already an open dispute for this order.");
  }

  const disputeId = randomUUID();
  const prepared = await prepareEvidence(disputeId, { text: input.description, language: input.language, voiceConsent: raw.voiceConsent, uploads: raw.attachments });
  try {
    // A voice-only report: the transcript is the description.
    const description = input.description || prepared.transcript || "";
    if (description.length < 10) throw new DomainError("validation", "Describe the problem in at least 10 characters (or attach a voice note).");

    const escrow = await escrowPort().getEscrowForOrder(order.id);
    const ceiling = Math.max(order.totalPaise ?? 0, escrow?.heldPaise ?? 0);
    const claimed = input.amountPaise ?? null;
    if (claimed !== null && ceiling > 0 && claimed > ceiling) throw new DomainError("validation", "The amount you claim cannot exceed the value of the order.");
    const atStake = escrow?.heldPaise ?? order.totalPaise ?? claimed ?? 0;

    const now = new Date();
    const { dueAt, responseDueAt } = deadlines(now, disputeConfig());
    const otherId = order.counterparty.businessId;
    let created: Dispute;
    try {
      created = await prisma.$transaction(async (tx) => {
        const d = await tx.dispute.create({
          data: {
            id: disputeId, orderId: order.id, openedByBusinessId: actor.businessId, openedByPersonId: actor.personId, againstBusinessId: otherId,
            openedByRole: order.role, type: input.type, description, language: input.language, amountPaise: claimed === null ? null : BigInt(claimed),
            atStakePaise: BigInt(atStake), activeOrderId: order.id, dueAt, responseDueAt,
          },
        });
        const evidence = prepared.rows;
        for (const r of evidence) {
          await tx.disputeEvidence.create({
            data: {
              id: r.id, disputeId, party: order.role, submittedByBusinessId: actor.businessId, submittedByPersonId: actor.personId,
              kind: r.kind, text: r.text, mediaKey: r.mediaKey, mimeType: r.mimeType, language: r.language, source: "upload",
            },
          });
        }
        await emit(tx, "DisputeOpened", { type: "dispute", id: disputeId }, {
          disputeId, orderId: order.id, openedByBusinessId: actor.businessId, againstBusinessId: otherId, type: input.type, amountPaise: claimed,
        });
        return d;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new DomainError("conflict", "There is already an open dispute for this order.");
      throw err;
    }
    await enqueueCollect(disputeId);
    return viewOf(created, order.role, actor.businessId);
  } catch (err) {
    await prepared.cleanup();
    throw err;
  }
}

// ------------------------------------------------------------------------------------------------
// Counterparty response + extra evidence
// ------------------------------------------------------------------------------------------------
async function addRows(actor: Actor, id: string, kind: "respond" | "evidence", input: RespondInput & AddEvidenceInput & { attachments?: RespondInput["attachments"] }): Promise<EvidenceView[]> {
  requireEnabled();
  const { d: pre, role } = await loadForParty(actor, id);
  if (!EVIDENCE_OPEN_STATUSES.includes(status(pre))) throw new DomainError("conflict", "Evidence can no longer be added: the case is already being reviewed.");
  if (kind === "respond" && pre.openedByBusinessId === actor.businessId) throw new DomainError("forbidden", "Only the other party can respond to a dispute you opened.");

  const uploads = input.attachments ?? (input.attachment ? [input.attachment] : []);
  const prepared = await prepareEvidence(id, { text: input.text, language: input.language, voiceConsent: input.voiceConsent, uploads });
  try {
    if (prepared.rows.length === 0) throw new DomainError("validation", kind === "respond" ? "Write your response or attach evidence." : "Add a statement or a file.");
    if (kind === "respond" && !prepared.rows.some((r) => r.text)) throw new DomainError("validation", "Please include a written or voice statement in your response.", undefined, "disputes.includeWrittenVoiceStatementResponse");
    let firstResponse = false;
    const rows = await prisma.$transaction(async (tx) => {
      await lockDispute(tx, id);
      const d = await tx.dispute.findUniqueOrThrow({ where: { id } });
      if (!EVIDENCE_OPEN_STATUSES.includes(status(d))) throw new DomainError("conflict", "Evidence can no longer be added: the case is already being reviewed.");
      const mine = await tx.disputeEvidence.count({ where: { disputeId: id, submittedByBusinessId: actor.businessId } });
      if (mine + prepared.rows.length > MAX_EVIDENCE_PER_PARTY) throw new DomainError("validation", "You have reached the evidence limit for this case.");
      const out = [];
      for (const r of prepared.rows) {
        out.push(await tx.disputeEvidence.create({
          data: { id: r.id, disputeId: id, party: role, submittedByBusinessId: actor.businessId, submittedByPersonId: actor.personId, kind: r.kind, text: r.text, mediaKey: r.mediaKey, mimeType: r.mimeType, language: r.language, source: "upload" },
        }));
      }
      if (kind === "respond" && d.counterpartyRespondedAt === null) {
        firstResponse = true;
        await tx.dispute.update({ where: { id }, data: { counterpartyRespondedAt: new Date(), ...(status(d) === "open" ? { status: "evidence", briefQueuedAt: new Date() } : {}) } });
      }
      return out;
    });
    if (firstResponse) await enqueueBrief(id);
    return rows.map((e) => toEvidenceView(e, actor.businessId));
  } catch (err) {
    await prepared.cleanup();
    throw err;
  }
}

/** The counterparty's response (typed and/or voice, plus files). Closes the response window early and queues the AI brief. */
export const respondToDispute = (actor: Actor, id: string, input: RespondInput) => addRows(actor, id, "respond", input);
/** Either party adds a statement or a file while the case is still collecting evidence. */
export const addDisputeEvidence = (actor: Actor, id: string, input: AddEvidenceInput) => addRows(actor, id, "evidence", input);

// ------------------------------------------------------------------------------------------------
// Withdraw / escalate / appeal / message
// ------------------------------------------------------------------------------------------------
export async function withdrawDispute(actor: Actor, id: string): Promise<void> {
  requireEnabled();
  const { d: pre } = await loadForParty(actor, id);
  if (pre.openedByBusinessId !== actor.businessId) throw new DomainError("forbidden", "Only the party that opened the dispute can withdraw it.");
  const now = new Date();
  const resolved = await prisma.$transaction(async (tx) => {
    await lockDispute(tx, id);
    const d = await tx.dispute.findUniqueOrThrow({ where: { id } });
    assertTransition(status(d), "withdrawn");
    await tx.dispute.update({ where: { id }, data: { status: "withdrawn", withdrawnAt: now, resolvedAt: now, activeOrderId: null, proposedOutcome: null } });
    const brief = await tx.disputeBrief.findFirst({ where: { disputeId: id }, orderBy: { version: "desc" } });
    await tx.disputeDecision.create({
      data: { disputeId: id, outcome: "withdrawn", refundPaise: 0n, releasePaise: 0n, faultBusinessId: null, decidedBy: "auto", briefId: brief?.id ?? null, followedRecommendation: false, rationale: "Withdrawn by the party that opened it." },
    });
    await emit(tx, "DisputeResolved", { type: "dispute", id }, { disputeId: id, orderId: d.orderId, outcome: "withdrawn", refundPaise: 0, releasePaise: 0, decidedBy: "auto", faultBusinessId: null });
    return { d, briefId: brief?.aiDecisionId ?? null, recommended: (brief?.recommendedOutcome as "buyer_favour" | "seller_favour" | "split" | undefined) ?? null };
  });
  await logOutcomeLabel({ disputeId: id, briefDecisionId: resolved.briefId, recommended: resolved.recommended, final: "withdrawn", decidedBy: "auto", faultRole: null, type: pre.type, refundPaise: 0, releasePaise: 0 });
}

/** Either party can escalate an auto-resolution to a human while the escalation window is open (ADR-013). */
export async function escalateDispute(actor: Actor, id: string): Promise<void> {
  requireEnabled();
  await loadForParty(actor, id);
  await prisma.$transaction(async (tx) => {
    await lockDispute(tx, id);
    const d = await tx.dispute.findUniqueOrThrow({ where: { id } });
    if (status(d) !== "auto_resolved") throw new DomainError("conflict", "Only a case with a proposed automatic resolution can be escalated.", undefined, "disputes.onlyCaseProposedAutomaticResolution");
    if (!d.escalationDeadline || d.escalationDeadline.getTime() < Date.now()) throw new DomainError("conflict", "The window to escalate this decision has closed.", undefined, "disputes.windowEscalateDecisionClosed");
    assertTransition("auto_resolved", "awaiting_adjudication");
    await tx.dispute.update({ where: { id }, data: { status: "awaiting_adjudication", escalatedAt: new Date(), escalatedByBusinessId: actor.businessId } });
    await emit(tx, "DisputeEscalated", { type: "dispute", id }, { disputeId: id, orderId: d.orderId, byBusinessId: actor.businessId });
  });
}

/** Appeal route (published policy): a party may ask for a second human review within APPEAL_WINDOW_DAYS of a decision. */
export async function appealDecision(actor: Actor, id: string, reason: string): Promise<AppealView> {
  requireEnabled();
  const text = reason.trim();
  if (text.length < 10 || text.length > 2000) throw new DomainError("validation", "Explain why you are appealing (10 to 2000 characters).");
  await loadForParty(actor, id);
  try {
    const a = await prisma.$transaction(async (tx) => {
      await lockDispute(tx, id);
      const d = await tx.dispute.findUniqueOrThrow({ where: { id }, include: { decision: true } });
      if (status(d) !== "resolved" || !d.decision || d.decision.outcome === "withdrawn") throw new DomainError("conflict", "Only a decided dispute can be appealed.");
      if (!d.resolvedAt || Date.now() - d.resolvedAt.getTime() > APPEAL_WINDOW_DAYS * DAY_MS) throw new DomainError("conflict", `Appeals must be made within ${APPEAL_WINDOW_DAYS} days of the decision.`, undefined, "disputes.appealsMustMadeWithinDays", { appealWindowDays: APPEAL_WINDOW_DAYS });
      return tx.disputeAppeal.create({ data: { disputeId: id, byBusinessId: actor.businessId, byPersonId: actor.personId, reason: text } });
    });
    return appealView(a);
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError("conflict", "You have already appealed this decision.");
    throw err;
  }
}

/** Party -> staff message (the other party never sees it). */
export async function postDisputeMessage(actor: Actor, id: string, body: string): Promise<MessageView> {
  requireEnabled();
  const text = body.trim();
  if (!text || text.length > 2000) throw new DomainError("validation", "Write a message of up to 2000 characters.");
  const { role } = await loadForParty(actor, id);
  const m = await prisma.disputeMessage.create({ data: { disputeId: id, partyBusinessId: actor.businessId, authorType: role, authorPersonId: actor.personId, body: text } });
  return { id: m.id, authorType: role, mine: true, body: m.body, createdAt: m.createdAt.toISOString() };
}

// ------------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------------
export const appealView = (a: { id: string; status: string; reason: string; resolutionNote: string | null; createdAt: Date; decidedAt: Date | null }): AppealView => ({
  id: a.id, status: a.status as AppealView["status"], reason: a.reason, resolutionNote: a.resolutionNote, createdAt: a.createdAt.toISOString(), decidedAt: a.decidedAt?.toISOString() ?? null,
});

async function viewOf(d: Dispute, role: "buyer" | "seller", businessId: string): Promise<DisputeView> {
  const [evidence, messages, decision, appeal] = await Promise.all([
    prisma.disputeEvidence.findMany({ where: { disputeId: d.id }, orderBy: { createdAt: "asc" } }),
    prisma.disputeMessage.findMany({ where: { disputeId: d.id, partyBusinessId: businessId }, orderBy: { createdAt: "asc" } }),
    prisma.disputeDecision.findUnique({ where: { disputeId: d.id } }),
    prisma.disputeAppeal.findUnique({ where: { disputeId_byBusinessId: { disputeId: d.id, byBusinessId: businessId } } }),
  ]);
  const st = status(d);
  const now = Date.now();
  const openedByMe = d.openedByBusinessId === businessId;
  const decisionView: DecisionView | null = decision && {
    outcome: decision.outcome, refundPaise: Number(decision.refundPaise), releasePaise: Number(decision.releasePaise), decidedBy: decision.decidedBy as "auto" | "staff",
    rationale: decision.rationale, faultBusinessId: decision.faultBusinessId, createdAt: decision.createdAt.toISOString(),
  };
  const proposal: ProposalView | null = st === "auto_resolved" && d.proposedOutcome && d.escalationDeadline && d.proposedOutcome !== "withdrawn"
    ? { outcome: d.proposedOutcome, refundPaise: Number(d.proposedRefundPaise ?? 0n), releasePaise: Number(d.proposedReleasePaise ?? 0n), escalationDeadline: d.escalationDeadline.toISOString() }
    : null;
  return {
    id: d.id, orderId: d.orderId, status: st, type: d.type, role, openedByMe,
    counterpartyBusinessId: openedByMe ? d.againstBusinessId : d.openedByBusinessId,
    description: d.description, language: d.language, amountPaise: num(d.amountPaise), atStakePaise: Number(d.atStakePaise),
    createdAt: d.createdAt.toISOString(), dueAt: d.dueAt.toISOString(), responseDueAt: d.responseDueAt.toISOString(),
    counterpartyRespondedAt: d.counterpartyRespondedAt?.toISOString() ?? null, resolvedAt: d.resolvedAt?.toISOString() ?? null,
    proposal, decision: decisionView,
    evidence: evidence.map((e) => toEvidenceView(e, businessId)),
    messages: messages.map((m) => ({ id: m.id, authorType: m.authorType as MessageView["authorType"], mine: m.authorType !== "staff" && m.authorType !== "system", body: m.body, createdAt: m.createdAt.toISOString() })),
    appeal: appeal ? appealView(appeal) : null,
    can: {
      respond: !openedByMe && d.counterpartyRespondedAt === null && EVIDENCE_OPEN_STATUSES.includes(st),
      addEvidence: EVIDENCE_OPEN_STATUSES.includes(st),
      escalate: st === "auto_resolved" && !!d.escalationDeadline && d.escalationDeadline.getTime() >= now,
      appeal: st === "resolved" && !!decision && decision.outcome !== "withdrawn" && !appeal && !!d.resolvedAt && now - d.resolvedAt.getTime() <= APPEAL_WINDOW_DAYS * DAY_MS,
      withdraw: openedByMe && isActive(st),
      message: true,
    },
  };
}

export async function getDispute(actor: Actor, id: string): Promise<DisputeView | null> {
  if (!UUID.test(id)) return null;
  const d = await prisma.dispute.findUnique({ where: { id } });
  const role = d ? roleOf(d, actor.businessId) : null;
  if (!d || !role) return null;
  return viewOf(d, role, actor.businessId);
}

/** The most recent dispute on this order the actor is party to (drives the "Report a problem" / "View dispute" mount). */
export async function getDisputeForOrder(actor: Actor, orderId: string): Promise<DisputeSummary | null> {
  if (!UUID.test(orderId)) return null;
  const d = await prisma.dispute.findFirst({
    where: { orderId, OR: [{ openedByBusinessId: actor.businessId }, { againstBusinessId: actor.businessId }] },
    orderBy: { createdAt: "desc" },
  });
  return d ? summary(d, actor.businessId) : null;
}

export async function listDisputes(actor: Actor, opts: { limit?: number } = {}): Promise<DisputeSummary[]> {
  const rows = await prisma.dispute.findMany({
    where: { OR: [{ openedByBusinessId: actor.businessId }, { againstBusinessId: actor.businessId }] },
    orderBy: { createdAt: "desc" }, take: Math.max(1, Math.min(opts.limit ?? 50, 200)),
  });
  return rows.map((d) => summary(d, actor.businessId));
}

function summary(d: Dispute, businessId: string): DisputeSummary {
  const role = roleOf(d, businessId)!;
  const st = status(d);
  const openedByMe = d.openedByBusinessId === businessId;
  return {
    id: d.id, orderId: d.orderId, status: st, type: d.type, role, openedByMe, amountPaise: num(d.amountPaise),
    createdAt: d.createdAt.toISOString(), dueAt: d.dueAt.toISOString(), resolvedAt: d.resolvedAt?.toISOString() ?? null,
    needsMyAction: (!openedByMe && d.counterpartyRespondedAt === null && EVIDENCE_OPEN_STATUSES.includes(st)) || (st === "auto_resolved" && !!d.escalationDeadline),
  };
}

/** Streams an evidence file to a party (route handlers use this; non-parties get null). */
export async function readEvidenceFileForParty(actor: Actor, disputeId: string, evidenceId: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const d = UUID.test(disputeId) ? await prisma.dispute.findUnique({ where: { id: disputeId } }) : null;
  if (!d || !roleOf(d, actor.businessId) || !UUID.test(evidenceId)) return null;
  const e = await prisma.disputeEvidence.findFirst({ where: { id: evidenceId, disputeId } });
  if (!e?.mediaKey || e.purgedAt) return null;
  return evidenceStore().get(e.mediaKey);
}

// Internal agents (ADR-020): recurring buyer mandates post enquiries on schedule and negotiate with matched sellers' quoting agents.
// Where a matched seller has no agent, nothing happens here: the lead simply follows the normal human quote flow.
import { DomainError } from "@cnote/core";
import { prisma, type AgentMandate } from "@cnote/db";
import * as enquiry from "@cnote/enquiry";
import { isA2aEnabled, isUuid, json, logActivity, num, type Actor } from "./common";
import { findCounterpartyMandate, loadState, sendNegotiationMessage, startNegotiation } from "./negotiation";
import { buyerAgentMove, sellerAgentMove, type AgentAction, type Side } from "./protocol";
import { assertNotSuspended } from "./safety";

/** The internal agent's next protocol message for a negotiation, or null when it is not an internal agent's turn. Pure given the row. */
export async function nextAgentAction(negotiationId: string, now = new Date()): Promise<{ side: Side; action: AgentAction; key: string } | null> {
  const { n, state, priv } = await loadState(negotiationId);
  if (n.status !== "open" || !n.turn) return null;
  const side = n.turn;
  if ((side === "buyer" ? n.buyerDriver : n.sellerDriver) !== "internal") return null;
  const action = side === "buyer" ? buyerAgentMove(state, priv, now) : sellerAgentMove(state, priv, now);
  return { side, action, key: `agent-r${n.round}` };
}

/**
 * Lets internal agents act until it is an external agent's turn, the negotiation closes, or it needs a person (agreed). Bounded loop;
 * every move is a real protocol message (bounds enforced server-side like any other sender). Safe to run twice: keys are per round.
 */
export async function advanceNegotiation(negotiationId: string, now = new Date()): Promise<number> {
  if (!isA2aEnabled() || !isUuid(negotiationId)) return 0;
  let sent = 0;
  for (let i = 0; i < 40; i++) {
    const next = await nextAgentAction(negotiationId, now);
    if (!next) break;
    const { n } = await loadState(negotiationId);
    const businessId = next.side === "buyer" ? n.buyerBusinessId : n.sellerBusinessId;
    const mandate = await prisma.agentMandate.findUnique({ where: { id: next.side === "buyer" ? n.buyerMandateId : n.sellerMandateId } });
    if (!mandate || !["active", "paused"].includes(mandate.status) || mandate.status === "paused") break; // paused: the agent waits
    const actor: Actor = { personId: mandate.createdByPersonId, businessId };
    const a = next.action;
    const msg = a.type === "offer" || a.type === "counter" ? { type: a.type, offer: a.offer } : { type: a.type };
    try {
      await sendNegotiationMessage(actor, negotiationId, msg, { idempotencyKey: next.key, via: { kind: "internal_agent" }, now });
      sent++;
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      // The agent's own move was refused (its mandate changed under it, or a suspension): step back honestly rather than loop.
      if (e.code === "rate_limited") break;
      if (["validation", "conflict"].includes(e.code)) {
        const wd = await sendNegotiationMessage(actor, negotiationId, { type: "withdraw" }, { idempotencyKey: `${next.key}-stop`, via: { kind: "internal_agent" }, now }).catch(() => null);
        void wd;
      }
      break;
    }
  }
  return sent;
}

/** Sweep: open negotiations whose turn belongs to an internal agent but that have been idle a while (a lost job never strands one). */
export async function sweepStalled(now = new Date(), idleMs = 30_000): Promise<number> {
  if (!isA2aEnabled()) return 0;
  const rows = await prisma.agentNegotiation.findMany({ where: { status: "open", turn: { not: null }, updatedAt: { lt: new Date(now.getTime() - idleMs) }, expiresAt: { gt: now } }, take: 100 });
  let n = 0;
  for (const r of rows) {
    if ((r.turn === "buyer" ? r.buyerDriver : r.sellerDriver) !== "internal") continue;
    n += (await advanceNegotiation(r.id, now)) > 0 ? 1 : 0;
  }
  return n;
}

// ---------------------------------------------------------------- recurring buyer mandates
export interface RunResult { mandateId: string; enquiryId: string | null; negotiations: number; fallbackSellers: number; skipped?: string }

/** Starts negotiations for an enquiry's offered matches where the seller has a compatible quoting agent; the rest keep the human flow. */
export async function startNegotiationsForEnquiry(mandate: AgentMandate, enquiryId: string): Promise<{ started: number; fallback: number }> {
  const buyer: Actor = { personId: mandate.createdByPersonId, businessId: mandate.businessId };
  const view = await enquiry.getBuyerEnquiry(mandate.businessId, enquiryId);
  const approved = (mandate.approvedSellerIds ?? []) as string[];
  let started = 0;
  let fallback = 0;
  for (const m of view?.matches ?? []) {
    if (m.status !== "offered") continue;
    const hasAgent = !!(await findCounterpartyMandate(m.sellerBusinessId, "seller", mandate.categorySlug));
    if ((approved.length && !approved.includes(m.sellerBusinessId)) || !hasAgent) {
      fallback++;
      continue;
    }
    try {
      await startNegotiation(buyer, { mandateId: mandate.id, matchId: m.id }, { kind: "internal_agent" });
      started++;
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      fallback++;
      await logActivity({ principalBusinessId: mandate.businessId, principalSide: "buyer", action: "start_skipped", mandateId: mandate.id, summary: `Your agent did not negotiate with ${m.sellerName}: ${e.message}`, details: { matchId: m.id } });
    }
  }
  return { started, fallback };
}

/** One scheduled run of a buyer mandate: post the enquiry as the buyer, then negotiate. Idempotent per (mandate, scheduled time). */
export async function runMandate(mandateId: string, now = new Date()): Promise<RunResult> {
  const m = await prisma.agentMandate.findUnique({ where: { id: mandateId } });
  if (!m || m.side !== "buyer") throw new DomainError("not_found", "Mandate not found", undefined, "agents.mandateNotFound");
  const res: RunResult = { mandateId, enquiryId: null, negotiations: 0, fallbackSellers: 0 };
  if (m.status !== "active" || !m.nextRunAt || m.nextRunAt.getTime() > now.getTime()) return { ...res, skipped: "not due" };
  if (m.expiresAt && m.expiresAt.getTime() <= now.getTime()) return { ...res, skipped: "expired" };
  const runKey = m.nextRunAt.toISOString();
  try {
    await prisma.agentRun.create({ data: { mandateId: m.id, runKey } });
  } catch {
    return { ...res, skipped: "already ran" }; // unique (mandate, runKey): a retried tick never posts twice
  }
  const buyer: Actor = { personId: m.createdByPersonId, businessId: m.businessId };
  const spec = (m.spec ?? {}) as Record<string, string | null>;
  let enquiryId: string | null = null;
  let detail = "";
  try {
    await assertNotSuspended({ businessId: m.businessId, mandateIds: [m.id] });
    const e = await enquiry.createEnquiry(buyer, {
      title: spec.title ?? m.name, requirement: spec.requirement ?? m.name, categorySlug: m.categorySlug, quantity: m.quantity, quantityUnit: m.unit, targetPricePaise: num(m.targetPricePaise),
      deliveryCity: spec.deliveryCity ?? null, deliveryPincode: spec.deliveryPincode ?? null,
      neededBy: m.maxLeadTimeDays ? new Date(now.getTime() + m.maxLeadTimeDays * 86_400_000).toISOString().slice(0, 10) : null,
    });
    enquiryId = e.id;
    const r = await startNegotiationsForEnquiry(m, e.id);
    res.negotiations = r.started;
    res.fallbackSellers = r.fallback;
    detail = `posted the requirement, ${r.started} agent negotiation(s) started, ${r.fallback} seller(s) will answer through the normal quote flow`;
    await logActivity({ principalBusinessId: m.businessId, principalSide: "buyer", action: "run_started", mandateId: m.id, summary: `Your agent ${detail}.`, details: { enquiryId: e.id } });
  } catch (e) {
    detail = e instanceof DomainError ? e.message : "unexpected error";
    await logActivity({ principalBusinessId: m.businessId, principalSide: "buyer", action: "run_failed", mandateId: m.id, summary: `The scheduled run could not post your requirement: ${detail}` });
    if (!(e instanceof DomainError)) console.error("a2a run failed", mandateId, e);
  }
  res.enquiryId = enquiryId;
  // Advance the schedule whatever happened: a failing run must not retry every tick.
  const next = m.recurrenceDays ? new Date(m.nextRunAt.getTime() + m.recurrenceDays * 86_400_000) : null;
  let nextRunAt = next;
  while (nextRunAt && nextRunAt.getTime() <= now.getTime()) nextRunAt = new Date(nextRunAt.getTime() + (m.recurrenceDays as number) * 86_400_000);
  await prisma.$transaction(async (tx) => {
    await tx.agentRun.update({ where: { mandateId_runKey: { mandateId: m.id, runKey } }, data: { enquiryId, outcome: enquiryId ? "posted" : "failed", detail: detail.slice(0, 300) } });
    const u = await tx.agentMandate.update({ where: { id: m.id }, data: { lastRunAt: now, nextRunAt, status: nextRunAt ? "active" : "completed", version: { increment: 1 } } });
    await tx.agentMandateChange.create({ data: { mandateId: m.id, businessId: m.businessId, version: u.version, action: nextRunAt ? "run" : "completed", actorKind: "system", snapshot: json({ enquiryId, runKey }) } });
  });
  return res;
}

/** Job: run every due buyer mandate. Returns the runs made. */
export async function runDueMandates(now = new Date()): Promise<RunResult[]> {
  if (!isA2aEnabled()) return [];
  const due = await prisma.agentMandate.findMany({ where: { side: "buyer", status: "active", nextRunAt: { lte: now } }, orderBy: { nextRunAt: "asc" }, take: 50 });
  const out: RunResult[] = [];
  for (const m of due) {
    try {
      out.push(await runMandate(m.id, now));
    } catch (e) {
      console.error("a2a mandate run failed", m.id, e);
    }
  }
  return out;
}

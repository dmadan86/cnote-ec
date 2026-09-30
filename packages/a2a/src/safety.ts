// Safety rails (ADR-020): suspension, per-business and per-key rate limits, anomaly flags. Nothing here reveals the other side's bounds.
import { DomainError, emit, rateLimit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { createHash } from "node:crypto";
import { json, limits, logActivity } from "./common";
import type { Side } from "./protocol";

export interface SuspensionView { id: string; kind: string; targetId: string; businessId: string | null; reason: string; suspendedBy: string; createdAt: string; liftedAt: string | null }
const toView = (s: { id: string; kind: string; targetId: string; businessId: string | null; reason: string; suspendedBy: string; createdAt: Date; liftedAt: Date | null }): SuspensionView => ({
  id: s.id, kind: s.kind, targetId: s.targetId, businessId: s.businessId, reason: s.reason, suspendedBy: s.suspendedBy, createdAt: s.createdAt.toISOString(), liftedAt: s.liftedAt?.toISOString() ?? null,
});

/** Throws `forbidden` when the business, one of the mandates, or the API key is suspended. The message is the same for all three (no probing). */
export async function assertNotSuspended(t: { businessId: string; mandateIds?: (string | null | undefined)[]; apiKeyId?: string | null }): Promise<void> {
  const ors: { kind: string; targetId: string }[] = [{ kind: "business", targetId: t.businessId }];
  for (const m of t.mandateIds ?? []) if (m) ors.push({ kind: "mandate", targetId: m });
  if (t.apiKeyId) ors.push({ kind: "api_key", targetId: t.apiKeyId });
  const hit = await prisma.agentSuspension.findFirst({ where: { liftedAt: null, OR: ors }, select: { id: true } });
  if (hit) throw new DomainError("forbidden", "Agent activity is suspended for this account or key. Contact support.");
}

/** Per-business and per-key fixed-window limits on protocol messages. */
export async function assertWithinRates(businessId: string, apiKeyId?: string | null): Promise<void> {
  if (!(await rateLimit(`a2a:biz:${businessId}`, limits.businessMessagesPerMin(), 60))) throw new DomainError("rate_limited", "Your agents are sending messages too fast. Slow down and retry shortly.", { retryAfterSeconds: 60 });
  if (apiKeyId && !(await rateLimit(`a2a:key:${apiKeyId}`, limits.keyMessagesPerMin(), 60))) throw new DomainError("rate_limited", "This API key is sending messages too fast. Slow down and retry shortly.", { retryAfterSeconds: 60 });
}
export async function assertCanStart(businessId: string): Promise<void> {
  if (!(await rateLimit(`a2a:start:${businessId}`, limits.startsPerHour(), 3600))) throw new DomainError("rate_limited", "Too many negotiations started this hour.", { retryAfterSeconds: 3600 }, "agents.tooManyNegotiationsStartedHour");
}

export async function recordAnomaly(a: { businessId: string; side: Side; negotiationId?: string | null; apiKeyId?: string | null; kind: string; details?: Record<string, unknown> }): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.agentAnomaly.create({ data: { businessId: a.businessId, negotiationId: a.negotiationId ?? null, apiKeyId: a.apiKeyId ?? null, kind: a.kind, details: json(a.details ?? {}) } });
    if (a.negotiationId) await tx.agentNegotiation.update({ where: { id: a.negotiationId }, data: { flagged: true } });
    await logActivity({ principalBusinessId: a.businessId, principalSide: a.side, action: "anomaly_flagged", negotiationId: a.negotiationId ?? null, summary: `Unusual agent behaviour was flagged (${a.kind.replaceAll("_", " ")}). Support may review it.`, details: { kind: a.kind } }, tx);
  });
}

/**
 * Rapid identical messages: the 3rd identical message in 60s is flagged, the 6th is refused. Out-of-bounds attempts: the 5th within 10
 * minutes is flagged. Returns normally unless refused. (Replays with the same idempotency key never reach here.)
 */
export async function guardBehaviour(kind: "message" | "out_of_bounds", ctx: { businessId: string; side: Side; negotiationId: string; apiKeyId?: string | null; fingerprint?: string }): Promise<void> {
  if (kind === "out_of_bounds") {
    if (!(await rateLimit(`a2a:oob:${ctx.businessId}`, 4, 600))) await recordAnomaly({ ...ctx, kind: "repeated_out_of_bounds" });
    return;
  }
  const h = createHash("sha1").update(`${ctx.negotiationId}|${ctx.fingerprint ?? ""}`).digest("hex").slice(0, 20);
  if (!(await rateLimit(`a2a:ident:${h}`, 2, 60))) await recordAnomaly({ ...ctx, kind: "rapid_identical_offers" });
  if (!(await rateLimit(`a2a:identhard:${h}`, 5, 60))) throw new DomainError("rate_limited", "Identical messages are being repeated too fast. Stop retrying the same message.", { retryAfterSeconds: 60 });
}

// ------------------------------------------------------------ admin: suspend / lift / list
export type SuspensionKind = "mandate" | "business" | "api_key";

/** Suspends a mandate, a business's agents or one API key. Callers (admin app) wrap this in `audited()`. Mandate suspension also withdraws its open negotiations. */
export async function suspend(input: { kind: SuspensionKind; targetId: string; reason: string; by: string }): Promise<SuspensionView> {
  const reason = input.reason.trim();
  if (reason.length < 5) throw new DomainError("validation", "Give a reason (5+ characters).");
  let businessId: string | null = input.kind === "business" ? input.targetId : null;
  if (input.kind === "mandate") {
    const m = await prisma.agentMandate.findUnique({ where: { id: input.targetId } }).catch(() => null);
    if (!m) throw new DomainError("not_found", "Mandate not found", undefined, "agents.mandateNotFound");
    businessId = m.businessId;
  }
  const existing = await prisma.agentSuspension.findFirst({ where: { kind: input.kind, targetId: input.targetId, liftedAt: null } });
  if (existing) return toView(existing);
  const row = await prisma.$transaction(async (tx) => {
    const s = await tx.agentSuspension.create({ data: { kind: input.kind, targetId: input.targetId, businessId, reason: reason.slice(0, 500), suspendedBy: input.by } });
    if (input.kind === "mandate") {
      const m = await tx.agentMandate.update({ where: { id: input.targetId }, data: { status: "suspended", version: { increment: 1 }, autoAccept: false } });
      await tx.agentMandateChange.create({ data: { mandateId: m.id, businessId: m.businessId, version: m.version, action: "suspended", actorKind: "admin", snapshot: json({ reason }) } });
      await logActivity({ principalBusinessId: m.businessId, principalSide: m.side, action: "mandate_suspended", mandateId: m.id, summary: `Support suspended the mandate "${m.name}".`, details: { reason } }, tx);
      await emit(tx, "AgentMandateSuspended", { type: "agent_mandate", id: m.id }, { businessId: m.businessId, mandateId: m.id, side: m.side, scope: "mandate" });
    } else if (businessId) {
      await emit(tx, "AgentMandateSuspended", { type: "business", id: businessId }, { businessId, mandateId: null, side: null, scope: "business" });
    }
    return s;
  });
  const { withdrawOpenNegotiations } = await import("./negotiation");
  if (input.kind === "mandate") await withdrawOpenNegotiations({ mandateId: input.targetId }, "The mandate was suspended.", { personId: null });
  if (input.kind === "business") await withdrawOpenNegotiations({ businessId: input.targetId }, "Agent activity was suspended.", { personId: null });
  return toView(row);
}

export async function liftSuspension(id: string, by: string): Promise<SuspensionView> {
  const s = /^[0-9a-f-]{36}$/i.test(id) ? await prisma.agentSuspension.findUnique({ where: { id } }) : null;
  if (!s) throw new DomainError("not_found", "Suspension not found");
  if (s.liftedAt) return toView(s);
  const row = await prisma.$transaction(async (tx) => {
    const u = await tx.agentSuspension.update({ where: { id }, data: { liftedAt: new Date() } });
    if (s.kind === "mandate") {
      // back to paused: the owner decides when to resume
      const m = await tx.agentMandate.updateMany({ where: { id: s.targetId, status: "suspended" }, data: { status: "paused", version: { increment: 1 } } });
      if (m.count) {
        const mm = await tx.agentMandate.findUniqueOrThrow({ where: { id: s.targetId } });
        await tx.agentMandateChange.create({ data: { mandateId: mm.id, businessId: mm.businessId, version: mm.version, action: "unsuspended", actorKind: "admin", snapshot: json({ by }) } });
        await logActivity({ principalBusinessId: mm.businessId, principalSide: mm.side, action: "mandate_unsuspended", mandateId: mm.id, summary: `Support lifted the suspension on "${mm.name}". It is paused: resume it when you are ready.` }, tx);
      }
    }
    return u;
  });
  return toView(row);
}

export async function listSuspensions(opts: { activeOnly?: boolean; limit?: number } = {}): Promise<SuspensionView[]> {
  const rows = await prisma.agentSuspension.findMany({ where: opts.activeOnly ? { liftedAt: null } : {}, orderBy: { createdAt: "desc" }, take: Math.min(opts.limit ?? 100, 500) });
  return rows.map(toView);
}

export interface AnomalyView { id: string; businessId: string; negotiationId: string | null; apiKeyId: string | null; kind: string; details: Record<string, unknown>; createdAt: string }
export async function listAnomalies(opts: { businessId?: string; limit?: number } = {}): Promise<AnomalyView[]> {
  const rows = await prisma.agentAnomaly.findMany({ where: opts.businessId ? { businessId: opts.businessId } : {}, orderBy: { createdAt: "desc" }, take: Math.min(opts.limit ?? 100, 500) });
  return rows.map((a) => ({ id: a.id, businessId: a.businessId, negotiationId: a.negotiationId, apiKeyId: a.apiKeyId, kind: a.kind, details: (a.details ?? {}) as Record<string, unknown>, createdAt: a.createdAt.toISOString() }));
}

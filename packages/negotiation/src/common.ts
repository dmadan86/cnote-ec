import { prisma, type DbClient } from "@cnote/db";
import type { Prisma } from "@cnote/db";

export interface Actor { personId: string; businessId: string }

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";
export const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Feature flag QUOTE_ASSIST_ENABLED (default off), read per call so ops/tests can flip it. */
export function isQuoteAssistEnabled(): boolean {
  const v = (process.env.QUOTE_ASSIST_ENABLED ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

export const num = (v: bigint | null | undefined): number | null => (v == null ? null : Number(v));
export const dateOnly = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
export const json = (v: unknown) => v as Prisma.InputJsonValue;

export type AgentAction =
  | "draft_generated" | "draft_bounds_rejected" | "draft_approved" | "draft_discarded" | "draft_failed"
  | "quotes_normalised" | "counter_proposed" | "counter_bounds_rejected" | "counter_sent" | "counter_discarded";

export interface AgentActionInput {
  principalBusinessId: string;
  principalRole: "seller" | "buyer";
  action: AgentAction;
  subjectType: "match" | "enquiry" | "quote_draft" | "counter_proposal" | "quote";
  subjectId: string;
  enquiryId?: string | null;
  summary: string;
  details?: Record<string, unknown>;
  /** the human who confirmed (approve/send/discard); omitted when the agent acted on its own */
  actorPersonId?: string | null;
  aiDecisionId?: string | null;
}

/** Append-only. Pass the caller's tx so the log row commits with the state change (ADR-007). */
export async function logAgentAction(input: AgentActionInput, db: DbClient = prisma): Promise<void> {
  await db.agentActionLog.create({
    data: {
      principalBusinessId: input.principalBusinessId, principalRole: input.principalRole, action: input.action,
      subjectType: input.subjectType, subjectId: input.subjectId, enquiryId: input.enquiryId ?? null, summary: input.summary.slice(0, 500),
      details: json(input.details ?? {}), actorPersonId: input.actorPersonId ?? null, aiDecisionId: input.aiDecisionId ?? null,
    },
  });
}

export interface AgentActionView {
  id: string;
  action: AgentAction;
  summary: string;
  details: Record<string, unknown>;
  subjectType: string;
  subjectId: string;
  enquiryId: string | null;
  /** true when the assistant acted alone (drafting/proposing); false when a person confirmed */
  byAssistant: boolean;
  createdAt: string;
}

/** "What the assistant did": everything logged for this business, newest first. Scoped to the principal. */
export async function listAgentActions(
  principalBusinessId: string,
  opts: { limit?: number; enquiryId?: string; subjectId?: string; role?: "seller" | "buyer" } = {},
): Promise<AgentActionView[]> {
  const rows = await prisma.agentActionLog.findMany({
    where: {
      principalBusinessId,
      ...(opts.role ? { principalRole: opts.role } : {}),
      ...(opts.enquiryId && isUuid(opts.enquiryId) ? { enquiryId: opts.enquiryId } : {}),
      ...(opts.subjectId && isUuid(opts.subjectId) ? { subjectId: opts.subjectId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(opts.limit ?? 50, 200)),
  });
  return rows.map((r) => ({
    id: r.id, action: r.action as AgentAction, summary: r.summary, details: (r.details ?? {}) as Record<string, unknown>,
    subjectType: r.subjectType, subjectId: r.subjectId, enquiryId: r.enquiryId, byAssistant: r.actorPersonId === null, createdAt: r.createdAt.toISOString(),
  }));
}

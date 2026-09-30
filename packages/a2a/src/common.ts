import { DomainError } from "@cnote/core";
import { prisma, type DbClient, type Prisma } from "@cnote/db";
import type { Side } from "./protocol";

export interface Actor { personId: string; businessId: string }
/** How a message/change reached us: a person in the UI, an internal agent, or a third-party agent through an API key. */
export interface Via { kind: "human" | "internal_agent" | "external_agent" | "system" | "admin"; apiKeyId?: string | null }

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";
export { isUuid } from "./protocol";

/** Feature flag A2A_ENABLED (default off), read per call so ops/tests can flip it. Mandate CRUD works regardless; agents only act when on. */
export function isA2aEnabled(): boolean {
  const v = (process.env.A2A_ENABLED ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}
export function requireEnabled(): void {
  if (!isA2aEnabled()) throw new DomainError("conflict", "Agent-to-agent commerce is not enabled yet.", undefined, "agents.agentAgentCommerceNotEnabled");
}

const intEnv = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
export const limits = {
  /** messages per business per minute (all agents of that business, internal and external) */
  businessMessagesPerMin: () => intEnv("A2A_BUSINESS_MSGS_PER_MIN", 120),
  /** messages per API key per minute */
  keyMessagesPerMin: () => intEnv("A2A_KEY_MSGS_PER_MIN", 60),
  /** negotiations a business can start per hour */
  startsPerHour: () => intEnv("A2A_STARTS_PER_HOUR", 30),
  /** how long a negotiation may stay open, hours */
  negotiationTtlHours: () => intEnv("A2A_NEGOTIATION_TTL_HOURS", 24),
  /** how long the principals have to confirm once agreed, hours */
  confirmTtlHours: () => intEnv("A2A_CONFIRM_TTL_HOURS", 48),
};

export const num = (v: bigint | null | undefined): number | null => (v == null ? null : Number(v));
export const json = (v: unknown) => v as Prisma.InputJsonValue;
export const big = (v: number | null | undefined): bigint | null => (v == null ? null : BigInt(v));

export type ActivityAction =
  | "mandate_created" | "mandate_updated" | "mandate_paused" | "mandate_resumed" | "mandate_revoked" | "mandate_expired" | "mandate_suspended" | "mandate_unsuspended"
  | "auto_accept_on" | "auto_accept_off"
  | "run_started" | "run_failed" | "negotiation_started" | "offer_sent" | "counter_sent" | "accepted" | "rejected" | "withdrawn" | "expired"
  | "awaiting_confirmation" | "confirmed" | "confirmed_auto" | "declined" | "quote_sent" | "order_recorded" | "realise_failed" | "anomaly_flagged" | "start_skipped";

export interface ActivityInput {
  principalBusinessId: string;
  principalSide: Side;
  action: ActivityAction;
  summary: string;
  mandateId?: string | null;
  negotiationId?: string | null;
  details?: Record<string, unknown>;
  /** the human who did/confirmed it; omit when the agent acted on its own */
  actorPersonId?: string | null;
}

/** Append-only. Pass the caller's tx so the row commits with the state change. */
export async function logActivity(i: ActivityInput, db: DbClient = prisma): Promise<void> {
  await db.agentActivity.create({
    data: {
      principalBusinessId: i.principalBusinessId, principalSide: i.principalSide, action: i.action, mandateId: i.mandateId ?? null, negotiationId: i.negotiationId ?? null,
      summary: i.summary.slice(0, 500), details: json(i.details ?? {}), actorPersonId: i.actorPersonId ?? null,
    },
  });
}

export interface ActivityView {
  id: string;
  action: string;
  summary: string;
  details: Record<string, unknown>;
  mandateId: string | null;
  negotiationId: string | null;
  /** true when the agent acted alone; false when a person did or confirmed */
  byAgent: boolean;
  createdAt: string;
}

/** "What my agent did": everything logged for this business, newest first. Scoped to the principal. */
export async function listActivity(businessId: string, opts: { limit?: number; negotiationId?: string; mandateId?: string; side?: Side } = {}): Promise<ActivityView[]> {
  const ok = (s?: string) => (s && /^[0-9a-f-]{36}$/i.test(s) ? s : undefined);
  const rows = await prisma.agentActivity.findMany({
    where: {
      principalBusinessId: businessId,
      ...(opts.side ? { principalSide: opts.side } : {}),
      ...(ok(opts.negotiationId) ? { negotiationId: ok(opts.negotiationId) } : {}),
      ...(ok(opts.mandateId) ? { mandateId: ok(opts.mandateId) } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(opts.limit ?? 50, 200)),
  });
  return rows.map((r) => ({
    id: r.id, action: r.action, summary: r.summary, details: (r.details ?? {}) as Record<string, unknown>, mandateId: r.mandateId, negotiationId: r.negotiationId,
    byAgent: r.actorPersonId === null, createdAt: r.createdAt.toISOString(),
  }));
}

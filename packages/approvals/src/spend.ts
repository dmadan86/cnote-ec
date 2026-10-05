// Per-member monthly spend limits. Spend is what the member actually committed (an accepted quote, an issued PO), recorded by the
// caller through recordSpend; the month is the IST calendar month. Going over the cap never hard-blocks: it forces an admin/owner
// approval (requireApproval, reason "spend_limit"), so a legitimate purchase is never stuck, only escalated.
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { requireCapability } from "@cnote/identity";
import { teamRoles } from "./eligibility";
import { SPEND_ACTIONS, type ApprovalActionName, type SpendSummary } from "./types";

const IST_OFFSET_MS = 5.5 * 3_600_000;
const MAX_PAISE = 10_000_000_000_000; // ₹100 billion: far above any real cap, keeps BigInt/JSON conversions safe

/** [start, end) of the IST calendar month containing `now`, as UTC instants. */
export function monthBounds(now: Date): { start: Date; end: Date } {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  return { start: new Date(Date.UTC(y, m, 1) - IST_OFFSET_MS), end: new Date(Date.UTC(y, m + 1, 1) - IST_OFFSET_MS) };
}

const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

export async function getSpentPaise(businessId: string, personId: string, now = new Date()): Promise<number> {
  const { start, end } = monthBounds(now);
  const agg = await prisma.spendRecord.aggregate({ where: { businessId, personId, occurredAt: { gte: start, lt: end } }, _sum: { amountPaise: true } });
  return Number(agg._sum.amountPaise ?? 0n);
}

export async function getSpendLimitPaise(businessId: string, personId: string): Promise<number | null> {
  const r = await prisma.memberSpendLimit.findUnique({ where: { businessId_personId: { businessId, personId } }, select: { monthlyCapPaise: true } });
  return r ? Number(r.monthlyCapPaise) : null;
}

/** Owner/admin/finance set (or clear, with null) a member's monthly cap in paise. */
export async function setSpendLimit(input: { businessId: string; actorPersonId: string; personId: string; monthlyCapPaise: number | null }): Promise<void> {
  await requireCapability(input.actorPersonId, input.businessId, "spend.manage");
  const roles = await teamRoles(input.businessId);
  if (!roles.has(input.personId)) throw new DomainError("not_found", "Member not found");
  const cap = input.monthlyCapPaise;
  if (cap === null) {
    await prisma.memberSpendLimit.deleteMany({ where: { businessId: input.businessId, personId: input.personId } });
    return;
  }
  if (!Number.isInteger(cap) || cap < 0 || cap > MAX_PAISE) throw new DomainError("validation", "Enter a valid amount.");
  await prisma.memberSpendLimit.upsert({
    where: { businessId_personId: { businessId: input.businessId, personId: input.personId } },
    create: { businessId: input.businessId, personId: input.personId, monthlyCapPaise: BigInt(cap), updatedByPersonId: input.actorPersonId },
    update: { monthlyCapPaise: BigInt(cap), updatedByPersonId: input.actorPersonId },
  });
}

/** Cap and month-to-date spend for every member of the business (the team spend table). */
export async function listSpend(businessId: string, now = new Date()): Promise<SpendSummary[]> {
  const { start, end } = monthBounds(now);
  const [roles, limits, spent] = await Promise.all([
    teamRoles(businessId),
    prisma.memberSpendLimit.findMany({ where: { businessId } }),
    prisma.spendRecord.groupBy({ by: ["personId"], where: { businessId, occurredAt: { gte: start, lt: end } }, _sum: { amountPaise: true } }),
  ]);
  const cap = new Map(limits.map((l) => [l.personId, Number(l.monthlyCapPaise)]));
  const sum = new Map(spent.map((s) => [s.personId, Number(s._sum.amountPaise ?? 0n)]));
  return [...roles.entries()].map(([personId, role]) => ({ personId, role, capPaise: cap.get(personId) ?? null, spentPaise: sum.get(personId) ?? 0 }));
}

/**
 * Records money a member committed (call after the action really happened, e.g. the quote was accepted). Idempotent per subject:
 * a second call for the same subject changes nothing, so retries and event redelivery cannot double count.
 * A PO issued from an already-accepted quote should NOT record again (same money): record at the earliest committing step.
 */
export async function recordSpend(input: {
  businessId: string; personId: string; amountPaise: number; action: ApprovalActionName; subject: { type: string; id: string };
}, now = new Date()): Promise<{ recorded: boolean }> {
  if (!isUuid(input.businessId) || !isUuid(input.personId)) throw new DomainError("validation", "Invalid ids");
  if (!SPEND_ACTIONS.includes(input.action)) throw new DomainError("validation", "This action does not commit spend.");
  if (!Number.isInteger(input.amountPaise) || input.amountPaise < 0 || input.amountPaise > MAX_PAISE) throw new DomainError("validation", "Invalid amount");
  try {
    await prisma.spendRecord.create({
      data: { businessId: input.businessId, personId: input.personId, amountPaise: BigInt(input.amountPaise), action: input.action, subjectType: input.subject.type, subjectId: input.subject.id, occurredAt: now },
    });
    return { recorded: true };
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { recorded: false };
    throw e;
  }
}

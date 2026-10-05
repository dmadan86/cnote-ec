// Approval policies per buyer business: "<action> at or above ₹X needs level 1 (role/members), then level 2, up to 3 sequential levels".
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { requireCapability } from "@cnote/identity";
import { z } from "zod";
import { teamRoles } from "./eligibility";
import { APPROVAL_ACTIONS, APPROVER_ROLES, MAX_LEVELS, type ApprovalActionName, type ApproverRole, type PolicyInput, type PolicyView } from "./types";

export const MAX_POLICIES_PER_BUSINESS = 30;
const PAISE = z.number().int().min(0).max(10_000_000_000_000);

const levelSchema = z.object({
  role: z.enum(APPROVER_ROLES),
  personIds: z.array(z.uuid()).max(20).optional(),
  minAmountPaise: PAISE.optional(),
});
const policySchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1, "Give the rule a name.").max(80),
  action: z.enum(APPROVAL_ACTIONS),
  minAmountPaise: PAISE,
  enabled: z.boolean().optional(),
  levels: z.array(levelSchema).min(1, "Add at least one approval level.").max(MAX_LEVELS, `At most ${MAX_LEVELS} levels.`),
});

type Row = Awaited<ReturnType<typeof load>>[number];
const load = (businessId: string) => prisma.approvalPolicy.findMany({ where: { businessId }, include: { levels: { orderBy: { level: "asc" } } }, orderBy: [{ action: "asc" }, { minAmountPaise: "asc" }, { createdAt: "asc" }] });

const view = (p: Row): PolicyView => ({
  id: p.id,
  name: p.name,
  action: p.action as ApprovalActionName,
  minAmountPaise: Number(p.minAmountPaise),
  enabled: p.enabled,
  levels: p.levels.map((l) => ({ level: l.level, role: l.approverRole as ApproverRole, personIds: l.approverPersonIds, minAmountPaise: Number(l.minAmountPaise) })),
});

export async function listPolicies(businessId: string): Promise<PolicyView[]> {
  return (await load(businessId)).map(view);
}

/** Creates or updates a policy (owner/admin). Named approvers must be current members who may decide approvals. */
export async function savePolicy(businessId: string, actorPersonId: string, input: PolicyInput): Promise<PolicyView> {
  await requireCapability(actorPersonId, businessId, "policy.manage");
  const parsed = policySchema.safeParse(input);
  if (!parsed.success) throw new DomainError("validation", parsed.error.issues[0]?.message ?? "Invalid rule");
  const p = parsed.data;
  const roles = await teamRoles(businessId);
  for (const l of p.levels) {
    for (const id of l.personIds ?? []) if (!roles.has(id)) throw new DomainError("validation", "Choose approvers from your team.");
  }
  if (!p.id && (await prisma.approvalPolicy.count({ where: { businessId } })) >= MAX_POLICIES_PER_BUSINESS) {
    throw new DomainError("conflict", "You have reached the limit of approval rules.");
  }
  if (p.id) {
    const own = await prisma.approvalPolicy.findFirst({ where: { id: p.id, businessId }, select: { id: true } });
    if (!own) throw new DomainError("not_found", "Rule not found");
  }
  const levels = p.levels.map((l, i) => ({ level: i + 1, approverRole: l.role, approverPersonIds: [...new Set(l.personIds ?? [])], minAmountPaise: BigInt(l.minAmountPaise ?? 0) }));
  const id = await prisma.$transaction(async (tx) => {
    if (p.id) {
      await tx.approvalPolicyLevel.deleteMany({ where: { policyId: p.id } });
      await tx.approvalPolicy.update({ where: { id: p.id }, data: { name: p.name, action: p.action, minAmountPaise: BigInt(p.minAmountPaise), enabled: p.enabled ?? true, levels: { create: levels } } });
      return p.id;
    }
    const c = await tx.approvalPolicy.create({
      data: { businessId, name: p.name, action: p.action, minAmountPaise: BigInt(p.minAmountPaise), enabled: p.enabled ?? true, createdByPersonId: actorPersonId, levels: { create: levels } },
      select: { id: true },
    });
    return c.id;
  });
  const saved = (await load(businessId)).find((x) => x.id === id)!;
  return view(saved);
}

export async function setPolicyEnabled(businessId: string, actorPersonId: string, policyId: string, enabled: boolean): Promise<void> {
  await requireCapability(actorPersonId, businessId, "policy.manage");
  const r = await prisma.approvalPolicy.updateMany({ where: { id: policyId, businessId }, data: { enabled } });
  if (r.count === 0) throw new DomainError("not_found", "Rule not found");
}

/** Deleting a rule never touches requests already raised under it (their chain is a snapshot). */
export async function deletePolicy(businessId: string, actorPersonId: string, policyId: string): Promise<void> {
  await requireCapability(actorPersonId, businessId, "policy.manage");
  const r = await prisma.approvalPolicy.deleteMany({ where: { id: policyId, businessId } });
  if (r.count === 0) throw new DomainError("not_found", "Rule not found");
}

/** The enabled policy for the action whose threshold is the highest one at or below the amount (most specific wins). */
export async function matchPolicy(businessId: string, action: ApprovalActionName, amountPaise: number): Promise<PolicyView | null> {
  const row = await prisma.approvalPolicy.findFirst({
    where: { businessId, action, enabled: true, minAmountPaise: { lte: BigInt(amountPaise) } },
    include: { levels: { orderBy: { level: "asc" } } },
    orderBy: [{ minAmountPaise: "desc" }, { createdAt: "desc" }],
  });
  return row ? view(row) : null;
}

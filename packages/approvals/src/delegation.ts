// Out-of-office delegation: for a window, a named colleague may decide on an approver's behalf. The requester can never benefit
// (eligibility excludes them on either side), and every delegated decision is logged with `onBehalfOfPersonId`.
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { can, getMemberRole } from "@cnote/identity";

export interface DelegationView {
  id: string;
  delegatorPersonId: string;
  delegatePersonId: string;
  startsAt: string;
  endsAt: string;
  active: boolean;
}

const MAX_WINDOW_DAYS = 90;

export async function createDelegation(input: { businessId: string; delegatorPersonId: string; delegatePersonId: string; startsAt: Date; endsAt: Date }, now = new Date()): Promise<DelegationView> {
  const { businessId, delegatorPersonId, delegatePersonId, startsAt, endsAt } = input;
  if (delegatorPersonId === delegatePersonId) throw new DomainError("validation", "Choose a colleague.");
  const [a, b] = await Promise.all([getMemberRole(delegatorPersonId, businessId), getMemberRole(delegatePersonId, businessId)]);
  if (!a || !can(a, "approvals.decide")) throw new DomainError("forbidden", "Only approvers can delegate.");
  if (!b) throw new DomainError("validation", "Choose a member of your team.");
  if (!(startsAt < endsAt) || endsAt.getTime() <= now.getTime()) throw new DomainError("validation", "Choose a valid date range.");
  if (endsAt.getTime() - startsAt.getTime() > MAX_WINDOW_DAYS * 86_400_000) throw new DomainError("validation", "Delegation can last at most 90 days.");
  const d = await prisma.approvalDelegation.create({ data: { businessId, delegatorPersonId, delegatePersonId, startsAt, endsAt } });
  return toView(d, now);
}

export async function revokeDelegation(input: { businessId: string; actorPersonId: string; delegationId: string }, now = new Date()): Promise<void> {
  const role = await getMemberRole(input.actorPersonId, input.businessId);
  if (!role) throw new DomainError("forbidden", "Not allowed");
  const d = await prisma.approvalDelegation.findFirst({ where: { id: input.delegationId, businessId: input.businessId, revokedAt: null } });
  if (!d) throw new DomainError("not_found", "Delegation not found");
  // the delegator, or an owner/admin, may end it
  if (d.delegatorPersonId !== input.actorPersonId && !can(role, "team.manage")) throw new DomainError("forbidden", "Not allowed");
  await prisma.approvalDelegation.update({ where: { id: d.id }, data: { revokedAt: now } });
}

const toView = (d: { id: string; delegatorPersonId: string; delegatePersonId: string; startsAt: Date; endsAt: Date; revokedAt?: Date | null }, now: Date): DelegationView => ({
  id: d.id,
  delegatorPersonId: d.delegatorPersonId,
  delegatePersonId: d.delegatePersonId,
  startsAt: d.startsAt.toISOString(),
  endsAt: d.endsAt.toISOString(),
  active: !d.revokedAt && d.startsAt <= now && d.endsAt > now,
});

/** Current and upcoming delegations (ended or revoked ones are hidden). */
export async function listDelegations(businessId: string, now = new Date()): Promise<DelegationView[]> {
  const rows = await prisma.approvalDelegation.findMany({ where: { businessId, revokedAt: null, endsAt: { gt: now } }, orderBy: { startsAt: "asc" }, take: 200 });
  return rows.map((d) => toView(d, now));
}

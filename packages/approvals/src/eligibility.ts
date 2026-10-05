// Who may decide a level: pure role/membership rules plus delegation. Eligibility is computed live (not frozen at request time) so a
// removed approver or a promoted member is reflected immediately; only the chain shape (levels, roles, named members) is snapshotted.
import { can, effectiveRole, listBusinessMembers, type TeamRole } from "@cnote/identity";
import { prisma } from "@cnote/db";
import type { ApproverRole, ChainLevel } from "./types";

/** Which team roles satisfy a level that names `role`: that role or any role above it. */
const SATISFIED_BY: Record<ApproverRole, readonly TeamRole[]> = {
  owner: ["owner"],
  admin: ["owner", "admin"],
  approver: ["owner", "admin", "approver"],
  finance: ["owner", "admin", "finance"],
};

export async function teamRoles(businessId: string): Promise<Map<string, TeamRole>> {
  const rows = await listBusinessMembers(businessId);
  return new Map(rows.map((r) => [r.personId, effectiveRole(r.role)]));
}

/** Members who can decide this level directly, never including anyone in `exclude` (the requester, earlier deciders). */
export function eligibleFor(level: Pick<ChainLevel, "role" | "personIds">, roles: Map<string, TeamRole>, exclude: ReadonlySet<string>): string[] {
  if (level.personIds.length > 0) {
    const named = level.personIds.filter((id) => !exclude.has(id) && can(roles.get(id) ?? "viewer", "approvals.decide"));
    if (named.length > 0) return [...new Set(named)].sort();
    // the named members left the team or lost the right: fall back to the role so a request cannot be orphaned
  }
  const ok = SATISFIED_BY[level.role];
  return [...roles.entries()].filter(([id, r]) => ok.includes(r) && !exclude.has(id)).map(([id]) => id).sort();
}

export interface ActiveDelegation {
  delegatorPersonId: string;
  delegatePersonId: string;
}

export async function activeDelegations(businessId: string, now: Date): Promise<ActiveDelegation[]> {
  return prisma.approvalDelegation.findMany({
    where: { businessId, revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now } },
    select: { delegatorPersonId: true, delegatePersonId: true },
  });
}

/** Approvers plus the colleagues currently covering for them: everyone who should be told a level is open. */
export function withDelegates(approvers: readonly string[], delegations: readonly ActiveDelegation[], roles: Map<string, TeamRole>, exclude: ReadonlySet<string>): string[] {
  const extra = delegations.filter((d) => approvers.includes(d.delegatorPersonId) && roles.has(d.delegatePersonId) && !exclude.has(d.delegatePersonId)).map((d) => d.delegatePersonId);
  return [...new Set([...approvers, ...extra])].sort();
}

export interface DeciderRight {
  /** the approver the person acts for; null when they decide in their own right */
  onBehalfOfPersonId: string | null;
}

/**
 * Can `personId` decide a level whose direct approvers are `eligible`? Directly, or as the active delegate of one of them.
 * The requester never can, nor on behalf of the requester (self-approval is forbidden through every path).
 */
export function deciderRight(personId: string, eligible: readonly string[], delegations: readonly ActiveDelegation[], roles: Map<string, TeamRole>, exclude: ReadonlySet<string>): DeciderRight | null {
  if (exclude.has(personId)) return null;
  if (eligible.includes(personId)) return { onBehalfOfPersonId: null };
  if (!roles.has(personId)) return null;
  const d = delegations.find((x) => x.delegatePersonId === personId && eligible.includes(x.delegatorPersonId) && !exclude.has(x.delegatorPersonId));
  return d ? { onBehalfOfPersonId: d.delegatorPersonId } : null;
}

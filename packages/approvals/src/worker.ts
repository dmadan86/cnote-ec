import type { ModuleWorker } from "@cnote/core";
import { prisma } from "@cnote/db";
import { eraseApprovalsData } from "./privacy";
import { systemCancel } from "./requests";
import { runSlaSweep } from "./sla";

/** A member left the team: their open requests are withdrawn, their delegations and cap go. Idempotent. */
export async function onMemberRemoved(businessId: string, personId: string, now = new Date()): Promise<void> {
  const open = await prisma.approvalRequest.findMany({ where: { businessId, requesterPersonId: personId, status: "pending" }, select: { id: true } });
  for (const r of open) await systemCancel(r.id, now);
  await prisma.approvalDelegation.updateMany({ where: { businessId, revokedAt: null, OR: [{ delegatorPersonId: personId }, { delegatePersonId: personId }] }, data: { revokedAt: now } });
  await prisma.memberSpendLimit.deleteMany({ where: { businessId, personId } });
}

export const worker: ModuleWorker = {
  name: "approvals",
  handlers: {
    BuyerMemberRemoved: async (e) => onMemberRemoved(e.payload.businessId, e.payload.personId),
    DataErasureRequested: async (e) => eraseApprovalsData(e.payload.personId),
  },
  jobs: [{ name: "approvals.sla-sweep", everyMs: 15 * 60_000, run: async () => void (await runSlaSweep()) }],
};

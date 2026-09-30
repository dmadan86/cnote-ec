// Per-business dispute record for underwriting and trust (ADR-013 outcomes feed ADR-003/019). Counts only; no case detail.
import { prisma } from "@cnote/db";
import { ACTIVE_STATUSES } from "./state";

const UUID = /^[0-9a-f-]{36}$/i;

/** lost = decisions that found this business at fault; open = active disputes it is a party to (either side). */
export async function disputeRecordForBusiness(businessId: string): Promise<{ lost: number; open: number }> {
  if (!UUID.test(businessId)) return { lost: 0, open: 0 };
  const [lost, open] = await Promise.all([
    prisma.disputeDecision.count({ where: { faultBusinessId: businessId } }),
    prisma.dispute.count({ where: { status: { in: ACTIVE_STATUSES }, OR: [{ openedByBusinessId: businessId }, { againstBusinessId: businessId }] } }),
  ]);
  return { lost, open };
}

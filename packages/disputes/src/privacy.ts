// DPDP access right (ADR-010): disputes the person opened or took part in. Registered with @cnote/compliance's export registry.
// Private media keys are never exported (access goes through authorised, short-lived URLs); statements and messages are.
import { EXPORT_TAKE, exportCollection, type PersonalExport, type PersonalExportContext } from "@cnote/core";
import { prisma } from "@cnote/db";

export async function exportPersonalData(personId: string, ctx: PersonalExportContext): Promise<PersonalExport> {
  const biz = ctx.businessIds;
  const involved = [{ openedByPersonId: personId }, ...(biz.length ? [{ openedByBusinessId: { in: biz } }, { againstBusinessId: { in: biz } }] : [])];
  const [disputes, evidence, messages, appeals] = await Promise.all([
    prisma.dispute.findMany({
      where: { OR: involved }, orderBy: { createdAt: "asc" }, take: EXPORT_TAKE,
      select: { id: true, orderId: true, openedByBusinessId: true, againstBusinessId: true, openedByRole: true, type: true, status: true, description: true, language: true, amountPaise: true, createdAt: true, resolvedAt: true, withdrawnAt: true },
    }),
    prisma.disputeEvidence.findMany({
      where: { submittedByPersonId: personId }, orderBy: { createdAt: "asc" }, take: EXPORT_TAKE,
      select: { id: true, disputeId: true, party: true, kind: true, text: true, mimeType: true, language: true, source: true, createdAt: true },
    }),
    prisma.disputeMessage.findMany({ where: { authorPersonId: personId }, orderBy: { createdAt: "asc" }, take: EXPORT_TAKE, select: { id: true, disputeId: true, body: true, createdAt: true } }),
    prisma.disputeAppeal.findMany({ where: { byPersonId: personId }, orderBy: { createdAt: "asc" }, take: EXPORT_TAKE }),
  ]);
  return { disputes: exportCollection(disputes), disputeEvidence: exportCollection(evidence), disputeMessages: exportCollection(messages), disputeAppeals: exportCollection(appeals) };
}

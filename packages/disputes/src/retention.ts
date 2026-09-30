// DPDP (ADR-010): evidence is personal data. Registered with @cnote/compliance's retention registry by the lead.
import { prisma } from "@cnote/db";
import { evidenceStore } from "./ports";

const PURGED = "[removed under the retention policy]";

/**
 * Purges the personal content of disputes that CLOSED (resolved/withdrawn) before `before`: stored files are deleted,
 * statements/transcripts/messages/description blanked. Decisions, amounts, outcomes and structured brief fields stay
 * (audit + trust + evals). Idempotent. Returns the number of disputes purged.
 */
export async function purgeResolvedDisputeEvidence(before: Date, limit = 200): Promise<number> {
  const due = await prisma.dispute.findMany({
    where: { status: { in: ["resolved", "withdrawn"] }, evidencePurgedAt: null, resolvedAt: { lt: before } }, select: { id: true }, take: limit,
  });
  let n = 0;
  for (const { id } of due) {
    const files = await prisma.disputeEvidence.findMany({ where: { disputeId: id, mediaKey: { not: null } }, select: { mediaKey: true } });
    for (const f of files) await evidenceStore().delete(f.mediaKey!).catch((err) => console.error("[disputes] file purge failed", err instanceof Error ? err.message : err));
    const now = new Date();
    await prisma.$transaction([
      prisma.disputeEvidence.updateMany({ where: { disputeId: id }, data: { text: null, mediaKey: null, mimeType: null, purgedAt: now } }),
      prisma.disputeMessage.updateMany({ where: { disputeId: id }, data: { body: PURGED } }),
      prisma.disputeBrief.updateMany({ where: { disputeId: id }, data: { summary: PURGED, rationale: PURGED } }),
      prisma.disputeAppeal.updateMany({ where: { disputeId: id }, data: { reason: PURGED } }),
      prisma.dispute.update({ where: { id }, data: { description: PURGED, evidencePurgedAt: now } }),
    ]);
    n++;
  }
  return n;
}

// Retention (ADR-010, DPDP s.8(7)) for rate contracts. The commercial record (number, parties, dates, prices, quantities, answers and
// call-offs) stays: it backs orders, POs and invoices that are kept for tax. What goes after the window is personal data inside it:
// which person proposed, accepted or placed each step, and the free-text notes. Called by @cnote/compliance's RetentionPolicy registry.
import { prisma } from "@cnote/db";

const BATCH = 200;

/**
 * Scrubs CLOSED contracts (expired or terminated, last touched before `before`): person references on revisions, acceptances and
 * call-offs are cleared and notes / change notes / termination reasons blanked. Idempotent. `dryRun` only counts. Returns contracts affected.
 */
export async function purgeRateContracts(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  let affected = 0;
  let after: string | undefined;
  for (;;) {
    const rows = await prisma.rateContract.findMany({
      where: { status: { in: ["expired", "terminated"] }, updatedAt: { lt: before } },
      select: { id: true, terminationReason: true },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.id;
    for (const c of rows) {
      const dirty =
        c.terminationReason !== null ||
        (await prisma.rateContractRevision.count({ where: { contractId: c.id, OR: [{ proposedByPersonId: { not: null } }, { notes: { not: null } }, { changeNote: { not: null } }] } })) > 0 ||
        (await prisma.rateContractAcceptance.count({ where: { revision: { contractId: c.id }, OR: [{ personId: { not: null } }, { reason: { not: null } }] } })) > 0 ||
        (await prisma.rateContractCallOff.count({ where: { contractId: c.id, placedByPersonId: { not: null } } })) > 0;
      if (!dirty) continue;
      affected++;
      if (opts.dryRun) continue;
      await prisma.$transaction([
        prisma.rateContractRevision.updateMany({ where: { contractId: c.id }, data: { proposedByPersonId: null, notes: null, changeNote: null } }),
        prisma.rateContractAcceptance.updateMany({ where: { revision: { contractId: c.id } }, data: { personId: null, reason: null } }),
        prisma.rateContractCallOff.updateMany({ where: { contractId: c.id }, data: { placedByPersonId: null } }),
        // updatedAt is bumped by this write; the cutoff only applies to contracts untouched since, so a scrubbed row is not re-listed as dirty
        prisma.rateContract.update({ where: { id: c.id }, data: { terminationReason: null } }),
      ]);
    }
    if (rows.length < BATCH) break;
  }
  return affected;
}

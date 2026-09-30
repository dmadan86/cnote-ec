// Reconciliation (ADR-012): compare the partner statement to the ledger's partner_nodal movements per (escrow, kind).
// Mismatches become EscrowReconciliationIssue rows (de-duplicated) for staff to review and resolve (escrow.manage).
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { reconGraceMinutes } from "./config";
import { openIssue } from "./escrow";
import { trialBalance } from "./ledger";
import { getEscrowPartner, type StatementEntry } from "./partner";

type Kind = StatementEntry["kind"];
const JOURNAL_KIND: Record<string, Kind> = { fund: "collect", payout: "payout", refund_payout: "refund" };

export interface ReconcileResult { compared: number; opened: number; kinds: string[] }

/** Pure comparison of two per-(escrow,kind) sums. Exported for tests. */
export function diffSums(
  partner: Map<string, number>, ledger: Map<string, number>, authoritative: boolean,
): { key: string; kind: "amount_mismatch" | "missing_in_ledger" | "missing_at_partner"; partner: number | null; ledger: number | null }[] {
  const out: ReturnType<typeof diffSums> = [];
  for (const key of new Set([...partner.keys(), ...ledger.keys()])) {
    const p = partner.get(key) ?? null;
    const l = ledger.get(key) ?? null;
    if (p !== null && l !== null) {
      if (p !== l) out.push({ key, kind: "amount_mismatch", partner: p, ledger: l });
    } else if (p !== null) out.push({ key, kind: "missing_in_ledger", partner: p, ledger: null });
    else if (authoritative) out.push({ key, kind: "missing_at_partner", partner: null, ledger: l });
  }
  return out;
}

export async function reconcile(opts: { from?: Date; to?: Date; now?: Date } = {}): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  const to = opts.to ?? new Date(now.getTime() - reconGraceMinutes() * 60_000);
  const from = opts.from ?? new Date(now.getTime() - 3 * 86_400_000);
  const partner = getEscrowPartner();
  const entries = await partner.fetchStatement({ from, to });
  const psum = new Map<string, number>();
  for (const e of entries) {
    const k = `${e.escrowRef ?? "unknown"}|${e.kind}`;
    psum.set(k, (psum.get(k) ?? 0) + e.amountPaise);
  }
  const lines = await prisma.ledgerLine.findMany({
    where: { account: { code: "partner_nodal" }, journal: { kind: { in: Object.keys(JOURNAL_KIND) }, createdAt: { gte: from, lte: to } } },
    include: { journal: { select: { kind: true, escrowId: true } } },
  });
  const lsum = new Map<string, number>();
  for (const l of lines) {
    const k = `${l.journal.escrowId ?? "unknown"}|${JOURNAL_KIND[l.journal.kind]}`;
    lsum.set(k, (lsum.get(k) ?? 0) + Number(l.debitPaise > 0n ? l.debitPaise : l.creditPaise));
  }
  const diffs = diffSums(psum, lsum, partner.authoritativeStatement);
  const tb = await trialBalance();
  let opened = 0;
  const kinds = new Set<string>();
  await prisma.$transaction(async (tx) => {
    for (const d of diffs) {
      const [escrowRef, kind] = d.key.split("|") as [string, Kind];
      const escrowId = /^[0-9a-f-]{36}$/i.test(escrowRef) ? escrowRef : null;
      const isNew = await openIssue(tx, {
        dedupeKey: `${d.kind}:${d.key}:${d.partner}:${d.ledger}`, kind: d.kind, escrowId, expectedPaise: d.ledger, actualPaise: d.partner,
        detail: `${kind} for escrow ${escrowRef}: ledger ${d.ledger ?? "none"}, partner ${d.partner ?? "none"} (paise).`,
      });
      if (isNew) { opened++; kinds.add(d.kind); }
    }
    if (!tb.balanced && (await openIssue(tx, { dedupeKey: `balance_mismatch:${tb.totalDebitPaise}:${tb.totalCreditPaise}`, kind: "balance_mismatch", expectedPaise: tb.totalDebitPaise, actualPaise: tb.totalCreditPaise, detail: "Ledger trial balance does not balance." }))) {
      opened++;
      kinds.add("balance_mismatch");
    }
  });
  return { compared: new Set([...psum.keys(), ...lsum.keys()]).size, opened, kinds: [...kinds] };
}

export interface IssueRow { id: string; kind: string; escrowId: string | null; partnerRef: string | null; expectedPaise: number | null; actualPaise: number | null; detail: string; status: string; resolutionNote: string | null; createdAt: string; resolvedAt: string | null }

export async function listIssues(opts: { status?: "open" | "resolved"; escrowId?: string; limit?: number } = {}): Promise<IssueRow[]> {
  const rows = await prisma.escrowReconciliationIssue.findMany({
    where: { ...(opts.status ? { status: opts.status } : {}), ...(opts.escrowId ? { escrowId: opts.escrowId } : {}) }, orderBy: { createdAt: "desc" }, take: Math.min(opts.limit ?? 100, 200),
  });
  return rows.map((r) => ({
    id: r.id, kind: r.kind, escrowId: r.escrowId, partnerRef: r.partnerRef, expectedPaise: r.expectedPaise === null ? null : Number(r.expectedPaise),
    actualPaise: r.actualPaise === null ? null : Number(r.actualPaise), detail: r.detail, status: r.status, resolutionNote: r.resolutionNote,
    createdAt: r.createdAt.toISOString(), resolvedAt: r.resolvedAt?.toISOString() ?? null,
  }));
}

/** Staff closes an issue with a note (escrow.manage; callers wrap in audited()). */
export async function resolveIssue(issueId: string, staffId: string, note: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(issueId)) throw new DomainError("not_found", "Issue not found");
  const n = note.trim();
  if (n.length < 3) throw new DomainError("validation", "Add a resolution note (min 3 characters).");
  const r = await prisma.escrowReconciliationIssue.updateMany({ where: { id: issueId, status: "open" }, data: { status: "resolved", resolvedBy: /^[0-9a-f-]{36}$/i.test(staffId) ? staffId : null, resolutionNote: n.slice(0, 500), resolvedAt: new Date() } });
  if (r.count === 0) throw new DomainError("conflict", "Issue not found or already resolved.");
}

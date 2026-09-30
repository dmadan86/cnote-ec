// Double-entry immutable ledger (ADR-012, ADR-007). Amounts are integer paise.
//  - every journal balances (sum debits = sum credits) and every line is exactly one positive side;
//  - journals/lines are append-only: nothing in this package updates or deletes them, reversals are new journals;
//  - balances are always derived from lines, never stored;
//  - postJournal is idempotent by `key`.
// Chart of accounts (see docs/design/escrow.md):
//   partner_nodal (asset)  buyer_escrow:<orderId>, seller_payable:<businessId>, buyer_refund_payable:<businessId>,
//   gst_output (liability)  platform_fee (revenue)
import { DomainError } from "@cnote/core";
import { prisma, type Tx } from "@cnote/db";

export type AccountKind = "asset" | "liability" | "revenue" | "expense";
export type Side = "debit" | "credit";
export interface AccountSpec { kind: AccountKind; normal: Side }

export const ACCOUNTS = {
  nodal: "partner_nodal",
  fee: "platform_fee",
  gst: "gst_output",
  escrow: (orderId: string) => `buyer_escrow:${orderId}`,
  sellerPayable: (businessId: string) => `seller_payable:${businessId}`,
  refundPayable: (businessId: string) => `buyer_refund_payable:${businessId}`,
} as const;

/** Account class from its code. Unknown codes are rejected so a typo cannot silently create an account. */
export function accountSpec(code: string): AccountSpec {
  if (code === "partner_nodal") return { kind: "asset", normal: "debit" };
  if (code === "platform_fee") return { kind: "revenue", normal: "credit" };
  if (code === "gst_output") return { kind: "liability", normal: "credit" };
  if (/^(buyer_escrow|seller_payable|buyer_refund_payable):[0-9a-f-]{36}$/i.test(code)) return { kind: "liability", normal: "credit" };
  throw new DomainError("validation", `Unknown ledger account: ${code}`);
}

export interface JournalLineInput { account: string; debitPaise?: number | bigint; creditPaise?: number | bigint }
export interface NormalizedLine { account: string; debit: bigint; credit: bigint }

const big = (v: number | bigint | undefined, what: string): bigint => {
  if (v === undefined) return 0n;
  if (typeof v === "number" && !Number.isSafeInteger(v)) throw new DomainError("validation", `${what} must be a whole number of paise.`);
  const b = BigInt(v);
  if (b < 0n) throw new DomainError("validation", `${what} cannot be negative.`);
  return b;
};

/** Pure validation: >= 2 lines, each exactly one positive side, known accounts, total debits = total credits. */
export function validateLines(lines: JournalLineInput[]): NormalizedLine[] {
  if (lines.length < 2) throw new DomainError("validation", "A journal needs at least two lines.");
  const out = lines.map((l) => {
    accountSpec(l.account);
    const debit = big(l.debitPaise, "Debit");
    const credit = big(l.creditPaise, "Credit");
    if ((debit > 0n) === (credit > 0n)) throw new DomainError("validation", "Each line must have exactly one positive side (debit or credit).");
    return { account: l.account, debit, credit };
  });
  const d = out.reduce((a, l) => a + l.debit, 0n);
  const c = out.reduce((a, l) => a + l.credit, 0n);
  if (d !== c) throw new DomainError("validation", `Journal does not balance: debits ${d} != credits ${c}.`);
  return out;
}

/** Pure: signed balance per account (positive = on the account's normal side). Used by tests and reports. */
export function balancesOf(lines: NormalizedLine[]): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const l of lines) {
    const sign = accountSpec(l.account).normal === "debit" ? 1n : -1n;
    m.set(l.account, (m.get(l.account) ?? 0n) + sign * (l.debit - l.credit));
  }
  return m;
}

export interface PostJournalInput {
  key: string;
  kind: string;
  memo: string;
  escrowId?: string | null;
  lines: JournalLineInput[];
}
export interface PostedJournal { journalId: string; created: boolean }

/** Post a balanced journal inside the caller's transaction. Idempotent: an existing `key` returns the first journal untouched. */
export async function postJournal(tx: Tx, input: PostJournalInput): Promise<PostedJournal> {
  if (!input.key) throw new DomainError("validation", "A journal needs an idempotency key.");
  const lines = validateLines(input.lines);
  const existing = await tx.ledgerJournal.findUnique({ where: { key: input.key }, select: { id: true } });
  if (existing) return { journalId: existing.id, created: false };
  const accountIds = new Map<string, string>();
  for (const code of new Set(lines.map((l) => l.account))) {
    const spec = accountSpec(code);
    // Not upsert(): Prisma runs it as select-then-insert, so two journals creating the same account concurrently hit the
    // unique index. INSERT … ON CONFLICT DO NOTHING (skipDuplicates) is atomic; then read the row either way.
    await tx.ledgerAccount.createMany({ data: [{ code, kind: spec.kind, normal: spec.normal }], skipDuplicates: true });
    const a = await tx.ledgerAccount.findUniqueOrThrow({ where: { code }, select: { id: true } });
    accountIds.set(code, a.id);
  }
  const j = await tx.ledgerJournal.create({ data: { key: input.key, kind: input.kind, memo: input.memo, escrowId: input.escrowId ?? null }, select: { id: true } });
  await tx.ledgerLine.createMany({
    data: lines.map((l) => ({ journalId: j.id, accountId: accountIds.get(l.account)!, debitPaise: l.debit, creditPaise: l.credit })),
  });
  return { journalId: j.id, created: true };
}

/** Derived balance in paise on the account's normal side (0 for an account that has no lines yet). */
export async function accountBalance(code: string, client: Tx = prisma as unknown as Tx): Promise<number> {
  const spec = accountSpec(code);
  const s = await client.ledgerLine.aggregate({ where: { account: { code } }, _sum: { debitPaise: true, creditPaise: true } });
  const d = s._sum.debitPaise ?? 0n;
  const c = s._sum.creditPaise ?? 0n;
  return Number(spec.normal === "debit" ? d - c : c - d);
}

export interface TrialBalanceRow { code: string; kind: string; normal: string; debitPaise: number; creditPaise: number; balancePaise: number }
export interface TrialBalance { accounts: TrialBalanceRow[]; totalDebitPaise: number; totalCreditPaise: number; balanced: boolean }

/** Trial balance over all posted lines (optionally only accounts whose code starts with `prefix`). */
export async function trialBalance(opts: { prefix?: string } = {}, client: Tx = prisma as unknown as Tx): Promise<TrialBalance> {
  const groups = await client.ledgerLine.groupBy({ by: ["accountId"], _sum: { debitPaise: true, creditPaise: true } });
  const accounts = await client.ledgerAccount.findMany({ where: { id: { in: groups.map((g) => g.accountId) }, ...(opts.prefix ? { code: { startsWith: opts.prefix } } : {}) }, orderBy: { code: "asc" } });
  const sums = new Map(groups.map((g) => [g.accountId, g._sum]));
  const rows = accounts.map((a) => {
    const d = sums.get(a.id)?.debitPaise ?? 0n;
    const c = sums.get(a.id)?.creditPaise ?? 0n;
    return { code: a.code, kind: a.kind, normal: a.normal, debitPaise: Number(d), creditPaise: Number(c), balancePaise: Number(a.normal === "debit" ? d - c : c - d) };
  });
  const totalDebitPaise = rows.reduce((a, r) => a + r.debitPaise, 0);
  const totalCreditPaise = rows.reduce((a, r) => a + r.creditPaise, 0);
  return { accounts: rows, totalDebitPaise, totalCreditPaise, balanced: totalDebitPaise === totalCreditPaise };
}

export interface JournalView { id: string; key: string; kind: string; memo: string; createdAt: string; lines: { account: string; debitPaise: number; creditPaise: number }[] }

/** Journals of one escrow with their lines, oldest first (admin detail). */
export async function listJournals(escrowId: string): Promise<JournalView[]> {
  const rows = await prisma.ledgerJournal.findMany({ where: { escrowId }, orderBy: { createdAt: "asc" }, include: { lines: { include: { account: { select: { code: true } } } } } });
  return rows.map((j) => ({
    id: j.id, key: j.key, kind: j.kind, memo: j.memo, createdAt: j.createdAt.toISOString(),
    lines: j.lines.map((l) => ({ account: l.account.code, debitPaise: Number(l.debitPaise), creditPaise: Number(l.creditPaise) })),
  }));
}

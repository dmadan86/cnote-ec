import { DomainError, emit } from "@cnote/core";
import { prisma, type Tx } from "@cnote/db";
import { addDays, balanceAt, CREDIT_TTL_DAYS, lapsedRemainders, spendableLots, type LedgerRow } from "./credits";
import type { CreditLot, LedgerEntryView } from "./types";

/** Serialises all ledger writes for one business inside the caller's transaction (double-spend guard). */
export async function lockBusiness(tx: Pick<Tx, "$executeRaw">, businessId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${businessId}))`;
}

async function loadRows(db: Pick<Tx, "creditLedgerEntry">, businessId: string): Promise<LedgerRow[]> {
  const rows = await db.creditLedgerEntry.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({ id: r.id, delta: r.delta, reason: r.reason, refType: r.refType, refId: r.refId, expiresAt: r.expiresAt, createdAt: r.createdAt }));
}

export async function getBalance(businessId: string): Promise<number> {
  return balanceAt(await loadRows(prisma, businessId), new Date());
}

export async function getCreditLots(businessId: string): Promise<CreditLot[]> {
  const lots = spendableLots(await loadRows(prisma, businessId), new Date());
  return lots
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
    .map((l) => ({ id: l.id, remaining: l.remaining, expiresAt: l.expiresAt.toISOString() }));
}

export async function getLedger(businessId: string, limit = 50): Promise<LedgerEntryView[]> {
  const rows = await prisma.creditLedgerEntry.findMany({ where: { businessId }, orderBy: { createdAt: "desc" }, take: limit });
  return rows.map((r) => ({
    id: r.id,
    delta: r.delta,
    reason: r.reason,
    refType: r.refType,
    refId: r.refId,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Grants credits (+90-day expiry). Idempotent per (refType, refId): a repeat returns the existing
 * entry id, so at-least-once event handlers and retried jobs never double-grant.
 * Runs in the caller's tx; takes the business lock.
 */
export async function grantCreditsTx(
  tx: Tx,
  businessId: string,
  amount: number,
  reason: string,
  ref: { refType: string; refId: string },
): Promise<string> {
  if (!Number.isInteger(amount) || amount <= 0) throw new DomainError("validation", "Grant amount must be a positive integer");
  await lockBusiness(tx, businessId);
  const existing = await tx.creditLedgerEntry.findFirst({ where: { businessId, reason: "grant", refType: ref.refType, refId: ref.refId } });
  if (existing) return existing.id;
  const expiresAt = addDays(new Date(), CREDIT_TTL_DAYS);
  const entry = await tx.creditLedgerEntry.create({
    data: { businessId, delta: amount, reason: "grant", refType: ref.refType, refId: ref.refId, expiresAt },
  });
  await emit(tx, "CreditsGranted", { type: "business", id: businessId }, { businessId, amount, reason, expiresAt: expiresAt.toISOString() });
  return entry.id;
}

/** Manual/ops grant outside a caller transaction. */
export async function grantCredits(businessId: string, amount: number, reason: string, ref: { refType: string; refId: string }): Promise<string> {
  return prisma.$transaction((tx) => grantCreditsTx(tx, businessId, amount, reason, ref));
}

/**
 * Consume one lead credit inside the caller's transaction (only on lead ACCEPT, ADR-005).
 * Per-business advisory lock → concurrent accepts serialise, so a 1-credit balance can only be
 * spent once. Idempotent per ref: re-consuming an un-refunded ref returns the original entry.
 */
export async function consumeCredit(tx: Tx, businessId: string, ref: { refType: string; refId: string }): Promise<string> {
  await lockBusiness(tx, businessId);
  const rows = await loadRows(tx, businessId);
  const prior = rows.find((r) => r.reason === "consume" && r.refType === ref.refType && r.refId === ref.refId);
  if (prior && !rows.some((r) => r.reason === "refund" && r.refId === prior.id)) return prior.id;
  if (balanceAt(rows, new Date()) < 1) throw new DomainError("insufficient_credits", "Not enough lead credits. Top up on the pricing page to accept this lead.");
  const entry = await tx.creditLedgerEntry.create({
    data: { businessId, delta: -1, reason: "consume", refType: ref.refType, refId: ref.refId },
  });
  await emit(tx, "CreditConsumed", { type: "business", id: businessId }, { businessId, txnId: entry.id, refType: ref.refType, refId: ref.refId });
  return entry.id;
}

/** Idempotent refund of a prior consume (ADR-002 auto-refund). Returns the refund entry id, or null if already refunded. */
export async function refundCredit(tx: Tx, consumeTxnId: string): Promise<string | null> {
  const consume = await tx.creditLedgerEntry.findUnique({ where: { id: consumeTxnId } });
  if (!consume || consume.reason !== "consume") throw new DomainError("not_found", "Credit transaction not found");
  await lockBusiness(tx, consume.businessId);
  const done = await tx.creditLedgerEntry.findFirst({ where: { reason: "refund", refType: "consume", refId: consumeTxnId } });
  if (done) return null;
  const entry = await tx.creditLedgerEntry.create({
    data: {
      businessId: consume.businessId,
      delta: -consume.delta,
      reason: "refund",
      refType: "consume",
      refId: consumeTxnId,
      expiresAt: addDays(new Date(), CREDIT_TTL_DAYS),
    },
  });
  await emit(tx, "CreditRefunded", { type: "business", id: consume.businessId }, {
    businessId: consume.businessId,
    txnId: entry.id,
    refType: consume.refType ?? "consume",
    refId: consume.refId ?? consumeTxnId,
  });
  return entry.id;
}

/** Job: write "expire" rows for the unused remainder of lapsed lots. Idempotent. Returns rows written. */
export async function expireLapsedCredits(now = new Date()): Promise<number> {
  const candidates = await prisma.$queryRaw<{ business_id: string }[]>`
    SELECT DISTINCT c.business_id FROM credit_ledger c
    WHERE c.delta > 0 AND c.expires_at IS NOT NULL AND c.expires_at <= ${now} AND c.expires_at > ${addDays(now, -30)} -- 30d lookback keeps the scan small; balance-on-read is correct regardless
      AND NOT EXISTS (SELECT 1 FROM credit_ledger e WHERE e.reason = 'expire' AND e.ref_id = c.id::text)`;
  let written = 0;
  for (const { business_id: businessId } of candidates) {
    written += await prisma.$transaction(async (tx) => {
      await lockBusiness(tx, businessId);
      const rows = await loadRows(tx, businessId);
      const lapsed = lapsedRemainders(rows, now);
      for (const l of lapsed) {
        await tx.creditLedgerEntry.create({ data: { businessId, delta: -l.amount, reason: "expire", refType: "grant", refId: l.lotId } });
      }
      return lapsed.length;
    });
  }
  return written;
}

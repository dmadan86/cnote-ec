// Ad wallet (ADR-024): a prepaid, append-only ledger in integer paise, separate from lead credits.
//
//  - Balance = sum of deltas, except promo lots that lapsed unspent (they expire, paid lots never do).
//  - Every write is idempotent on `idempotencyKey` (unique in the DB), so at-least-once jobs and retried
//    webhooks can never double-credit or double-debit.
//  - Every write takes a per-business advisory lock inside its transaction, so concurrent debits serialise and
//    the balance can never go negative (a debit larger than the balance throws, or is capped with `allowPartial`).
//  - Debits consume expiring promo lots first, then paid balance. Only paid balance can be refunded to source.
//  - Rows are never updated or deleted: a correction is a new row.
import { DomainError, emit } from "@cnote/core";
import { prisma, type Tx } from "@cnote/db";

export const AD_PROMO_TTL_DAYS = 90;
const DAY_MS = 86_400_000;

export type AdWalletReasonName = "topup" | "spend" | "refund_invalid_click" | "promo_credit" | "promo_expire" | "refund_to_source" | "adjustment";

export interface AdWalletRow {
  id: string;
  deltaPaise: number;
  reason: AdWalletReasonName;
  refType: string | null;
  refId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface AdWalletEntryView {
  id: string;
  deltaPaise: number;
  reason: AdWalletReasonName;
  refType: string | null;
  refId: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface AdWalletState {
  /** spendable now: paid balance plus unexpired promo credit */
  balancePaise: number;
  /** the part of the balance that is unexpired promo credit (non-refundable) */
  promoPaise: number;
  /** lots that lapsed unspent and have no `promo_expire` row yet: [{ id, remaining }] */
  lapsed: { id: string; remaining: number }[];
}

// ---------------------------------------------------------------------------------------------------------------
// Pure ledger replay (property-tested against an independent model)
// ---------------------------------------------------------------------------------------------------------------

interface Lot {
  id: string;
  remaining: number;
  expiresAt: number | null;
  seq: number;
}

/** Replays the rows in order into lots. Debits draw from lots that were live when the debit happened, soonest-expiring first. */
export function replayAdWallet(rows: AdWalletRow[], now: Date): AdWalletState {
  const ordered = rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.createdAt.getTime() - b.r.createdAt.getTime() || a.i - b.i);
  const lots: Lot[] = [];
  for (const { r } of ordered) {
    const at = r.createdAt.getTime();
    if (r.deltaPaise > 0) {
      lots.push({ id: r.id, remaining: r.deltaPaise, expiresAt: r.expiresAt ? r.expiresAt.getTime() : null, seq: lots.length });
      continue;
    }
    let need = -r.deltaPaise;
    if (r.reason === "promo_expire") {
      const lot = lots.find((l) => l.id === r.refId);
      if (lot) lot.remaining -= Math.min(lot.remaining, need);
      continue;
    }
    const live = lots
      .filter((l) => l.remaining > 0 && (l.expiresAt === null || (l.expiresAt > at && r.reason !== "refund_to_source")))
      .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || a.seq - b.seq);
    for (const l of live) {
      if (need <= 0) break;
      const take = Math.min(l.remaining, need);
      l.remaining -= take;
      need -= take;
    }
  }
  const t = now.getTime();
  let balance = 0;
  let promo = 0;
  const lapsed: { id: string; remaining: number }[] = [];
  for (const l of lots) {
    if (l.remaining <= 0) continue;
    if (l.expiresAt !== null && l.expiresAt <= t) lapsed.push({ id: l.id, remaining: l.remaining });
    else {
      balance += l.remaining;
      if (l.expiresAt !== null) promo += l.remaining;
    }
  }
  return { balancePaise: balance, promoPaise: promo, lapsed };
}

// ---------------------------------------------------------------------------------------------------------------
// DB plumbing
// ---------------------------------------------------------------------------------------------------------------

type Db = Pick<Tx, "adWalletEntry">;

async function lockWallet(tx: Pick<Tx, "$executeRaw">, businessId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"adwallet:" + businessId}))`;
}

async function loadRows(db: Db, businessId: string): Promise<AdWalletRow[]> {
  const rows = await db.adWalletEntry.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({ id: r.id, deltaPaise: Number(r.deltaPaise), reason: r.reason, refType: r.refType, refId: r.refId, expiresAt: r.expiresAt, createdAt: r.createdAt }));
}

const toView = (r: AdWalletRow): AdWalletEntryView => ({
  id: r.id,
  deltaPaise: r.deltaPaise,
  reason: r.reason,
  refType: r.refType,
  refId: r.refId,
  expiresAt: r.expiresAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

function requirePositive(amountPaise: number, what: string): void {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new DomainError("validation", `${what} must be a positive whole number of paise`);
}

function requireKey(key: string): void {
  if (!key || key.length > 200) throw new DomainError("validation", "idempotencyKey is required (max 200 chars)");
}

export async function getAdWalletState(businessId: string, now = new Date()): Promise<AdWalletState> {
  return replayAdWallet(await loadRows(prisma, businessId), now);
}

/** Spendable balance in paise (never negative). */
export async function getAdWalletBalance(businessId: string, now = new Date()): Promise<number> {
  return (await getAdWalletState(businessId, now)).balancePaise;
}

/** Same as getAdWalletBalance but inside the caller's transaction (no second connection: safe under a small pool). */
export async function getAdWalletBalanceTx(tx: Tx, businessId: string, now = new Date()): Promise<number> {
  return replayAdWallet(await loadRows(tx, businessId), now).balancePaise;
}

export async function getAdWalletLedger(businessId: string, limit = 50): Promise<AdWalletEntryView[]> {
  const rows = await prisma.adWalletEntry.findMany({ where: { businessId }, orderBy: { createdAt: "desc" }, take: Math.min(Math.max(limit, 1), 500) });
  return rows.map((r) => toView({ id: r.id, deltaPaise: Number(r.deltaPaise), reason: r.reason, refType: r.refType, refId: r.refId, expiresAt: r.expiresAt, createdAt: r.createdAt }));
}

interface Append {
  businessId: string;
  deltaPaise: number;
  reason: AdWalletReasonName;
  refType?: string;
  refId?: string;
  expiresAt?: Date | null;
  idempotencyKey: string;
}

/** Inserts one row unless the key exists. Caller holds the wallet lock. */
async function appendOnce(tx: Tx, a: Append): Promise<{ id: string; duplicate: boolean; deltaPaise: number }> {
  const existing = await tx.adWalletEntry.findUnique({ where: { idempotencyKey: a.idempotencyKey } });
  if (existing) {
    if (existing.businessId !== a.businessId) throw new DomainError("conflict", "Idempotency key belongs to another wallet");
    return { id: existing.id, duplicate: true, deltaPaise: Number(existing.deltaPaise) };
  }
  const row = await tx.adWalletEntry.create({
    data: {
      businessId: a.businessId,
      deltaPaise: BigInt(a.deltaPaise),
      reason: a.reason,
      refType: a.refType ?? null,
      refId: a.refId ?? null,
      expiresAt: a.expiresAt ?? null,
      idempotencyKey: a.idempotencyKey,
    },
  });
  return { id: row.id, duplicate: false, deltaPaise: a.deltaPaise };
}

// ---------------------------------------------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------------------------------------------

export interface TopUpGst {
  gstPaise: number;
  gstRateBps: number;
  sacCode: string;
  taxType: "CGST_SGST" | "IGST";
  placeOfSupply: string;
  sellerGstin?: string | null;
  invoiceNumber: string;
}

export interface TopUpResult {
  entryId: string;
  duplicate: boolean;
  topUpId: string | null;
}

/**
 * Credits ex-GST paid value. `ref` is the payment reference (gateway id, or "manual:{bankRef}" in the pilot) and makes the
 * top-up idempotent (`topup:{ref}`). With `opts.gst` an AdTopUp row (invoice data) is written in the same transaction and
 * `AdWalletToppedUp` is emitted; without it (manual pilot, invoice issued from the accounting system) only the ledger row is written.
 */
export async function creditTopUpTx(tx: Tx, businessId: string, amountPaise: number, ref: string, opts: { gst?: TopUpGst } = {}): Promise<TopUpResult> {
  requirePositive(amountPaise, "Top-up amount");
  if (!ref) throw new DomainError("validation", "A payment reference is required");
  await lockWallet(tx, businessId);
  const entry = await appendOnce(tx, { businessId, deltaPaise: amountPaise, reason: "topup", refType: "ad_topup", refId: ref, idempotencyKey: `topup:${ref}` });
  if (entry.duplicate) {
    const t = await tx.adTopUp.findUnique({ where: { walletEntryId: entry.id } });
    return { entryId: entry.id, duplicate: true, topUpId: t?.id ?? null };
  }
  let topUpId: string | null = null;
  if (opts.gst) {
    const g = opts.gst;
    const t = await tx.adTopUp.create({
      data: {
        businessId,
        amountPaise: BigInt(amountPaise),
        gstPaise: BigInt(g.gstPaise),
        gstRateBps: g.gstRateBps,
        sacCode: g.sacCode,
        taxType: g.taxType,
        placeOfSupply: g.placeOfSupply,
        sellerGstin: g.sellerGstin ?? null,
        invoiceNumber: g.invoiceNumber,
        paymentRef: ref,
        walletEntryId: entry.id,
      },
    });
    topUpId = t.id;
    await emit(tx, "AdWalletToppedUp", { type: "business", id: businessId }, { businessId, topUpId: t.id, amountPaise, gstPaise: g.gstPaise, invoiceNumber: g.invoiceNumber });
  }
  return { entryId: entry.id, duplicate: false, topUpId };
}

export async function creditTopUp(businessId: string, amountPaise: number, ref: string, opts: { gst?: TopUpGst } = {}): Promise<TopUpResult> {
  return prisma.$transaction((tx) => creditTopUpTx(tx, businessId, amountPaise, ref, opts));
}

/** Promo / coupon credit. Expires (default +90 days), never refundable. Idempotent on `promo:{refType}:{refId}`. */
export async function grantAdPromoCredit(
  businessId: string,
  amountPaise: number,
  ref: { refType: string; refId: string },
  opts: { expiresAt?: Date; now?: Date } = {},
): Promise<{ entryId: string; duplicate: boolean }> {
  requirePositive(amountPaise, "Promo credit");
  const now = opts.now ?? new Date();
  const expiresAt = opts.expiresAt ?? new Date(now.getTime() + AD_PROMO_TTL_DAYS * DAY_MS);
  if (expiresAt.getTime() <= now.getTime()) throw new DomainError("validation", "Promo credit must expire in the future");
  return prisma.$transaction(async (tx) => {
    await lockWallet(tx, businessId);
    const e = await appendOnce(tx, { businessId, deltaPaise: amountPaise, reason: "promo_credit", refType: ref.refType, refId: ref.refId, expiresAt, idempotencyKey: `promo:${ref.refType}:${ref.refId}` });
    return { entryId: e.id, duplicate: e.duplicate };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Debits
// ---------------------------------------------------------------------------------------------------------------

export interface DebitResult {
  /** null when nothing could be debited (zero balance with allowPartial) */
  entryId: string | null;
  debitedPaise: number;
  /** requested minus debited (only > 0 with allowPartial) */
  shortfallPaise: number;
  duplicate: boolean;
}

/**
 * Settled ad spend. `idempotencyKey` e.g. `settle:{campaignId}:{windowStart}`. A repeat returns the original result.
 * Larger than the balance: throws `insufficient_credits`, or with `allowPartial` debits what is there and reports the shortfall
 * (settlement uses this: the platform absorbs the shortfall and the campaign is halted for wallet).
 * Runs in the caller's transaction so the spend row commits together with the settlement that justifies it.
 */
export async function debitSpendTx(
  tx: Tx,
  businessId: string,
  amountPaise: number,
  o: { idempotencyKey: string; refType?: string; refId?: string; allowPartial?: boolean; now?: Date },
): Promise<DebitResult> {
  requirePositive(amountPaise, "Spend");
  requireKey(o.idempotencyKey);
  await lockWallet(tx, businessId);
  const prior = await tx.adWalletEntry.findUnique({ where: { idempotencyKey: o.idempotencyKey } });
  if (prior) {
    if (prior.businessId !== businessId) throw new DomainError("conflict", "Idempotency key belongs to another wallet");
    const debited = -Number(prior.deltaPaise);
    return { entryId: prior.id, debitedPaise: debited, shortfallPaise: 0, duplicate: true };
  }
  const { balancePaise } = replayAdWallet(await loadRows(tx, businessId), o.now ?? new Date());
  if (balancePaise < amountPaise && !o.allowPartial) throw new DomainError("insufficient_credits", "Not enough ad wallet balance");
  const take = Math.min(balancePaise, amountPaise);
  if (take <= 0) return { entryId: null, debitedPaise: 0, shortfallPaise: amountPaise, duplicate: false };
  const e = await appendOnce(tx, { businessId, deltaPaise: -take, reason: "spend", refType: o.refType ?? "ad_settlement", refId: o.refId, idempotencyKey: o.idempotencyKey });
  return { entryId: e.id, debitedPaise: take, shortfallPaise: amountPaise - take, duplicate: false };
}

export async function debitSpend(
  businessId: string,
  amountPaise: number,
  o: { idempotencyKey: string; refType?: string; refId?: string; allowPartial?: boolean; now?: Date },
): Promise<DebitResult> {
  return prisma.$transaction((tx) => debitSpendTx(tx, businessId, amountPaise, o));
}

/** Automatic invalid-click refund (no ticket). Idempotent on `invalid:{clickId}`. Returns the refund entry id (existing one on repeat). */
export async function refundInvalidClickTx(tx: Tx, businessId: string, clickId: string, amountPaise: number): Promise<{ entryId: string; duplicate: boolean }> {
  requirePositive(amountPaise, "Refund");
  await lockWallet(tx, businessId);
  const e = await appendOnce(tx, { businessId, deltaPaise: amountPaise, reason: "refund_invalid_click", refType: "ad_click", refId: clickId, idempotencyKey: `invalid:${clickId}` });
  return { entryId: e.id, duplicate: e.duplicate };
}

export async function refundInvalidClick(businessId: string, clickId: string, amountPaise: number): Promise<{ entryId: string; duplicate: boolean }> {
  return prisma.$transaction((tx) => refundInvalidClickTx(tx, businessId, clickId, amountPaise));
}

/** Returns PAID balance to the payer (a GST credit note is the caller's job). Promo credit is never refundable. */
export async function refundAdWalletToSource(businessId: string, amountPaise: number, ref: string, now = new Date()): Promise<{ entryId: string; duplicate: boolean }> {
  requirePositive(amountPaise, "Refund");
  if (!ref) throw new DomainError("validation", "A refund reference is required");
  return prisma.$transaction(async (tx) => {
    await lockWallet(tx, businessId);
    const key = `refund_src:${ref}`;
    const prior = await tx.adWalletEntry.findUnique({ where: { idempotencyKey: key } });
    if (prior) return { entryId: prior.id, duplicate: true };
    const s = replayAdWallet(await loadRows(tx, businessId), now);
    if (amountPaise > s.balancePaise - s.promoPaise) throw new DomainError("insufficient_credits", "Only unspent paid balance can be refunded to source");
    const e = await appendOnce(tx, { businessId, deltaPaise: -amountPaise, reason: "refund_to_source", refType: "staff", refId: ref, idempotencyKey: key });
    return { entryId: e.id, duplicate: false };
  });
}

/** Finance adjustment (caller must hold billing.adjust and write an audit row). A negative adjustment cannot overdraw. */
export async function adjustAdWallet(businessId: string, deltaPaise: number, ref: string, now = new Date()): Promise<{ entryId: string; duplicate: boolean }> {
  if (!Number.isSafeInteger(deltaPaise) || deltaPaise === 0) throw new DomainError("validation", "Adjustment must be a non-zero whole number of paise");
  if (!ref) throw new DomainError("validation", "An adjustment reference is required");
  return prisma.$transaction(async (tx) => {
    await lockWallet(tx, businessId);
    const key = `adjust:${ref}`;
    const prior = await tx.adWalletEntry.findUnique({ where: { idempotencyKey: key } });
    if (prior) return { entryId: prior.id, duplicate: true };
    if (deltaPaise < 0 && replayAdWallet(await loadRows(tx, businessId), now).balancePaise < -deltaPaise) throw new DomainError("insufficient_credits", "Adjustment would overdraw the wallet");
    const e = await appendOnce(tx, { businessId, deltaPaise, reason: "adjustment", refType: "staff", refId: ref, idempotencyKey: key });
    return { entryId: e.id, duplicate: false };
  });
}

/** Job: writes `promo_expire` rows for promo lots that lapsed unspent. Idempotent (`promo_expire:{lotId}`). Returns rows written. */
export async function expireLapsedAdPromo(now = new Date()): Promise<number> {
  const candidates = await prisma.adWalletEntry.findMany({
    where: { reason: "promo_credit", expiresAt: { lte: now, gt: new Date(now.getTime() - 30 * DAY_MS) } },
    select: { businessId: true },
    distinct: ["businessId"],
  });
  let written = 0;
  for (const { businessId } of candidates) {
    written += await prisma.$transaction(async (tx) => {
      await lockWallet(tx, businessId);
      const { lapsed } = replayAdWallet(await loadRows(tx, businessId), now);
      let n = 0;
      for (const lot of lapsed) {
        const e = await appendOnce(tx, { businessId, deltaPaise: -lot.remaining, reason: "promo_expire", refType: "promo_lot", refId: lot.id, idempotencyKey: `promo_expire:${lot.id}` });
        if (!e.duplicate) n++;
      }
      return n;
    });
  }
  return written;
}

// ---------------------------------------------------------------------------------------------------------------
// Revenue guardrail input (ADR-024 rule 10)
// ---------------------------------------------------------------------------------------------------------------

/** Paid, non-ad platform revenue (ex-GST taxable value of subscription and lead-credit payments) in a window. */
export async function getNonAdRevenuePaise(from: Date, to: Date): Promise<number> {
  const r = await prisma.paymentOrder.aggregate({
    _sum: { amountPaise: true },
    where: { status: { in: ["paid", "partially_refunded"] }, purpose: { not: "ad_topup" }, createdAt: { gte: from, lt: to } },
  });
  return Number(r._sum.amountPaise ?? 0n);
}

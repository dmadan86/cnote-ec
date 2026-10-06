// Rate contracts (docs/design/rate-contracts.md): prices agreed between one buyer business and one seller business for a period and/or
// volume. Terms live in immutable revisions; both parties must accept a revision for it to be in force. The buyer places call-off orders
// (an Order and, when purchase orders are enabled, a PO) at the locked prices; consumption is tracked against item and value caps.
// A contract never renews by itself (ADR-005 spirit): a renewal is a new draft that both parties accept again.
// Private to the two parties and never read by ranking or lead matching (ADR-005).
import { financialYear } from "@cnote/billing";
import { DomainError, emit } from "@cnote/core";
import { prisma, type Prisma, type RateContract, type Tx } from "@cnote/db";
import * as catalogue from "@cnote/catalogue";
import * as identity from "@cnote/identity";
import { randomUUID } from "node:crypto";
import { addDays, fromDbDate, isIsoDate, istDate, paymentTermsToDays, toDbDate, type PoLineInput } from "./po-core";
import { getPurchaseOrderForOrder, issuePurchaseOrder, type PurchaseOrderView } from "./purchase-orders";
import { purchaseOrdersEnabled } from "./supplier-invoices";
import {
  expiryReminderStage, formatRcNumber, normaliseTerms, phaseOf, priceCallOff, renewalDates, sumConsumption, thresholdsCrossed, usedPercent,
  type CallOffLineInput, type PriceBasis, type RcItemInput, type RcTermsInput, type WarnThreshold,
} from "./rc-core";
import type { Actor } from "./types";

const UUID = /^[0-9a-f-]{36}$/i;

/** RATE_CONTRACTS_ENABLED (default on; false/0/off hides the screens, blocks writes and stops the sweep job; data is kept). */
export function rateContractsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.RATE_CONTRACTS_ENABLED?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}
export function assertRateContractsEnabled(): void {
  if (!rateContractsEnabled()) throw new DomainError("forbidden", "Rate contracts are not enabled.");
}

// ---- views ---------------------------------------------------------------------------------------------------------------------

export type RcStatus = "draft" | "proposed" | "active" | "expired" | "terminated";
export type RcAnswer = "pending" | "accepted" | "rejected";

export interface RcItemView {
  itemKey: string;
  lineNo: number;
  listingId: string | null;
  description: string;
  hsn: string | null;
  unit: string;
  unitPricePaise: number;
  gstRateBps: number;
  moq: number | null;
  quantityCap: number | null;
  variationKind: "fixed" | "indexed";
  variationCapBps: number | null;
  variationNote: string | null;
  consumedQuantity: number;
  remainingQuantity: number | null;
  usedPercent: number | null;
}

export interface RcRevisionView {
  revision: number;
  proposedByRole: "buyer" | "seller";
  createdAt: string;
  validFrom: string;
  validTo: string;
  paymentTermsDays: number;
  priceBasis: PriceBasis;
  valueCapPaise: number | null;
  notes: string | null;
  changeNote: string | null;
  items: RcItemView[];
  answers: { buyer: RcAnswer; seller: RcAnswer; buyerReason: string | null; sellerReason: string | null };
}

export interface RcCallOffLineView { itemKey: string; description: string; unit: string; quantity: number; contractPricePaise: number; appliedPricePaise: number; taxablePaise: number }
export interface RcCallOffView {
  id: string;
  callOffNo: number;
  orderId: string;
  revision: number;
  status: "placed" | "cancelled";
  taxablePaise: number;
  createdAt: string;
  lines: RcCallOffLineView[];
}

export interface RateContractView {
  id: string;
  number: string;
  title: string;
  status: RcStatus;
  role: "buyer" | "seller";
  counterparty: { businessId: string; name: string };
  latestRevision: number;
  activeRevision: number | null;
  /** where today falls against the active revision's dates; null unless a revision is active */
  phase: "not_started" | "in_force" | "ended" | null;
  daysLeft: number | null;
  /** the terms in force (the accepted revision) */
  current: RcRevisionView | null;
  /** a revision waiting for an answer (revision 1 of a draft or proposal, or an amendment) */
  pending: RcRevisionView | null;
  history: { revision: number; proposedByRole: "buyer" | "seller"; createdAt: string; changeNote: string | null; state: "active" | "superseded" | "pending" | "declined" }[];
  consumption: { valueUsedPaise: number; valueCapPaise: number | null; valuePercent: number | null };
  callOffs: RcCallOffView[];
  sourceQuoteId: string | null;
  renewedFromId: string | null;
  terminationReason: string | null;
  terminatedByRole: "buyer" | "seller" | null;
  createdAt: string;
  actions: { edit: boolean; send: boolean; propose: boolean; respond: boolean; terminate: boolean; callOff: boolean; renew: boolean };
}

export interface RateContractRow {
  id: string;
  number: string;
  title: string;
  status: RcStatus;
  role: "buyer" | "seller";
  counterparty: { businessId: string; name: string };
  validFrom: string | null;
  validTo: string | null;
  valuePercent: number | null;
  /** true when this party has to answer a pending revision */
  needsAnswer: boolean;
  createdAt: string;
}

type Full = Prisma.RateContractGetPayload<{ include: { revisions: { include: { items: true; acceptances: true } }; callOffs: { include: { lines: true } } } }>;
type FullRevision = Full["revisions"][number];
const INCLUDE = { revisions: { include: { items: true, acceptances: true } }, callOffs: { include: { lines: true } } } satisfies Prisma.RateContractInclude;

function roleOf(c: Pick<RateContract, "buyerBusinessId" | "sellerBusinessId">, a: Actor): "buyer" | "seller" | null {
  return c.buyerBusinessId === a.businessId ? "buyer" : c.sellerBusinessId === a.businessId ? "seller" : null;
}

function answers(rev: FullRevision, c: Pick<RateContract, "buyerBusinessId" | "sellerBusinessId">) {
  const last = (biz: string) => [...rev.acceptances].filter((a) => a.businessId === biz).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).at(-1);
  const b = last(c.buyerBusinessId);
  const s = last(c.sellerBusinessId);
  const st = (r: typeof b): RcAnswer => (r ? (r.decision === "accepted" ? "accepted" : "rejected") : "pending");
  return { buyer: st(b), seller: st(s), buyerReason: b?.reason ?? null, sellerReason: s?.reason ?? null };
}

function consumptionOf(c: Full) {
  return sumConsumption(c.callOffs.filter((o) => o.status === "placed").flatMap((o) => o.lines.map((l) => ({ itemKey: l.itemKey, quantity: l.quantity, taxablePaise: Number(l.taxablePaise) }))));
}

function revisionView(rev: FullRevision, c: Full, used: ReturnType<typeof consumptionOf>): RcRevisionView {
  return {
    revision: rev.revision, proposedByRole: rev.proposedByBusinessId === c.buyerBusinessId ? "buyer" : "seller", createdAt: rev.createdAt.toISOString(),
    validFrom: fromDbDate(rev.validFrom), validTo: fromDbDate(rev.validTo), paymentTermsDays: rev.paymentTermsDays, priceBasis: rev.priceBasis as PriceBasis,
    valueCapPaise: rev.valueCapPaise === null ? null : Number(rev.valueCapPaise), notes: rev.notes, changeNote: rev.changeNote,
    items: [...rev.items].sort((a, b) => a.lineNo - b.lineNo).map((i) => {
      const q = used.byItem.get(i.itemKey)?.quantity ?? 0;
      return {
        itemKey: i.itemKey, lineNo: i.lineNo, listingId: i.listingId, description: i.description, hsn: i.hsn, unit: i.unit, unitPricePaise: Number(i.unitPricePaise),
        gstRateBps: i.gstRateBps, moq: i.moq, quantityCap: i.quantityCap, variationKind: i.variationKind === "indexed" ? "indexed" : "fixed", variationCapBps: i.variationCapBps,
        variationNote: i.variationNote, consumedQuantity: q, remainingQuantity: i.quantityCap === null ? null : Math.max(0, i.quantityCap - q),
        usedPercent: i.quantityCap === null ? null : usedPercent(q, i.quantityCap),
      };
    }),
    answers: answers(rev, c),
  };
}

async function buildView(c: Full, role: "buyer" | "seller", now: Date): Promise<RateContractView> {
  const today = istDate(now);
  const used = consumptionOf(c);
  const rev = (n: number | null) => (n === null ? undefined : c.revisions.find((r) => r.revision === n));
  const active = rev(c.activeRevision);
  const latest = rev(c.latestRevision)!;
  const hasPending = c.status === "draft" || c.status === "proposed" || (c.status === "active" && c.latestRevision > (c.activeRevision ?? 0));
  const otherId = role === "buyer" ? c.sellerBusinessId : c.buyerBusinessId;
  const names = await identity.getTrustProfiles([otherId]);
  const pendingRev = hasPending && latest && latest.revision !== c.activeRevision ? latest : undefined;
  const phase = c.status === "active" && active ? phaseOf(fromDbDate(active.validFrom), fromDbDate(active.validTo), today) : null;
  const cap = active?.valueCapPaise == null ? null : Number(active.valueCapPaise);
  const myBiz = role === "buyer" ? c.buyerBusinessId : c.sellerBusinessId;
  const pendAns = pendingRev ? answers(pendingRev, c) : null;
  const myAns = pendAns ? (role === "buyer" ? pendAns.buyer : pendAns.seller) : null;
  const proposerIsMe = pendingRev ? pendingRev.proposedByBusinessId === myBiz : false;
  const live = c.status === "proposed" || c.status === "active";
  const lastTerminator = c.terminatedByBusinessId ? (c.terminatedByBusinessId === c.buyerBusinessId ? "buyer" : "seller") : null;
  return {
    id: c.id, number: c.number, title: c.title, status: c.status, role, counterparty: { businessId: otherId, name: names.get(otherId)?.name ?? (role === "buyer" ? "Supplier" : "Buyer") },
    latestRevision: c.latestRevision, activeRevision: c.activeRevision, phase, daysLeft: c.status === "active" && active ? Math.round((toDbDate(fromDbDate(active.validTo)).getTime() - toDbDate(today).getTime()) / 86_400_000) : null,
    current: active ? revisionView(active, c, used) : null,
    pending: pendingRev && !(role === "seller" && c.status === "draft") ? revisionView(pendingRev, c, used) : null,
    history: [...c.revisions].sort((a, b) => b.revision - a.revision).filter((r) => !(role === "seller" && c.status === "draft")).map((r) => {
      const a = answers(r, c);
      const state = r.revision === c.activeRevision ? "active" : r.revision === c.latestRevision && hasPending ? (a.buyer === "rejected" || a.seller === "rejected" ? "declined" : "pending") : "superseded";
      return { revision: r.revision, proposedByRole: r.proposedByBusinessId === c.buyerBusinessId ? "buyer" as const : "seller" as const, createdAt: r.createdAt.toISOString(), changeNote: r.changeNote, state };
    }),
    consumption: { valueUsedPaise: used.valuePaise, valueCapPaise: cap, valuePercent: cap === null ? null : usedPercent(used.valuePaise, cap) },
    callOffs: [...c.callOffs].sort((a, b) => b.callOffNo - a.callOffNo).map((o) => ({
      id: o.id, callOffNo: o.callOffNo, orderId: o.orderId, revision: o.revision, status: o.status === "cancelled" ? "cancelled" : "placed", taxablePaise: Number(o.taxablePaise), createdAt: o.createdAt.toISOString(),
      lines: [...o.lines].sort((a, b) => a.lineNo - b.lineNo).map((l) => ({ itemKey: l.itemKey, description: l.description, unit: l.unit, quantity: l.quantity, contractPricePaise: Number(l.contractPricePaise), appliedPricePaise: Number(l.appliedPricePaise), taxablePaise: Number(l.taxablePaise) })),
    })),
    sourceQuoteId: c.sourceQuoteId, renewedFromId: c.renewedFromId, terminationReason: c.terminationReason, terminatedByRole: lastTerminator, createdAt: c.createdAt.toISOString(),
    actions: {
      edit: role === "buyer" && c.status === "draft",
      send: role === "buyer" && c.status === "draft",
      propose: live,
      respond: live && !!pendingRev && !proposerIsMe && myAns === "pending",
      terminate: (role === "buyer" && c.status === "draft") || live,
      callOff: role === "buyer" && c.status === "active" && phase === "in_force",
      renew: role === "buyer" && (c.status === "active" || c.status === "expired"),
    },
  };
}

// ---- reads -----------------------------------------------------------------------------------------------------------------------

export async function getRateContract(actor: Actor, id: string, now: Date = new Date()): Promise<RateContractView | null> {
  if (!UUID.test(id)) return null;
  const c = await prisma.rateContract.findUnique({ where: { id }, include: INCLUDE });
  const role = c ? roleOf(c, actor) : null;
  if (!c || !role || (role === "seller" && c.status === "draft")) return null; // non-parties and unsent drafts: indistinguishable from missing
  return buildView(c, role, now);
}

export interface ListRateContractsOpts { role: "buyer" | "seller"; status?: RcStatus | null; cursor?: string | null; limit?: number }

export async function listRateContracts(actor: Actor, opts: ListRateContractsOpts): Promise<{ items: RateContractRow[]; nextCursor: string | null }> {
  const take = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const where: Prisma.RateContractWhereInput = {
    ...(opts.role === "buyer" ? { buyerBusinessId: actor.businessId } : { sellerBusinessId: actor.businessId, status: { not: "draft" } }),
    ...(opts.status ? { status: opts.status } : {}),
  };
  if (opts.role === "seller" && opts.status === "draft") return { items: [], nextCursor: null };
  const rows = await prisma.rateContract.findMany({
    where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1, include: { revisions: { include: { acceptances: true } }, callOffs: { include: { lines: true } } },
    ...(opts.cursor && UUID.test(opts.cursor) ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, take);
  const other = (c: RateContract) => (opts.role === "buyer" ? c.sellerBusinessId : c.buyerBusinessId);
  const names = await identity.getTrustProfiles([...new Set(page.map(other))]);
  const items = page.map((c): RateContractRow => {
    const shown = c.revisions.find((r) => r.revision === (c.activeRevision ?? c.latestRevision));
    const latest = c.revisions.find((r) => r.revision === c.latestRevision);
    const mine = opts.role === "buyer" ? c.buyerBusinessId : c.sellerBusinessId;
    let needsAnswer = false;
    if ((c.status === "proposed" || c.status === "active") && latest && latest.revision !== c.activeRevision && latest.proposedByBusinessId !== mine) {
      needsAnswer = !latest.acceptances.some((a) => a.businessId === mine);
    }
    const capRev = c.revisions.find((r) => r.revision === c.activeRevision);
    const cap = capRev?.valueCapPaise == null ? null : Number(capRev.valueCapPaise);
    const usedValue = c.callOffs.filter((o) => o.status === "placed").reduce((s, o) => s + Number(o.taxablePaise), 0);
    return {
      id: c.id, number: c.number, title: c.title, status: c.status, role: opts.role, counterparty: { businessId: other(c), name: names.get(other(c))?.name ?? (opts.role === "buyer" ? "Supplier" : "Buyer") },
      validFrom: shown ? fromDbDate(shown.validFrom) : null, validTo: shown ? fromDbDate(shown.validTo) : null, valuePercent: cap === null ? null : usedPercent(usedValue, cap), needsAnswer, createdAt: c.createdAt.toISOString(),
    };
  });
  return { items, nextCursor: rows.length > take ? page[page.length - 1]!.id : null };
}

/** Sellers this buyer has dealt with (orders, accepted leads): the people a contract can be proposed to. */
export async function listContractCounterparties(actor: Actor): Promise<{ businessId: string; name: string }[]> {
  const [orders, matches] = await Promise.all([
    prisma.order.findMany({ where: { buyerBusinessId: actor.businessId }, select: { sellerBusinessId: true }, distinct: ["sellerBusinessId"], take: 100 }),
    prisma.match.findMany({ where: { status: "accepted", enquiry: { buyerBusinessId: actor.businessId } }, select: { sellerBusinessId: true }, distinct: ["sellerBusinessId"], take: 100 }),
  ]);
  const ids = [...new Set([...orders, ...matches].map((r) => r.sellerBusinessId))].filter((i) => i !== actor.businessId);
  const names = ids.length ? await identity.getTrustProfiles(ids) : new Map();
  return ids.map((id) => ({ businessId: id, name: names.get(id)?.name ?? "Supplier" })).sort((a, b) => a.name.localeCompare(b.name));
}

/** The call-off behind an order, for the order pages ("placed from contract RC/26-27/000003"). */
export async function rateContractLinkForOrder(actor: Actor, orderId: string): Promise<{ contractId: string; number: string; title: string; callOffNo: number } | null> {
  if (!UUID.test(orderId)) return null;
  const o = await prisma.rateContractCallOff.findUnique({ where: { orderId }, include: { contract: { select: { id: true, number: true, title: true, buyerBusinessId: true, sellerBusinessId: true } } } });
  if (!o || (o.contract.buyerBusinessId !== actor.businessId && o.contract.sellerBusinessId !== actor.businessId)) return null;
  return { contractId: o.contract.id, number: o.contract.number, title: o.contract.title, callOffNo: o.callOffNo };
}

// ---- writing helpers ---------------------------------------------------------------------------------------------------------------

async function nextRcNumber(tx: Tx, buyerBusinessId: string, fy: string): Promise<string> {
  // The upsert row-locks the (buyer, FY) counter until the transaction ends: a rollback releases the number and issuers serialise.
  const rows = await tx.$queryRaw<{ last_number: number }[]>`
    INSERT INTO rate_contract_sequences (buyer_business_id, financial_year, last_number) VALUES (${buyerBusinessId}::uuid, ${fy}, 1)
    ON CONFLICT (buyer_business_id, financial_year) DO UPDATE SET last_number = rate_contract_sequences.last_number + 1
    RETURNING last_number`;
  return formatRcNumber(fy, rows[0]!.last_number);
}

async function lock(tx: Tx, id: string): Promise<Full> {
  await tx.$queryRaw`SELECT id FROM rate_contracts WHERE id = ${id}::uuid FOR UPDATE`;
  const c = await tx.rateContract.findUnique({ where: { id }, include: INCLUDE });
  if (!c) throw new DomainError("not_found", "Rate contract not found");
  return c;
}

const notFound = () => new DomainError("not_found", "Rate contract not found");

function cleanTitle(t: string | null | undefined): string {
  const s = t?.trim() ?? "";
  if (s.length < 3 || s.length > 120) throw new DomainError("validation", "Give the contract a name (3 to 120 characters).", { title: "Give the contract a name (3 to 120 characters)." });
  return s;
}

/** Checks every catalogue reference belongs to the seller, so a contract cannot point at someone else's product. */
async function checkListings(sellerBusinessId: string, items: { listingId: string | null }[]): Promise<void> {
  for (const id of new Set(items.flatMap((i) => (i.listingId ? [i.listingId] : [])))) {
    const l = await catalogue.getPublicListing(id).catch(() => null);
    if (!l || l.sellerBusinessId !== sellerBusinessId) throw new DomainError("validation", "A product on the contract is not one of this supplier's published products.", { items: "Choose this supplier's products." });
  }
}

async function insertRevision(tx: Tx, contractId: string, revision: number, terms: ReturnType<typeof normaliseTerms>, by: { businessId: string; personId: string }): Promise<void> {
  const rev = await tx.rateContractRevision.create({
    data: {
      contractId, revision, proposedByBusinessId: by.businessId, proposedByPersonId: by.personId, validFrom: toDbDate(terms.validFrom), validTo: toDbDate(terms.validTo),
      paymentTermsDays: terms.paymentTermsDays, priceBasis: terms.priceBasis, valueCapPaise: terms.valueCapPaise === null ? null : BigInt(terms.valueCapPaise), notes: terms.notes, changeNote: terms.changeNote,
      items: { create: terms.items.map((i, n) => itemData(i, n)) },
    },
  });
  await tx.rateContractAcceptance.create({ data: { revisionId: rev.id, businessId: by.businessId, personId: by.personId, decision: "accepted" } });
}

const baseEvent = (c: Pick<RateContract, "id" | "number" | "buyerBusinessId" | "sellerBusinessId">) => ({ contractId: c.id, number: c.number, buyerBusinessId: c.buyerBusinessId, sellerBusinessId: c.sellerBusinessId });

// ---- creating --------------------------------------------------------------------------------------------------------------------

export interface CreateRateContractInput { sellerBusinessId: string; title: string; terms: RcTermsInput }

async function createDraftRow(actor: Actor, input: CreateRateContractInput, extra: { sourceQuoteId?: string | null; renewedFromId?: string | null }, now: Date): Promise<string> {
  if (!UUID.test(input.sellerBusinessId) || input.sellerBusinessId === actor.businessId) throw new DomainError("validation", "Choose the supplier for this contract.", { sellerBusinessId: "Choose the supplier." });
  const title = cleanTitle(input.title);
  const terms = normaliseTerms(input.terms, istDate(now));
  if (terms.items.some((i) => i.itemKey)) throw new DomainError("validation", "New contracts cannot reuse item keys.", { items: "Unknown item." });
  const seller = await identity.getPartyProfiles([input.sellerBusinessId]);
  if (!seller.has(input.sellerBusinessId)) throw new DomainError("validation", "Choose the supplier for this contract.", { sellerBusinessId: "Choose the supplier." });
  await checkListings(input.sellerBusinessId, terms.items);
  return prisma.$transaction(async (tx) => {
    const fy = financialYear(now);
    const number = await nextRcNumber(tx, actor.businessId, fy);
    const c = await tx.rateContract.create({
      data: { number, financialYear: fy, buyerBusinessId: actor.businessId, sellerBusinessId: input.sellerBusinessId, title, sourceQuoteId: extra.sourceQuoteId ?? null, renewedFromId: extra.renewedFromId ?? null },
    });
    // the buyer's own answer is recorded when the draft is sent; a draft carries no acceptance
    await tx.rateContractRevision.create({
      data: {
        contractId: c.id, revision: 1, proposedByBusinessId: actor.businessId, proposedByPersonId: actor.personId, validFrom: toDbDate(terms.validFrom), validTo: toDbDate(terms.validTo),
        paymentTermsDays: terms.paymentTermsDays, priceBasis: terms.priceBasis, valueCapPaise: terms.valueCapPaise === null ? null : BigInt(terms.valueCapPaise), notes: terms.notes, changeNote: terms.changeNote,
        items: { create: terms.items.map((i, n) => itemData(i, n)) },
      },
    });
    return c.id;
  });
}

const itemData = (i: ReturnType<typeof normaliseTerms>["items"][number], n: number) => ({
  itemKey: i.itemKey ?? randomUUID(), lineNo: n + 1, listingId: i.listingId, description: i.description, hsn: i.hsn, unit: i.unit, unitPricePaise: BigInt(i.unitPricePaise), gstRateBps: i.gstRateBps,
  moq: i.moq, quantityCap: i.quantityCap, variationKind: i.variationKind, variationCapBps: i.variationCapBps, variationNote: i.variationNote,
});

/** The buyer starts a contract from scratch. It stays a private draft until the buyer sends it. */
export async function createRateContract(actor: Actor, input: CreateRateContractInput, now: Date = new Date()): Promise<RateContractView> {
  assertRateContractsEnabled();
  const id = await createDraftRow(actor, input, {}, now);
  return (await getRateContract(actor, id, now))!;
}

const BASIS_FROM_DELIVERY: Record<string, PriceBasis> = { ex_works: "ex_works", buyer_pickup: "ex_works", door_delivery: "delivered", fob: "other", other: "other" };

/** Defaults for "convert to rate contract" from an accepted quote (no write). Null when the actor is not the buyer of that quote's lead. */
export async function suggestFromQuote(actor: Actor, quoteId: string, now: Date = new Date()): Promise<(CreateRateContractInput & { sourceQuoteId: string }) | null> {
  if (!UUID.test(quoteId)) return null;
  const q = await prisma.quote.findUnique({ where: { id: quoteId }, include: { conversation: { include: { match: { include: { enquiry: { select: { title: true, buyerBusinessId: true } } } } } } } });
  const match = q?.conversation.match;
  if (!q || !match || match.enquiry.buyerBusinessId !== actor.businessId || match.status !== "accepted") return null;
  const gst = 1800;
  const price = Number(q.pricePaise);
  const unitPrice = q.gstIncluded ? Math.round((price * 10_000) / (10_000 + gst)) : price;
  const today = istDate(now);
  return {
    sourceQuoteId: q.id, sellerBusinessId: match.sellerBusinessId, title: `${match.enquiry.title} (rate contract)`.slice(0, 120),
    terms: {
      validFrom: today, validTo: addDays(today, 364), paymentTermsDays: paymentTermsToDays(q.paymentTerms) ?? 30, priceBasis: BASIS_FROM_DELIVERY[q.deliveryTerms ?? ""] ?? "other",
      notes: null, items: [{ description: match.enquiry.title.slice(0, 300), unit: q.unit, unitPricePaise: Math.max(1, unitPrice), gstRateBps: gst, moq: q.moq ?? null }],
    },
  };
}

/** "Convert to rate contract": a draft pre-filled from an accepted quote. The buyer reviews it, then sends it to the supplier. */
export async function createRateContractFromQuote(actor: Actor, quoteId: string, overrides: { title?: string; terms?: RcTermsInput } = {}, now: Date = new Date()): Promise<RateContractView> {
  assertRateContractsEnabled();
  const s = await suggestFromQuote(actor, quoteId, now);
  if (!s) throw new DomainError("not_found", "Quote not found");
  const id = await createDraftRow(actor, { sellerBusinessId: s.sellerBusinessId, title: overrides.title ?? s.title, terms: overrides.terms ?? s.terms }, { sourceQuoteId: s.sourceQuoteId }, now);
  return (await getRateContract(actor, id, now))!;
}

/** The buyer edits the draft (revision 1 is replaced in place until it is sent; a sent revision is never edited). */
export async function updateRateContractDraft(actor: Actor, id: string, input: { title?: string; terms: RcTermsInput }, now: Date = new Date()): Promise<RateContractView> {
  assertRateContractsEnabled();
  if (!UUID.test(id)) throw notFound();
  const terms = normaliseTerms(input.terms, istDate(now));
  await prisma.$transaction(async (tx) => {
    const c = await lock(tx, id);
    if (c.buyerBusinessId !== actor.businessId) throw notFound();
    if (c.status !== "draft") throw new DomainError("conflict", "This contract was already sent. Propose a new revision instead.");
    await checkListings(c.sellerBusinessId, terms.items);
    const rev = c.revisions.find((r) => r.revision === 1)!;
    const keep = new Set(rev.items.map((i) => i.itemKey));
    if (terms.items.some((i) => i.itemKey && !keep.has(i.itemKey))) throw new DomainError("validation", "Unknown item.", { items: "Unknown item." });
    await tx.rateContractItem.deleteMany({ where: { revisionId: rev.id } });
    await tx.rateContractRevision.update({
      where: { id: rev.id },
      data: {
        validFrom: toDbDate(terms.validFrom), validTo: toDbDate(terms.validTo), paymentTermsDays: terms.paymentTermsDays, priceBasis: terms.priceBasis,
        valueCapPaise: terms.valueCapPaise === null ? null : BigInt(terms.valueCapPaise), notes: terms.notes, changeNote: terms.changeNote, proposedByPersonId: actor.personId,
        items: { create: terms.items.map((i, n) => itemData(i, n)) },
      },
    });
    if (input.title !== undefined) await tx.rateContract.update({ where: { id }, data: { title: cleanTitle(input.title) } });
  });
  return (await getRateContract(actor, id, now))!;
}

/** The buyer sends the draft: it becomes a proposal and the supplier is asked to accept, change or decline it. */
export async function sendRateContract(actor: Actor, id: string, now: Date = new Date()): Promise<RateContractView> {
  assertRateContractsEnabled();
  if (!UUID.test(id)) throw notFound();
  await prisma.$transaction(async (tx) => {
    const c = await lock(tx, id);
    if (c.buyerBusinessId !== actor.businessId) throw notFound();
    if (c.status !== "draft") throw new DomainError("conflict", "This contract was already sent.");
    const rev = c.revisions.find((r) => r.revision === 1)!;
    if (fromDbDate(rev.validTo) < istDate(now)) throw new DomainError("validation", "The end date is already in the past. Edit the dates first.", { validTo: "The end date is already in the past." });
    await tx.rateContractAcceptance.create({ data: { revisionId: rev.id, businessId: actor.businessId, personId: actor.personId, decision: "accepted" } });
    await tx.rateContract.update({ where: { id }, data: { status: "proposed" } });
    await emit(tx, "RateContractProposed", { type: "rate_contract", id }, { ...baseEvent(c), revision: 1, proposedByBusinessId: actor.businessId, amendment: false, validFrom: fromDbDate(rev.validFrom), validTo: fromDbDate(rev.validTo) });
  });
  return (await getRateContract(actor, id, now))!;
}

// ---- amendments and answers --------------------------------------------------------------------------------------------------

/** What an amendment may not do to an accepted revision that already has call-offs against it. */
function assertAmendable(c: Full, terms: ReturnType<typeof normaliseTerms>, today: string): void {
  const active = c.revisions.find((r) => r.revision === c.activeRevision);
  if (!active) return;
  const used = consumptionOf(c);
  const keys = new Set(c.revisions.flatMap((r) => r.items.map((i) => i.itemKey)));
  if (terms.items.some((i) => i.itemKey && !keys.has(i.itemKey))) throw new DomainError("validation", "Unknown item.", { items: "Unknown item." });
  const fail = (m: string): never => { throw new DomainError("validation", m, { items: m }); };
  if (fromDbDate(active.validFrom) <= today && terms.validFrom !== fromDbDate(active.validFrom)) {
    throw new DomainError("validation", "The contract has started, so its start date cannot change.", { validFrom: "The contract has started, so its start date cannot change." });
  }
  const byKey = new Map(terms.items.filter((i) => i.itemKey).map((i) => [i.itemKey!, i]));
  for (const prev of active.items) {
    const q = used.byItem.get(prev.itemKey);
    if (!q) continue;
    const next = byKey.get(prev.itemKey);
    if (!next) fail(`${prev.description} already has call-offs, so it cannot be removed.`);
    else if (next.unit !== prev.unit) fail(`The unit of ${prev.description} cannot change after call-offs were placed.`);
    else if (next.quantityCap !== null && next.quantityCap < q.quantity) fail(`The quantity cap of ${prev.description} cannot be below the ${q.quantity} already called off.`);
  }
  if (terms.valueCapPaise !== null && terms.valueCapPaise < used.valuePaise) {
    throw new DomainError("validation", "The value cap cannot be below what has already been called off.", { valueCapPaise: "Below what has been called off." });
  }
}

/**
 * Either party proposes a new revision (an amendment, a counter-proposal, or an extension of the end date). It supersedes any revision
 * still waiting for an answer; the proposer's own acceptance is recorded with it and the other party must accept it.
 */
export async function proposeRateContractRevision(actor: Actor, id: string, terms: RcTermsInput, now: Date = new Date()): Promise<RateContractView> {
  assertRateContractsEnabled();
  if (!UUID.test(id)) throw notFound();
  const today = istDate(now);
  const t = normaliseTerms(terms, today);
  await prisma.$transaction(async (tx) => {
    const c = await lock(tx, id);
    const role = roleOf(c, actor);
    if (!role || (role === "seller" && c.status === "draft")) throw notFound();
    if (c.status !== "proposed" && c.status !== "active") throw new DomainError("conflict", c.status === "draft" ? "Send the contract first, or edit the draft." : `This contract is ${c.status}. Start a renewal instead.`);
    await checkListings(c.sellerBusinessId, t.items);
    assertAmendable(c, t, today);
    const n = c.latestRevision + 1;
    await insertRevision(tx, id, n, t, actor);
    await tx.rateContract.update({ where: { id }, data: { latestRevision: n } });
    await emit(tx, "RateContractProposed", { type: "rate_contract", id }, { ...baseEvent(c), revision: n, proposedByBusinessId: actor.businessId, amendment: c.activeRevision !== null, validFrom: t.validFrom, validTo: t.validTo });
  });
  return (await getRateContract(actor, id, now))!;
}

export interface RespondInput { revision: number; decision: "accepted" | "rejected"; reason?: string | null }

/** The other party accepts or declines the pending revision. When both have accepted, the revision is in force. */
export async function respondToRateContract(actor: Actor, id: string, input: RespondInput, now: Date = new Date()): Promise<RateContractView> {
  assertRateContractsEnabled();
  if (!UUID.test(id)) throw notFound();
  if (input.decision !== "accepted" && input.decision !== "rejected") throw new DomainError("validation", "Choose accept or decline.");
  const reason = input.reason?.trim() || null;
  if (reason && reason.length > 500) throw new DomainError("validation", "Keep the reason under 500 characters.", { reason: "Keep it under 500 characters." });
  if (input.decision === "rejected" && (!reason || reason.length < 3)) throw new DomainError("validation", "Say why you are declining.", { reason: "Say why you are declining." });
  await prisma.$transaction(async (tx) => {
    const c = await lock(tx, id);
    const role = roleOf(c, actor);
    if (!role || (role === "seller" && c.status === "draft")) throw notFound();
    if (c.status !== "proposed" && c.status !== "active") throw new DomainError("conflict", `This contract is ${c.status}.`);
    if (input.revision !== c.latestRevision) throw new DomainError("conflict", "A newer revision was proposed. Reload and answer that one.");
    if (input.revision === c.activeRevision) throw new DomainError("conflict", "This revision is already in force.");
    const rev = c.revisions.find((r) => r.revision === input.revision)!;
    if (rev.proposedByBusinessId === actor.businessId) throw new DomainError("conflict", "You proposed this revision. The other party has to answer it.");
    const a = answers(rev, c);
    if ((role === "buyer" ? a.buyer : a.seller) !== "pending") throw new DomainError("conflict", "You already answered this revision.");
    await tx.rateContractAcceptance.create({ data: { revisionId: rev.id, businessId: actor.businessId, personId: actor.personId, decision: input.decision, reason } });
    if (input.decision === "rejected") {
      await emit(tx, "RateContractRejected", { type: "rate_contract", id }, { ...baseEvent(c), revision: rev.revision, rejectedByBusinessId: actor.businessId, reason });
      return;
    }
    if (fromDbDate(rev.validTo) < istDate(now)) throw new DomainError("conflict", "This revision has already ended. Ask for new dates.");
    const amendment = c.activeRevision !== null;
    await tx.rateContract.update({ where: { id }, data: { status: "active", activeRevision: rev.revision } });
    await emit(tx, "RateContractActivated", { type: "rate_contract", id }, { ...baseEvent(c), revision: rev.revision, amendment, validFrom: fromDbDate(rev.validFrom), validTo: fromDbDate(rev.validTo) });
  });
  return (await getRateContract(actor, id, now))!;
}

/** Either party ends the contract (a buyer may also discard an unsent draft). Orders already placed are not affected. */
export async function terminateRateContract(actor: Actor, id: string, reason: string, now: Date = new Date()): Promise<RateContractView> {
  assertRateContractsEnabled();
  if (!UUID.test(id)) throw notFound();
  const why = reason?.trim() ?? "";
  if (why.length < 3 || why.length > 300) throw new DomainError("validation", "Give a reason (3 to 300 characters).", { reason: "Give a reason (3 to 300 characters)." });
  await prisma.$transaction(async (tx) => {
    const c = await lock(tx, id);
    const role = roleOf(c, actor);
    if (!role || (role === "seller" && c.status === "draft")) throw notFound();
    if (c.status === "terminated" || c.status === "expired") throw new DomainError("conflict", `This contract is already ${c.status}.`);
    await tx.rateContract.update({ where: { id }, data: { status: "terminated", terminatedAt: now, terminatedByBusinessId: actor.businessId, terminationReason: why } });
    if (c.status !== "draft") await emit(tx, "RateContractTerminated", { type: "rate_contract", id }, { ...baseEvent(c), terminatedByBusinessId: actor.businessId, reason: why });
  });
  return (await getRateContract(actor, id, now))!;
}

/** An explicit renewal: a NEW draft with the same terms and a shifted period. Nothing is renewed by itself; both parties accept it again. */
export async function startRateContractRenewal(actor: Actor, id: string, now: Date = new Date()): Promise<RateContractView> {
  assertRateContractsEnabled();
  if (!UUID.test(id)) throw notFound();
  const c = await prisma.rateContract.findUnique({ where: { id }, include: INCLUDE });
  if (!c || c.buyerBusinessId !== actor.businessId) throw notFound();
  const rev = c.revisions.find((r) => r.revision === (c.activeRevision ?? c.latestRevision))!;
  if (c.status !== "active" && c.status !== "expired") throw new DomainError("conflict", "Only an active or expired contract can be renewed.");
  const dates = renewalDates(fromDbDate(rev.validFrom), fromDbDate(rev.validTo), istDate(now));
  const items: RcItemInput[] = [...rev.items].sort((a, b) => a.lineNo - b.lineNo).map((i) => ({
    listingId: i.listingId, description: i.description, hsn: i.hsn, unit: i.unit, unitPricePaise: Number(i.unitPricePaise), gstRateBps: i.gstRateBps, moq: i.moq, quantityCap: i.quantityCap,
    variationKind: i.variationKind === "indexed" ? "indexed" : "fixed", variationCapBps: i.variationCapBps, variationNote: i.variationNote,
  }));
  const newId = await createDraftRow(actor, {
    sellerBusinessId: c.sellerBusinessId, title: c.title,
    terms: { ...dates, paymentTermsDays: rev.paymentTermsDays, priceBasis: rev.priceBasis as PriceBasis, valueCapPaise: rev.valueCapPaise === null ? null : Number(rev.valueCapPaise), notes: rev.notes, changeNote: `Renewal of ${c.number}`, items },
  }, { renewedFromId: c.id }, now);
  return (await getRateContract(actor, newId, now))!;
}

// ---- call-offs ---------------------------------------------------------------------------------------------------------------------

export interface CallOffInput {
  /** a saved delivery address of the buyer; needed when purchase orders are enabled */
  addressId?: string | null;
  /** "YYYY-MM-DD" */
  expectedDelivery?: string | null;
  notes?: string | null;
  lines: CallOffLineInput[];
  /** makes a retry safe: the same key on the same contract returns the original call-off instead of ordering twice (1 to 100 characters) */
  idempotencyKey?: string | null;
}

export interface CallOffResult {
  callOff: RcCallOffView;
  orderId: string;
  purchaseOrder: PurchaseOrderView | null;
  /** set when the order was created but the purchase order could not be issued; the buyer can issue it from the order page */
  purchaseOrderError: string | null;
  contract: RateContractView;
}

/**
 * The buyer places a call-off: an order at the contract prices, without an RFQ. Prices are locked from the contract (an indexed item
 * may move inside its declared band), the minimum per call-off applies, and the item and value caps are enforced under a row lock.
 * When purchase orders are enabled a PO is issued for the order right away. Crossing 80% / 100% of a cap emits one warning each.
 */
export async function placeCallOff(actor: Actor, contractId: string, input: CallOffInput, now: Date = new Date()): Promise<CallOffResult> {
  assertRateContractsEnabled();
  if (!UUID.test(contractId)) throw notFound();
  const today = istDate(now);
  const poOn = purchaseOrdersEnabled();
  // access first, so a non-party learns nothing from the validation messages below
  const owner = await prisma.rateContract.findUnique({ where: { id: contractId }, select: { buyerBusinessId: true } });
  if (!owner || owner.buyerBusinessId !== actor.businessId) throw notFound();
  const idem = input.idempotencyKey?.trim() || null;
  if (idem !== null && idem.length > 100) throw new DomainError("validation", "The idempotency key can be up to 100 characters.", { idempotencyKey: "Up to 100 characters." });
  const replay = async (callOffId: string): Promise<CallOffResult> => {
    const contract = (await getRateContract(actor, contractId, now))!;
    const callOff = contract.callOffs.find((o) => o.id === callOffId)!;
    return { callOff, orderId: callOff.orderId, purchaseOrder: await getPurchaseOrderForOrder(actor, callOff.orderId, now), purchaseOrderError: null, contract };
  };
  if (idem !== null) {
    const prior = await prisma.rateContractCallOff.findUnique({ where: { contractId_idempotencyKey: { contractId, idempotencyKey: idem } }, select: { id: true } });
    if (prior) return replay(prior.id);
  }
  if (input.expectedDelivery && (!isIsoDate(input.expectedDelivery) || input.expectedDelivery < today)) {
    throw new DomainError("validation", "Enter a valid delivery date (not in the past).", { expectedDelivery: "Enter a valid delivery date." });
  }
  if (poOn) {
    if (!input.addressId) throw new DomainError("validation", "Choose a delivery address.", { addressId: "Choose a delivery address." });
    if (!(await identity.listAddresses(actor.businessId)).some((a) => a.id === input.addressId)) throw new DomainError("validation", "Choose one of your saved addresses.", { addressId: "Choose one of your saved addresses." });
  }
  const placed = await prisma.$transaction(async (tx) => {
    const c = await lock(tx, contractId);
    if (c.buyerBusinessId !== actor.businessId) throw notFound();
    const dup = idem === null ? undefined : c.callOffs.find((o) => o.idempotencyKey === idem); // a parallel retry that waited for the lock
    if (dup) return dup.id; // the id of the call-off to replay
    if (c.status !== "active") throw new DomainError("conflict", c.status === "expired" ? "This contract has expired. Start a renewal." : `This contract is ${c.status}, so call-offs are not possible.`);
    const rev = c.revisions.find((r) => r.revision === c.activeRevision)!;
    const phase = phaseOf(fromDbDate(rev.validFrom), fromDbDate(rev.validTo), today);
    if (phase === "not_started") throw new DomainError("conflict", `This contract starts on ${fromDbDate(rev.validFrom)}.`);
    if (phase === "ended") throw new DomainError("conflict", "This contract has ended. Start a renewal.");
    const used = consumptionOf(c);
    const cap = rev.valueCapPaise === null ? null : Number(rev.valueCapPaise);
    const priced = priceCallOff(
      rev.items.map((i) => ({ itemKey: i.itemKey, description: i.description, unit: i.unit, unitPricePaise: Number(i.unitPricePaise), moq: i.moq, quantityCap: i.quantityCap, variationKind: i.variationKind, variationCapBps: i.variationCapBps })),
      cap, used, input.lines,
    );
    const single = priced.lines.length === 1 ? priced.lines[0]! : null;
    const order = await tx.order.create({
      data: {
        buyerBusinessId: c.buyerBusinessId, sellerBusinessId: c.sellerBusinessId, status: "recorded", buyerConfirmedAt: now,
        pricePaise: single ? BigInt(single.appliedPricePaise) : null, quantity: single?.quantity ?? null, unit: single?.unit ?? null, totalPaise: BigInt(priced.taxablePaise),
      },
    });
    const callOffNo = (c.callOffs.reduce((m, o) => Math.max(m, o.callOffNo), 0)) + 1;
    const co = await tx.rateContractCallOff.create({
      data: {
        contractId, revision: rev.revision, callOffNo, orderId: order.id, taxablePaise: BigInt(priced.taxablePaise), placedByPersonId: actor.personId, idempotencyKey: idem,
        lines: { create: priced.lines.map((l) => ({ itemKey: l.itemKey, lineNo: l.lineNo, description: l.description, unit: l.unit, quantity: l.quantity, contractPricePaise: BigInt(l.contractPricePaise), appliedPricePaise: BigInt(l.appliedPricePaise), taxablePaise: BigInt(l.taxablePaise) })) },
      },
      include: { lines: true },
    });
    await emit(tx, "RateContractCallOffPlaced", { type: "rate_contract", id: contractId }, { ...baseEvent(c), callOffId: co.id, callOffNo, orderId: order.id, taxablePaise: priced.taxablePaise, lineCount: priced.lines.length });

    // consumption warnings: one per scope and threshold, only the highest newly crossed one is announced
    const warn = async (scope: string, before: number, after: number, capValue: number | null, ev: { scope: "item" | "value"; itemKey: string | null; itemDescription: string | null }) => {
      const crossed = thresholdsCrossed(before, after, capValue);
      if (crossed.length === 0 || capValue === null) return;
      const have = new Set((await tx.rateContractAlert.findMany({ where: { contractId, scope }, select: { threshold: true } })).map((a) => a.threshold));
      const fresh = crossed.filter((t) => !have.has(t));
      if (fresh.length === 0) return;
      await tx.rateContractAlert.createMany({ data: crossed.map((threshold) => ({ contractId, scope, threshold })), skipDuplicates: true });
      const top = Math.max(...fresh) as WarnThreshold;
      await emit(tx, "RateContractConsumptionWarning", { type: "rate_contract", id: contractId }, { ...baseEvent(c), ...ev, threshold: top, usedPercent: usedPercent(after, capValue) });
    };
    for (const l of priced.lines) {
      const item = rev.items.find((i) => i.itemKey === l.itemKey)!;
      const before = used.byItem.get(l.itemKey)?.quantity ?? 0;
      await warn(l.itemKey, before, before + l.quantity, item.quantityCap, { scope: "item", itemKey: l.itemKey, itemDescription: item.description });
    }
    await warn("value", used.valuePaise, used.valuePaise + priced.taxablePaise, cap, { scope: "value", itemKey: null, itemDescription: null });
    return { orderId: order.id, callOffId: co.id, rev, priced };
  });
  if (typeof placed === "string") return replay(placed);

  // The PO follows the order. A failure here must not undo the call-off (quantities are consumed, the order exists): report it instead.
  let purchaseOrder: PurchaseOrderView | null = null;
  let purchaseOrderError: string | null = null;
  if (poOn) {
    const lines: PoLineInput[] = placed.priced.lines.map((l) => {
      const item = placed.rev.items.find((i) => i.itemKey === l.itemKey)!;
      return { description: l.description, hsn: item.hsn, quantity: l.quantity, unit: l.unit, unitPricePaise: l.appliedPricePaise, gstRateBps: item.gstRateBps, priceIncludesGst: false };
    });
    try {
      purchaseOrder = await issuePurchaseOrder(actor, placed.orderId, { addressId: input.addressId, paymentTermsDays: placed.rev.paymentTermsDays, expectedDelivery: input.expectedDelivery ?? null, notes: input.notes ?? null, lines }, now);
    } catch (e) {
      purchaseOrderError = e instanceof DomainError ? e.message : "The purchase order could not be issued. Issue it from the order page.";
      if (!(e instanceof DomainError)) console.error("[enquiry] call-off purchase order failed", e);
    }
  }
  const contract = (await getRateContract(actor, contractId, now))!;
  const callOff = contract.callOffs.find((o) => o.id === placed.callOffId)!;
  return { callOff, orderId: placed.orderId, purchaseOrder, purchaseOrderError, contract };
}

/** Order cancelled: its call-off is cancelled and the quantities go back to the contract (called inside the order transaction). */
export async function onOrderCancelledReleaseCallOffTx(tx: Tx, orderId: string, now: Date = new Date()): Promise<void> {
  const co = await tx.rateContractCallOff.findUnique({ where: { orderId }, include: { contract: true } });
  if (!co || co.status === "cancelled") return;
  await tx.rateContractCallOff.update({ where: { id: co.id }, data: { status: "cancelled", cancelledAt: now } });
  await emit(tx, "RateContractCallOffReleased", { type: "rate_contract", id: co.contractId }, { ...baseEvent(co.contract), callOffId: co.id, orderId });
}

// ---- scheduled sweep ---------------------------------------------------------------------------------------------------------------

/**
 * Hourly job: contracts whose accepted period has ended become `expired` (a proposal whose dates passed unanswered also expires), and
 * the two sides get a reminder 30 and 7 days before the end. Each reminder is recorded with its event in one transaction, so it is
 * sent once. If the job was down, only the current stage is sent. Nothing is ever renewed here.
 */
export async function sweepRateContracts(now: Date = new Date()): Promise<{ expired: number; reminded: number }> {
  if (!rateContractsEnabled()) return { expired: 0, reminded: 0 };
  const today = istDate(now);
  let expired = 0;
  let reminded = 0;
  let after: string | undefined;
  for (;;) {
    const rows = await prisma.rateContract.findMany({
      where: { status: { in: ["proposed", "active"] } }, include: { revisions: { select: { revision: true, validTo: true } } }, orderBy: { id: "asc" }, take: 200,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.id;
    for (const c of rows) {
      const rev = c.revisions.find((r) => r.revision === (c.activeRevision ?? c.latestRevision));
      if (!rev) continue;
      const validTo = fromDbDate(rev.validTo);
      if (validTo < today) {
        const done = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM rate_contracts WHERE id = ${c.id}::uuid FOR UPDATE`;
          const fresh = await tx.rateContract.findUnique({ where: { id: c.id } });
          if (!fresh || (fresh.status !== "active" && fresh.status !== "proposed")) return false;
          await tx.rateContract.update({ where: { id: c.id }, data: { status: "expired", expiredAt: now } });
          await emit(tx, "RateContractExpired", { type: "rate_contract", id: c.id }, { ...baseEvent(c), validTo });
          return true;
        });
        if (done) expired++;
        continue;
      }
      const stage = c.status === "active" ? expiryReminderStage(validTo, today) : null;
      if (!stage) continue;
      const sent = await prisma.$transaction(async (tx) => {
        const ins = await tx.rateContractAlert.createMany({ data: [{ contractId: c.id, scope: "expiry", threshold: stage }], skipDuplicates: true });
        if (ins.count === 0) return false;
        await emit(tx, "RateContractExpiryReminder", { type: "rate_contract", id: c.id }, { ...baseEvent(c), daysLeft: stage, validTo });
        return true;
      });
      if (sent) reminded++;
    }
    if (rows.length < 200) break;
  }
  return { expired, reminded };
}

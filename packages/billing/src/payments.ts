// Real payments (ADR-001/005): checkout -> provider webhook -> fulfil exactly once -> GST invoice -> events.
// Hosted checkout only, no card data (ADR-010). Design: docs/design/payments-and-invoicing.md
import { DomainError, emit } from "@cnote/core";
import { prisma, type Tx } from "@cnote/db";
import { grantCreditsTx } from "./ledger";
import { getPlan } from "./plans";
import { activatePlanTx } from "./subscriptions";
import {
  configuredProvider, getProvider, isProviderName, mockSign, type CustomerInfo, type ParsedWebhook, type ProviderName,
} from "./payment-providers";
import { issueInvoiceTx, isIntraState, placeOfSupply, platformSupplier, splitGst, type InvoiceLineInput, type InvoiceView } from "./invoices";
import { loadParty } from "./parties";
import type { CancellationQuote } from "./types";

export { configuredProvider, type ProviderName, type PaymentProvider } from "./payment-providers";

// ---- catalogue ---------------------------------------------------------------------------------------------------

export interface CreditPack { id: string; credits: number; pricePaise: number; label: string }
/** Ex-GST prices (GST is added and shown separately at checkout, ADR-005). Cheaper per credit than Starter's overage-free plan is NOT intended: packs are top-ups. */
export const CREDIT_PACKS: readonly CreditPack[] = [
  { id: "credits_20", credits: 20, pricePaise: 39_900, label: "20 lead credits" },
  { id: "credits_50", credits: 50, pricePaise: 89_900, label: "50 lead credits" },
  { id: "credits_150", credits: 150, pricePaise: 239_900, label: "150 lead credits" },
];
export const listCreditPacks = (): CreditPack[] => CREDIT_PACKS.map((p) => ({ ...p }));

// ---- coupon port (billing must not import @cnote/promotions) --------------------------------------------------------

export interface CouponQuote { discountPaise: number; creditsBonus: number; couponId: string }
export interface CouponPort {
  quote(code: string, ctx: { businessId: string; planCode?: string; amountPaise: number }): Promise<CouponQuote>;
  redeem(couponId: string, ctx: { businessId: string; paymentOrderId: string }): Promise<unknown>;
}
let couponPort: CouponPort | null = null;
/** Composition root: `setCouponPort(couponPortFromModule(await import("@cnote/promotions")))`. */
export function setCouponPort(p: CouponPort | null): void { couponPort = p; }
/** Adapts a module exposing quoteCoupon/redeemCoupon; null when either is missing (typeof guards). */
export function couponPortFromModule(m: unknown): CouponPort | null {
  const mod = m as { quoteCoupon?: unknown; redeemCoupon?: unknown };
  if (typeof mod?.quoteCoupon !== "function" || typeof mod?.redeemCoupon !== "function") return null;
  const q = mod.quoteCoupon as (c: string, x: object) => Promise<CouponQuote>;
  const r = mod.redeemCoupon as (id: string, x: object) => Promise<unknown>;
  return { quote: (c, x) => q(c, x), redeem: (id, x) => r(id, x) };
}

// ---- extension point for other purposes (e.g. "ad_topup") -------------------------------------------------------------

export interface PurposeFulfilment { description?: string; sac?: string }
export type PurposeHandler = (tx: Tx, order: { id: string; businessId: string; purposeRef: string | null; amountPaise: number; totalPaise: number }) => Promise<PurposeFulfilment | void>;
const purposeHandlers = new Map<string, PurposeHandler>();
export function registerPaymentPurpose(purpose: string, h: PurposeHandler): void { purposeHandlers.set(purpose, h); }

// ---- types -------------------------------------------------------------------------------------------------------

export interface CheckoutActor extends CustomerInfo { businessId: string }
export type CheckoutInput =
  | { purpose: "subscription"; planCode: string; couponCode?: string }
  | { purpose: "credit_pack"; packId: string; couponCode?: string };
export interface CheckoutQuote {
  description: string; listPaise: number; discountPaise: number; taxablePaise: number; gstPaise: number; totalPaise: number;
  cgstPaise: number; sgstPaise: number; igstPaise: number; gstRateBps: number; placeOfSupply: string; creditsBonus: number; couponId: string | null;
}
export interface CheckoutResult { orderId: string; provider: ProviderName; redirectUrl: string; totalPaise: number }
export interface PaymentOrderView {
  id: string; businessId: string; purpose: string; purposeRef: string | null; provider: string; status: string; amountPaise: number; gstPaise: number; totalPaise: number;
  discountPaise: number; couponCode: string | null; failureReason: string | null; fulfilledAt: string | null; createdAt: string; refundedPaise: number; invoiceId: string | null;
}

// purposeRef carries "<planCode|packId>[|couponId|creditsBonus]" (no schema column for coupon linkage yet).
const encRef = (ref: string, c?: CouponQuote | null) => (c ? `${ref}|${c.couponId}|${c.creditsBonus}` : ref);
export function decodeRef(v: string | null): { ref: string; couponId: string | null; creditsBonus: number } {
  const [ref = "", couponId, bonus] = (v ?? "").split("|");
  return { ref, couponId: couponId || null, creditsBonus: Number(bonus) || 0 };
}

// ---- quote + start checkout ----------------------------------------------------------------------------------------

async function resolveItem(input: CheckoutInput): Promise<{ ref: string; description: string; listPaise: number; planCode?: string }> {
  if (input.purpose === "subscription") {
    const plan = await getPlan(input.planCode);
    if (plan.monthlyPricePaise <= 0) throw new DomainError("validation", "The free plan needs no payment.");
    return { ref: plan.code, description: `${plan.name} plan - 1 month (${plan.monthlyCredits} lead credits)`, listPaise: plan.monthlyPricePaise, planCode: plan.code };
  }
  const pack = CREDIT_PACKS.find((p) => p.id === input.packId);
  if (!pack) throw new DomainError("not_found", "Credit pack not found");
  return { ref: pack.id, description: `${pack.label} (valid 90 days)`, listPaise: pack.pricePaise };
}

export async function quoteCheckout(actor: CheckoutActor, input: CheckoutInput): Promise<CheckoutQuote & { ref: string; coupon: CouponQuote | null }> {
  const item = await resolveItem(input);
  let coupon: CouponQuote | null = null;
  if (input.couponCode) {
    if (!couponPort) throw new DomainError("validation", "Coupons are not available right now.");
    coupon = await couponPort.quote(input.couponCode, { businessId: actor.businessId, planCode: item.planCode, amountPaise: item.listPaise });
  }
  const discountPaise = Math.min(Math.max(0, coupon?.discountPaise ?? 0), item.listPaise);
  const taxable = item.listPaise - discountPaise;
  if (taxable <= 0) throw new DomainError("validation", "Nothing to pay after the discount.");
  const sup = platformSupplier();
  const party = await loadParty(actor.businessId);
  const pos = placeOfSupply(party.stateCode, sup.stateCode);
  const g = splitGst(taxable, sup.gstRateBps, isIntraState(pos, sup.stateCode));
  return {
    ref: item.ref, coupon, description: item.description, listPaise: item.listPaise, discountPaise, taxablePaise: taxable, gstPaise: g.gstPaise, totalPaise: g.totalPaise,
    cgstPaise: g.cgstPaise, sgstPaise: g.sgstPaise, igstPaise: g.igstPaise, gstRateBps: sup.gstRateBps, placeOfSupply: pos, creditsBonus: coupon?.creditsBonus ?? 0, couponId: coupon?.couponId ?? null,
  };
}

const bn = (n: number) => BigInt(n);

/** Creates the PaymentOrder and the provider's hosted checkout. The customer is redirected to `redirectUrl`; the webhook fulfils. */
export async function startCheckout(actor: CheckoutActor, input: CheckoutInput): Promise<CheckoutResult> {
  if (input.purpose === "subscription") {
    const cur = await prisma.subscription.findFirst({ where: { businessId: actor.businessId, status: "active", periodEnd: { gt: new Date() } } });
    if (cur?.planCode === input.planCode) throw new DomainError("conflict", "You are already on this plan.");
  }
  const q = await quoteCheckout(actor, input);
  return createProviderOrder(actor, {
    purpose: input.purpose, purposeRef: encRef(q.ref, q.coupon), description: q.description, amountPaise: q.taxablePaise, gstPaise: q.gstPaise, totalPaise: q.totalPaise,
    couponCode: input.couponCode ?? null, discountPaise: q.discountPaise,
  });
}

/** Lower-level entry for other modules' purposes (ad top-ups): amounts are already computed by the caller. */
export async function createProviderOrder(
  actor: CheckoutActor,
  o: { purpose: string; purposeRef: string | null; description: string; amountPaise: number; gstPaise: number; totalPaise: number; couponCode?: string | null; discountPaise?: number },
): Promise<CheckoutResult> {
  const provider = configuredProvider();
  const adapter = getProvider(provider);
  const order = await prisma.paymentOrder.create({
    data: {
      businessId: actor.businessId, purpose: o.purpose, purposeRef: o.purposeRef, provider, amountPaise: bn(o.amountPaise), gstPaise: bn(o.gstPaise), totalPaise: bn(o.totalPaise),
      couponCode: o.couponCode ?? null, discountPaise: bn(o.discountPaise ?? 0),
    },
  });
  try {
    const seller = process.env.SELLER_APP_URL || "http://localhost:3002";
    const api = process.env.API_PUBLIC_URL || "http://localhost:3003";
    const created = await adapter.createOrder({
      orderId: order.id, amountPaise: o.totalPaise, description: o.description, customer: { name: actor.name, email: actor.email, phone: actor.phone },
      returnUrl: `${seller}/billing/return?order=${order.id}`, notifyUrl: `${api}/webhooks/payments/${provider}`,
    });
    await prisma.paymentOrder.update({ where: { id: order.id }, data: { status: "pending", providerOrderId: created.providerOrderId } });
    return { orderId: order.id, provider, redirectUrl: created.redirectUrl, totalPaise: o.totalPaise };
  } catch (e) {
    await prisma.paymentOrder.update({ where: { id: order.id }, data: { status: "failed", failureReason: "provider_create_failed" } });
    throw e;
  }
}

// ---- fulfilment --------------------------------------------------------------------------------------------------

type OrderRow = NonNullable<Awaited<ReturnType<typeof prisma.paymentOrder.findUnique>>>;
export interface FulfilResult { fulfilled: boolean; invoice: InvoiceView | null; couponId: string | null }

async function lockOrder(tx: Tx, id: string): Promise<OrderRow | null> {
  await tx.$queryRaw`SELECT id FROM payment_orders WHERE id = ${id}::uuid FOR UPDATE`;
  return tx.paymentOrder.findUnique({ where: { id } });
}

/** Applies the purchase exactly once: row lock + fulfilledAt. Safe under concurrent/duplicate webhooks. */
export async function fulfilOrder(orderId: string, info: { providerPaymentId?: string; amountPaise?: number } = {}): Promise<FulfilResult> {
  const result = await prisma.$transaction(async (tx): Promise<FulfilResult> => {
    const order = await lockOrder(tx, orderId);
    if (!order) throw new DomainError("not_found", "Payment order not found");
    if (order.fulfilledAt) return { fulfilled: false, invoice: null, couponId: null };
    if (info.amountPaise !== undefined && BigInt(info.amountPaise) !== order.totalPaise) {
      // Never grant entitlements for a different amount than we asked for.
      await tx.paymentOrder.update({ where: { id: order.id }, data: { status: "failed", failureReason: "amount_mismatch" } });
      await emit(tx, "PaymentFailed", { type: "payment_order", id: order.id }, { paymentOrderId: order.id, businessId: order.businessId, purpose: order.purpose, reason: "amount_mismatch" });
      console.error(`[billing] amount mismatch order=${order.id} expected=${order.totalPaise} got=${info.amountPaise}`);
      return { fulfilled: false, invoice: null, couponId: null };
    }
    const ref = decodeRef(order.purposeRef);
    let description = `${order.purpose} ${ref.ref}`;
    let sac = platformSupplier().sac;
    if (order.purpose === "subscription") {
      const plan = await getPlan(ref.ref);
      await activatePlanTx(tx, order.businessId, plan.code, { allowSame: true });
      description = `${plan.name} plan - 1 month`;
    } else if (order.purpose === "credit_pack") {
      const pack = CREDIT_PACKS.find((p) => p.id === ref.ref);
      if (!pack) throw new DomainError("not_found", "Credit pack not found");
      await grantCreditsTx(tx, order.businessId, pack.credits, `pack:${pack.id}`, { refType: "payment", refId: order.id });
      description = pack.label;
    } else {
      const h = purposeHandlers.get(order.purpose);
      if (!h) throw new DomainError("conflict", `No fulfilment handler for purpose ${order.purpose}`);
      const r = await h(tx, { id: order.id, businessId: order.businessId, purposeRef: order.purposeRef, amountPaise: Number(order.amountPaise), totalPaise: Number(order.totalPaise) });
      if (r?.description) description = r.description;
      if (r?.sac) sac = r.sac;
    }
    if (ref.creditsBonus > 0) await grantCreditsTx(tx, order.businessId, ref.creditsBonus, "coupon_bonus", { refType: "payment_bonus", refId: order.id });

    const sup = platformSupplier();
    const party = await loadParty(order.businessId);
    const lines: InvoiceLineInput[] = [{ description, sac, quantity: 1, unitPaise: Number(order.amountPaise), gstRateBps: sup.gstRateBps }];
    const invoice = await issueInvoiceTx(tx, {
      kind: "tax_invoice", businessId: order.businessId, paymentOrderId: order.id, lines, supplier: sup,
      recipient: { name: party.name, gstin: party.gstin, address: party.address, stateCode: party.stateCode },
    });
    if (invoice.totalPaise !== Number(order.totalPaise)) throw new DomainError("conflict", "Invoice total does not match the charged amount");
    await tx.paymentOrder.update({
      where: { id: order.id },
      data: { status: "paid", fulfilledAt: new Date(), failureReason: null, ...(info.providerPaymentId ? { providerPaymentId: info.providerPaymentId } : {}) },
    });
    await emit(tx, "PaymentSucceeded", { type: "payment_order", id: order.id }, {
      paymentOrderId: order.id, businessId: order.businessId, purpose: order.purpose, totalPaise: Number(order.totalPaise), invoiceNumber: invoice.number,
    });
    return { fulfilled: true, invoice, couponId: ref.couponId };
  });
  if (result.fulfilled && result.couponId && couponPort) {
    const o = await prisma.paymentOrder.findUnique({ where: { id: orderId } });
    await couponPort.redeem(result.couponId, { businessId: o!.businessId, paymentOrderId: orderId }).catch((e) => console.error(`[billing] coupon redeem failed order=${orderId}`, e));
  }
  return result;
}

export async function failOrder(orderId: string, reason: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order || order.fulfilledAt || order.status === "failed" || order.status === "paid") return false;
    await tx.paymentOrder.update({ where: { id: order.id }, data: { status: "failed", failureReason: reason.slice(0, 200) } });
    await emit(tx, "PaymentFailed", { type: "payment_order", id: order.id }, { paymentOrderId: order.id, businessId: order.businessId, purpose: order.purpose, reason: reason.slice(0, 200) });
    return true;
  });
}

// ---- webhooks ----------------------------------------------------------------------------------------------------

export interface WebhookResult { status: 200 | 400 | 401; duplicate?: boolean }

async function resolveOrderId(p: ParsedWebhook, provider: string): Promise<string | null> {
  const isUuid = (v?: string) => !!v && /^[0-9a-f-]{36}$/i.test(v);
  if (isUuid(p.orderId)) {
    const o = await prisma.paymentOrder.findUnique({ where: { id: p.orderId }, select: { id: true } });
    if (o) return o.id;
  }
  if (p.providerOrderId) {
    const o = await prisma.paymentOrder.findFirst({ where: { provider, providerOrderId: p.providerOrderId }, select: { id: true } });
    if (o) return o.id;
  }
  return null;
}

/** Verify signature, log idempotently, fulfil/fail. Throws on infrastructure errors so the provider retries. */
export async function handlePaymentWebhook(providerName: string, raw: Uint8Array | string, headers: Headers | Record<string, string | undefined>): Promise<WebhookResult> {
  if (!isProviderName(providerName)) return { status: 400 };
  let parsed: ParsedWebhook | null;
  try {
    parsed = getProvider(providerName).verifyWebhook(raw, headers);
  } catch (e) {
    if (e instanceof DomainError && e.code === "validation") return { status: 400 };
    throw e;
  }
  if (!parsed) return { status: 401 };

  const orderId = await resolveOrderId(parsed, providerName);
  let eventRowId: string;
  try {
    const row = await prisma.paymentWebhookEvent.create({
      data: { provider: providerName, eventId: parsed.eventId, type: parsed.type, payload: { ...parsed.redacted, _orderId: orderId } as object },
    });
    eventRowId = row.id;
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
    const existing = await prisma.paymentWebhookEvent.findUnique({ where: { provider_eventId: { provider: providerName, eventId: parsed.eventId } } });
    if (existing?.processedAt) return { status: 200, duplicate: true };
    eventRowId = existing!.id; // a previous delivery crashed mid-way: reprocess (fulfilment itself is idempotent)
  }
  try {
    let error: string | null = null;
    if (parsed.outcome !== "ignored") {
      if (!orderId) error = "unknown_order";
      else if (parsed.outcome === "paid") await fulfilOrder(orderId, { providerPaymentId: parsed.providerPaymentId, amountPaise: parsed.amountPaise });
      else await failOrder(orderId, parsed.failureReason ?? "payment_failed");
    }
    await prisma.paymentWebhookEvent.update({ where: { id: eventRowId }, data: { processedAt: new Date(), error } });
    return { status: 200 };
  } catch (e) {
    await prisma.paymentWebhookEvent.update({ where: { id: eventRowId }, data: { error: String(e instanceof Error ? e.message : e).slice(0, 500) } }).catch(() => undefined);
    throw e;
  }
}

// ---- reads (seller return page, admin console) ---------------------------------------------------------------------

const view = (o: OrderRow & { refunds?: { amountPaise: bigint; status: string }[]; invoice?: { id: string } | null }): PaymentOrderView => ({
  id: o.id, businessId: o.businessId, purpose: o.purpose, purposeRef: o.purposeRef, provider: o.provider, status: o.status, amountPaise: Number(o.amountPaise), gstPaise: Number(o.gstPaise),
  totalPaise: Number(o.totalPaise), discountPaise: Number(o.discountPaise), couponCode: o.couponCode, failureReason: o.failureReason, fulfilledAt: o.fulfilledAt?.toISOString() ?? null,
  createdAt: o.createdAt.toISOString(), refundedPaise: (o.refunds ?? []).filter((r) => r.status !== "failed").reduce((a, r) => a + Number(r.amountPaise), 0), invoiceId: o.invoice?.id ?? null,
});

/** Owner view + reconciliation: if the webhook is late, ask the provider once and fulfil from its answer. */
export async function getPaymentStatus(actor: { businessId: string }, orderId: string, opts: { sync?: boolean } = {}): Promise<PaymentOrderView> {
  let o = await prisma.paymentOrder.findUnique({ where: { id: orderId }, include: { refunds: true, invoice: { select: { id: true } } } });
  if (!o || o.businessId !== actor.businessId) throw new DomainError("not_found", "Payment not found");
  if (opts.sync && (o.status === "pending" || o.status === "failed") && !o.fulfilledAt && o.provider !== "mock" && isProviderName(o.provider)) {
    const p = await getProvider(o.provider).fetchPayment({ id: o.id, providerOrderId: o.providerOrderId }).catch(() => null);
    if (p?.status === "paid") {
      await fulfilOrder(o.id, { providerPaymentId: p.providerPaymentId, amountPaise: p.amountPaise });
      o = (await prisma.paymentOrder.findUnique({ where: { id: orderId }, include: { refunds: true, invoice: { select: { id: true } } } }))!;
    }
  }
  return view(o);
}

/** Dev only: the local "pay" page. Signs a mock webhook and pushes it through the real webhook path. */
export async function completeMockPayment(actor: { businessId: string }, orderId: string, outcome: "paid" | "failed" = "paid"): Promise<PaymentOrderView> {
  if (process.env.NODE_ENV === "production" && process.env.PAYMENTS_ALLOW_MOCK_IN_PRODUCTION !== "1") throw new DomainError("forbidden", "Mock payments are disabled");
  const o = await prisma.paymentOrder.findUnique({ where: { id: orderId } });
  if (!o || o.businessId !== actor.businessId || o.provider !== "mock") throw new DomainError("not_found", "Payment not found");
  const body = JSON.stringify(
    outcome === "paid"
      ? { id: `mock_evt_${orderId}_paid`, type: "payment.paid", orderId, paymentId: `mock_pay_${orderId}`, amountPaise: Number(o.totalPaise) }
      : { id: `mock_evt_${orderId}_failed`, type: "payment.failed", orderId, reason: "declined (mock)" },
  );
  await handlePaymentWebhook("mock", body, { "x-mock-signature": mockSign(body) });
  return getPaymentStatus(actor, orderId);
}

export interface OrderFilter { status?: string; purpose?: string; provider?: string; businessId?: string; limit?: number; offset?: number }
export async function listPaymentOrders(f: OrderFilter = {}): Promise<PaymentOrderView[]> {
  const rows = await prisma.paymentOrder.findMany({
    where: { ...(f.status ? { status: f.status as never } : {}), ...(f.purpose ? { purpose: f.purpose } : {}), ...(f.provider ? { provider: f.provider } : {}), ...(f.businessId ? { businessId: f.businessId } : {}) },
    orderBy: { createdAt: "desc" }, take: Math.min(f.limit ?? 50, 200), skip: f.offset ?? 0, include: { refunds: true, invoice: { select: { id: true } } },
  });
  return rows.map(view);
}

export async function listBusinessPayments(businessId: string, limit = 20): Promise<PaymentOrderView[]> {
  return listPaymentOrders({ businessId, limit });
}

export async function getPaymentOrderDetail(orderId: string) {
  const o = await prisma.paymentOrder.findUnique({ where: { id: orderId }, include: { refunds: { orderBy: { createdAt: "asc" } }, invoice: { select: { id: true } } } });
  if (!o) throw new DomainError("not_found", "Payment order not found");
  const events = await prisma.paymentWebhookEvent.findMany({ where: { payload: { path: ["_orderId"], equals: orderId } }, orderBy: { receivedAt: "asc" } });
  return {
    order: view(o), providerOrderId: o.providerOrderId, providerPaymentId: o.providerPaymentId,
    refunds: o.refunds.map((r) => ({ id: r.id, amountPaise: Number(r.amountPaise), reason: r.reason, status: r.status, creditNoteId: r.creditNoteId, createdAt: r.createdAt.toISOString() })),
    events: events.map((e) => ({ id: e.id, provider: e.provider, eventId: e.eventId, type: e.type, processedAt: e.processedAt?.toISOString() ?? null, error: e.error, receivedAt: e.receivedAt.toISOString() })),
  };
}

// ---- refunds -----------------------------------------------------------------------------------------------------

/**
 * Refund (full or partial) of a paid order: reserve under the order lock -> provider refund -> credit note -> event.
 * `staffId` is recorded in the reason for the audit trail (the admin app also wraps the call in audited()).
 */
export async function refundPayment(orderId: string, amountPaise: number, reason: string, staffId?: string): Promise<{ refundId: string; creditNoteNumber: string | null; status: string }> {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) throw new DomainError("validation", "Refund amount must be a positive number of paise");
  if (!reason.trim()) throw new DomainError("validation", "A refund reason is required");
  const fullReason = staffId ? `${reason.trim()} (by staff ${staffId})` : reason.trim();
  const { refund, order } = await prisma.$transaction(async (tx) => {
    const o = await lockOrder(tx, orderId);
    if (!o) throw new DomainError("not_found", "Payment order not found");
    if (!o.fulfilledAt || (o.status !== "paid" && o.status !== "partially_refunded")) throw new DomainError("conflict", "Only paid orders can be refunded");
    const prior = await tx.paymentRefund.findMany({ where: { paymentOrderId: o.id, status: { not: "failed" } } });
    const already = prior.reduce((a, r) => a + Number(r.amountPaise), 0);
    if (already + amountPaise > Number(o.totalPaise)) throw new DomainError("validation", "Refund exceeds the amount paid");
    const r = await tx.paymentRefund.create({ data: { paymentOrderId: o.id, amountPaise: bn(amountPaise), reason: fullReason } });
    return { refund: r, order: o };
  });
  let providerRefund: { providerRefundId: string; status: "processed" | "pending" };
  try {
    providerRefund = await getProvider(order.provider as ProviderName).refund({
      orderId: order.id, providerOrderId: order.providerOrderId, providerPaymentId: order.providerPaymentId, amountPaise, refundId: refund.id, reason: fullReason,
    });
  } catch (e) {
    await prisma.paymentRefund.update({ where: { id: refund.id }, data: { status: "failed" } });
    throw e;
  }
  return prisma.$transaction(async (tx) => {
    const o = (await lockOrder(tx, orderId))!;
    const original = await tx.invoice.findUnique({ where: { paymentOrderId: orderId } });
    let noteId: string | null = null;
    let noteNumber: string | null = null;
    if (original) {
      const first = (original.lines as unknown as InvoiceLineInput[])[0]!;
      const note = await issueInvoiceTx(tx, {
        kind: "credit_note", businessId: o.businessId, refInvoiceId: original.id, supplier: original.supplier as never, recipient: original.recipient as never,
        lines: [{ ...first, description: `Refund: ${first.description}` }], inclusiveTotalPaise: amountPaise,
      });
      noteId = note.id;
      noteNumber = note.number;
    }
    await tx.paymentRefund.update({ where: { id: refund.id }, data: { status: providerRefund.status, providerRefundId: providerRefund.providerRefundId, creditNoteId: noteId } });
    const total = (await tx.paymentRefund.findMany({ where: { paymentOrderId: o.id, status: { not: "failed" } } })).reduce((a, r) => a + Number(r.amountPaise), 0);
    await tx.paymentOrder.update({ where: { id: o.id }, data: { status: total >= Number(o.totalPaise) ? "refunded" : "partially_refunded" } });
    await emit(tx, "PaymentRefunded", { type: "payment_order", id: o.id }, { paymentOrderId: o.id, businessId: o.businessId, amountPaise, creditNoteNumber: noteNumber });
    return { refundId: refund.id, creditNoteNumber: noteNumber, status: providerRefund.status };
  });
}

/** Annual-plan cancel: refund the pro-rata share of what was actually paid (tax-inclusive, coupon-aware). */
export async function refundForCancellation(businessId: string, quote: CancellationQuote): Promise<void> {
  if (quote.refundPaise <= 0) return;
  const plan = await getPlan(quote.planCode);
  const order = await prisma.paymentOrder.findFirst({
    where: { businessId, purpose: "subscription", status: { in: ["paid", "partially_refunded"] }, purposeRef: { startsWith: quote.planCode } },
    orderBy: { fulfilledAt: "desc" },
  });
  if (!order || plan.monthlyPricePaise <= 0) return; // dev/manual subscriptions have nothing to refund
  const amount = Math.floor((Number(order.totalPaise) * quote.refundPaise) / plan.monthlyPricePaise);
  if (amount > 0) await refundPayment(order.id, amount, `Pro-rata refund on cancelling ${quote.planCode}`);
}

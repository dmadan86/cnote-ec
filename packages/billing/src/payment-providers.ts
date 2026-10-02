// Payment gateway port + adapters (Razorpay Payment Links, Cashfree PG Orders, mock). Plain fetch, no SDKs.
// Hosted checkout only: card/UPI data never reaches our servers (ADR-010). See docs/design/payments-and-invoicing.md.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "@cnote/core";

export type ProviderName = "razorpay" | "cashfree" | "mock";
export const PROVIDER_NAMES: readonly ProviderName[] = ["razorpay", "cashfree", "mock"];

export interface CustomerInfo { name?: string; email?: string; phone?: string }
export interface CreateOrderInput { orderId: string; amountPaise: number; description: string; customer: CustomerInfo; returnUrl: string; notifyUrl: string }
export interface CreatedOrder { providerOrderId: string; redirectUrl: string }

export interface ParsedWebhook {
  eventId: string;
  type: string;
  outcome: "paid" | "failed" | "ignored";
  /** our PaymentOrder id when the payload carries it (razorpay reference_id, cashfree order_id) */
  orderId?: string;
  providerOrderId?: string;
  providerPaymentId?: string;
  amountPaise?: number;
  failureReason?: string;
  /** refund lifecycle notice (not a payment): matched to our PaymentRefund by provider id or our refund id */
  refund?: { providerRefundId?: string; refundId?: string; status: "processed" | "failed" };
  /** payload with payer identifiers (card, vpa, email, phone, bank) stripped */
  redacted: Record<string, unknown>;
}
export interface ProviderPayment { status: "paid" | "failed" | "pending"; providerPaymentId?: string; amountPaise?: number }
export interface RefundInput { orderId: string; providerOrderId: string | null; providerPaymentId: string | null; amountPaise: number; refundId: string; reason: string }
export interface RefundResult { providerRefundId: string; status: "processed" | "pending" }

export interface PaymentProvider {
  name: ProviderName;
  createOrder(i: CreateOrderInput): Promise<CreatedOrder>;
  /** null = signature invalid. Throws DomainError("validation") for a valid signature over an unparseable body. */
  verifyWebhook(raw: Uint8Array | string, headers: Headers | Record<string, string | undefined>): ParsedWebhook | null;
  fetchPayment(o: { id: string; providerOrderId: string | null }): Promise<ProviderPayment>;
  refund(i: RefundInput): Promise<RefundResult>;
}

// ---- helpers -----------------------------------------------------------------------------------------------------

const enc = (raw: Uint8Array | string): Buffer => (typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw));
export function header(h: Headers | Record<string, string | undefined>, name: string): string | undefined {
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name) ?? undefined;
  const rec = h as Record<string, string | undefined>;
  const k = Object.keys(rec).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? rec[k] : undefined;
}
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
const REDACT = /^(card|card_id|vpa|upi|email|contact|phone|bank|bank_transaction_id|wallet|customer_details|customer|payment_method|payer_account_number|account_number|customer_phone|customer_email|acquirer_data|auth_details)$/i;
export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as object).filter(([k]) => !REDACT.test(k)).map(([k, x]) => [k, redact(x)]));
  return v;
}
const parseJson = (raw: Uint8Array | string): Record<string, unknown> => {
  try {
    const v = JSON.parse(enc(raw).toString("utf8"));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fallthrough */ }
  throw new DomainError("validation", "Malformed webhook body");
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const sha = (raw: Uint8Array | string) => createHash("sha256").update(enc(raw)).digest("hex");

async function call(url: string, init: RequestInit, what: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new DomainError("conflict", `${what}: payment provider unreachable`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    console.error(`[billing] ${what} failed ${res.status}`, JSON.stringify(body).slice(0, 300));
    throw new DomainError("conflict", `${what}: payment provider rejected the request`);
  }
  return body;
}

// ---- Razorpay (Payment Links + webhook X-Razorpay-Signature) -----------------------------------------------------

export function razorpay(env: NodeJS.ProcessEnv = process.env): PaymentProvider {
  const base = env.RAZORPAY_API_BASE || "https://api.razorpay.com/v1";
  const auth = () => {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) throw new DomainError("conflict", "Razorpay is not configured");
    return `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64")}`;
  };
  const headers = () => ({ Authorization: auth(), "Content-Type": "application/json" });
  return {
    name: "razorpay",
    async createOrder(i) {
      const customer = { ...(i.customer.name ? { name: i.customer.name } : {}), ...(i.customer.email ? { email: i.customer.email } : {}), ...(i.customer.phone ? { contact: i.customer.phone } : {}) };
      const r = await call(`${base}/payment_links`, {
        method: "POST", headers: headers(),
        body: JSON.stringify({
          amount: i.amountPaise, currency: "INR", reference_id: i.orderId, description: i.description.slice(0, 2000),
          customer, notify: { sms: false, email: false }, reminder_enable: false, callback_url: i.returnUrl, callback_method: "get",
          expire_by: Math.floor(Date.now() / 1000) + 86_400, notes: { order_id: i.orderId },
        }),
      }, "razorpay create payment link");
      const id = str(r.id);
      const url = str(r.short_url);
      if (!id || !url) throw new DomainError("conflict", "razorpay: unexpected response");
      return { providerOrderId: id, redirectUrl: url };
    },
    verifyWebhook(raw, h) {
      const secret = env.RAZORPAY_WEBHOOK_SECRET;
      const sig = header(h, "x-razorpay-signature");
      if (!secret || !sig) return null;
      if (!safeEqual(createHmac("sha256", secret).update(enc(raw)).digest("hex"), sig)) return null;
      const body = parseJson(raw);
      const type = str(body.event) ?? "unknown";
      const eventId = header(h, "x-razorpay-event-id") ?? sha(raw);
      const p = obj(body.payload);
      const link = obj(obj(p.payment_link).entity);
      const pay = obj(obj(p.payment).entity);
      const redacted = redact(body) as Record<string, unknown>;
      const orderId = str(link.reference_id) ?? str(obj(link.notes).order_id);
      if (type === "payment_link.paid") {
        return { eventId, type, outcome: "paid", orderId, providerOrderId: str(link.id), providerPaymentId: str(pay.id), amountPaise: num(pay.amount) ?? num(link.amount_paid), redacted };
      }
      // A single failed attempt does not end a payment link (the payer can retry); only expiry/cancel does.
      if (type === "payment_link.expired" || type === "payment_link.cancelled") {
        return { eventId, type, outcome: "failed", orderId, providerOrderId: str(link.id), failureReason: type.replace("payment_link.", "link_"), redacted };
      }
      if (type === "refund.processed" || type === "refund.failed") {
        const rf = obj(obj(p.refund).entity);
        return { eventId, type, outcome: "ignored", redacted, refund: { providerRefundId: str(rf.id), refundId: str(rf.receipt), status: type === "refund.processed" ? "processed" : "failed" } };
      }
      return { eventId, type, outcome: "ignored", orderId, redacted };
    },
    async fetchPayment(o) {
      if (!o.providerOrderId) return { status: "pending" };
      const r = await call(`${base}/payment_links/${encodeURIComponent(o.providerOrderId)}`, { headers: headers() }, "razorpay fetch payment link");
      if (r.status === "paid") {
        const first = obj(Array.isArray(r.payments) ? r.payments[0] : undefined);
        return { status: "paid", providerPaymentId: str(first.payment_id), amountPaise: num(r.amount_paid) };
      }
      return { status: r.status === "expired" || r.status === "cancelled" ? "failed" : "pending" };
    },
    async refund(i) {
      if (!i.providerPaymentId) throw new DomainError("conflict", "razorpay: payment id unknown");
      const r = await call(`${base}/payments/${encodeURIComponent(i.providerPaymentId)}/refund`, {
        // X-Refund-Idempotency: a retry of the same refund row can never refund twice.
        method: "POST", headers: { ...headers(), "X-Refund-Idempotency": i.refundId }, body: JSON.stringify({ amount: i.amountPaise, receipt: i.refundId, notes: { reason: i.reason.slice(0, 200) } }),
      }, "razorpay refund");
      return { providerRefundId: str(r.id) ?? i.refundId, status: r.status === "processed" ? "processed" : "pending" };
    },
  };
}

// ---- Cashfree (PG Orders + webhook x-webhook-signature = base64 HMAC(timestamp + raw)) ---------------------------------

export function cashfree(env: NodeJS.ProcessEnv = process.env): PaymentProvider {
  const prod = (env.CASHFREE_ENV ?? (env.NODE_ENV === "production" ? "production" : "sandbox")) === "production";
  const base = env.CASHFREE_API_BASE || (prod ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg");
  const hosted = env.CASHFREE_CHECKOUT_BASE || (prod ? "https://payments.cashfree.com/order/#" : "https://sandbox.cashfree.com/pg/view/order/#");
  const headers = () => {
    if (!env.CASHFREE_APP_ID || !env.CASHFREE_SECRET_KEY) throw new DomainError("conflict", "Cashfree is not configured");
    return { "x-client-id": env.CASHFREE_APP_ID, "x-client-secret": env.CASHFREE_SECRET_KEY, "x-api-version": env.CASHFREE_API_VERSION || "2023-08-01", "Content-Type": "application/json" };
  };
  const rupees = (p: number) => Number((p / 100).toFixed(2));
  return {
    name: "cashfree",
    async createOrder(i) {
      const phone = (i.customer.phone ?? "").replace(/\D/g, "").slice(-10);
      if (phone.length !== 10) throw new DomainError("validation", "Add a phone number to your account to pay.");
      const r = await call(`${base}/orders`, {
        method: "POST", headers: headers(),
        body: JSON.stringify({
          order_id: i.orderId, order_amount: rupees(i.amountPaise), order_currency: "INR", order_note: i.description.slice(0, 200),
          customer_details: { customer_id: i.orderId.replace(/-/g, "").slice(0, 32), customer_phone: phone, ...(i.customer.email ? { customer_email: i.customer.email } : {}), ...(i.customer.name ? { customer_name: i.customer.name } : {}) },
          order_meta: { return_url: i.returnUrl, notify_url: i.notifyUrl },
        }),
      }, "cashfree create order");
      const session = str(r.payment_session_id);
      if (!session) throw new DomainError("conflict", "cashfree: unexpected response");
      return { providerOrderId: str(r.cf_order_id) ?? i.orderId, redirectUrl: `${hosted}${session}` };
    },
    verifyWebhook(raw, h) {
      const secret = env.CASHFREE_WEBHOOK_SECRET || env.CASHFREE_SECRET_KEY; // Cashfree signs with the PG secret key
      const sig = header(h, "x-webhook-signature");
      const ts = header(h, "x-webhook-timestamp");
      if (!secret || !sig || !ts) return null;
      const expected = createHmac("sha256", secret).update(Buffer.concat([Buffer.from(ts), enc(raw)])).digest("base64");
      if (!safeEqual(expected, sig)) return null;
      const body = parseJson(raw);
      const type = str(body.type) ?? "unknown";
      const data = obj(body.data);
      const order = obj(data.order);
      const pay = obj(data.payment);
      const paymentId = str(pay.cf_payment_id);
      const eventId = `${type}:${paymentId ?? str(order.order_id) ?? sha(raw)}:${str(body.event_time) ?? ""}`;
      const redacted = redact(body) as Record<string, unknown>;
      const amt = num(pay.payment_amount);
      const base_ = { eventId, type, orderId: str(order.order_id), providerPaymentId: paymentId, redacted };
      if (type === "PAYMENT_SUCCESS_WEBHOOK") return { ...base_, outcome: "paid", amountPaise: amt === undefined ? undefined : Math.round(amt * 100) };
      if (type === "PAYMENT_FAILED_WEBHOOK") return { ...base_, outcome: "failed", failureReason: str(pay.payment_message) ?? "payment_failed" };
      if (type === "REFUND_STATUS_WEBHOOK") {
        const rf = obj(data.refund);
        const st = str(rf.refund_status);
        const done = st === "SUCCESS" ? "processed" : st === "FAILED" || st === "CANCELLED" ? "failed" : null;
        const rid = str(rf.refund_id);
        if (done) return { ...base_, outcome: "ignored", eventId: `${type}:${str(rf.cf_refund_id) ?? rid ?? sha(raw)}:${st}`, refund: { providerRefundId: str(rf.cf_refund_id), refundId: rid, status: done } };
      }
      return { ...base_, outcome: "ignored" };
    },
    async fetchPayment(o) {
      const r = await fetch(`${base}/orders/${encodeURIComponent(o.id)}/payments`, { headers: headers(), signal: AbortSignal.timeout(15_000) }).catch(() => null);
      const list = r && r.ok ? ((await r.json().catch(() => [])) as unknown) : [];
      const rows = Array.isArray(list) ? list.map(obj) : [];
      const ok = rows.find((p) => p.payment_status === "SUCCESS");
      if (ok) return { status: "paid", providerPaymentId: str(ok.cf_payment_id), amountPaise: Math.round((num(ok.payment_amount) ?? 0) * 100) };
      return { status: rows.length && rows.every((p) => p.payment_status === "FAILED") ? "failed" : "pending" };
    },
    async refund(i) {
      // Cashfree refunds are addressed by OUR order_id (we used the PaymentOrder id as order_id).
      const r = await call(`${base}/orders/${encodeURIComponent(i.orderId)}/refunds`, {
        method: "POST", headers: { ...headers(), "x-idempotency-key": i.refundId }, body: JSON.stringify({ refund_amount: rupees(i.amountPaise), refund_id: i.refundId.replace(/-/g, ""), refund_note: i.reason.slice(0, 100) }),
      }, "cashfree refund");
      return { providerRefundId: str(r.cf_refund_id) ?? i.refundId, status: r.refund_status === "SUCCESS" ? "processed" : "pending" };
    },
  };
}

// ---- Mock (dev / tests only; never in production) -----------------------------------------------------------------

export const MOCK_SECRET = (env: NodeJS.ProcessEnv = process.env): string => env.PAYMENTS_MOCK_SECRET || "cnote-mock-secret";
export function mockSign(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  return createHmac("sha256", MOCK_SECRET(env)).update(raw).digest("hex");
}
export function mock(env: NodeJS.ProcessEnv = process.env): PaymentProvider {
  const seller = env.SELLER_APP_URL || "http://localhost:3002";
  return {
    name: "mock",
    async createOrder(i) {
      return { providerOrderId: `mock_${i.orderId}`, redirectUrl: `${seller}/billing/mock-pay?order=${i.orderId}` };
    },
    verifyWebhook(raw, h) {
      const sig = header(h, "x-mock-signature");
      if (!sig || !safeEqual(mockSign(enc(raw).toString("utf8"), env), sig)) return null;
      const b = parseJson(raw);
      const type = str(b.type) ?? "unknown";
      const eventId = str(b.id) ?? sha(raw);
      const common = { eventId, type, orderId: str(b.orderId), providerPaymentId: str(b.paymentId), redacted: b };
      if (type === "payment.paid") return { ...common, outcome: "paid", amountPaise: num(b.amountPaise) };
      if (type === "payment.failed") return { ...common, outcome: "failed", failureReason: str(b.reason) ?? "mock_failed" };
      if (type === "refund.processed" || type === "refund.failed") return { ...common, outcome: "ignored", refund: { providerRefundId: str(b.providerRefundId), refundId: str(b.refundId), status: type === "refund.processed" ? "processed" : "failed" } };
      return { ...common, outcome: "ignored" };
    },
    async fetchPayment() {
      return { status: "pending" };
    },
    async refund(i) {
      return { providerRefundId: `mock_rf_${i.refundId}`, status: "processed" };
    },
  };
}

export function isProviderName(v: string): v is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(v);
}
export function configuredProvider(env: NodeJS.ProcessEnv = process.env): ProviderName {
  const v = env.PAYMENTS_PROVIDER || "mock";
  if (!isProviderName(v)) throw new DomainError("conflict", `Unknown PAYMENTS_PROVIDER "${v}"`);
  return v;
}
let warnedMock = false;
/**
 * The mock gateway is for dev, tests and the e2e servers only. It FAILS CLOSED: allowed only when NODE_ENV is explicitly
 * "development" or "test" (an unset or unexpected NODE_ENV is treated like production). Otherwise it needs
 * PAYMENTS_ALLOW_MOCK_IN_PRODUCTION=1 (e2e only, default off) AND no real provider configured, so a live deployment
 * with Razorpay/Cashfree can never be switched to fake payments by that flag. Turning it on logs a loud warning.
 */
export function mockAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "development" || env.NODE_ENV === "test") return true;
  if (env.PAYMENTS_ALLOW_MOCK_IN_PRODUCTION !== "1") return false;
  const configured = env.PAYMENTS_PROVIDER || "mock";
  if (configured !== "mock") {
    console.error(`[billing] SECURITY: PAYMENTS_ALLOW_MOCK_IN_PRODUCTION=1 is IGNORED because PAYMENTS_PROVIDER=${configured} is configured in production`);
    return false;
  }
  if (!warnedMock) {
    warnedMock = true;
    console.warn("[billing] WARNING: PAYMENTS_ALLOW_MOCK_IN_PRODUCTION=1, the MOCK payment gateway is active in a production build. This is for e2e only; never set it on a real deployment.");
  }
  return true;
}
export function getProvider(name: ProviderName = configuredProvider(), env: NodeJS.ProcessEnv = process.env): PaymentProvider {
  if (name === "mock") {
    if (!mockAllowed(env)) throw new DomainError("conflict", "The mock payment provider is disabled in production");
    return mock(env);
  }
  return name === "razorpay" ? razorpay(env) : cashfree(env);
}

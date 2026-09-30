// Razorpay Route / Cashfree escrow-style adapters. Money-moving calls are stubs until the partner contract and
// sandbox credentials exist (ADR-012 open item): they throw "not configured" without credentials and
// "not implemented" with them. Webhook verification is real so the ingress path can be exercised end to end.
import { DomainError } from "@cnote/core";
import { header, hmac, num, obj, parseJson, redact, safeEqual, str } from "./util";
import type { CollectRequest, CollectResponse, EscrowPartner, ParsedEscrowWebhook, PartnerName, StatementEntry, TransferRequest, TransferResult } from "./types";

abstract class StubPartner implements EscrowPartner {
  abstract readonly name: PartnerName;
  readonly authoritativeStatement = true;
  protected abstract credsPresent(): boolean;
  protected abstract label: string;
  protected abstract verify(raw: Buffer, headers: Headers | Record<string, string | undefined>): boolean;
  protected abstract parse(body: Record<string, unknown>): Omit<ParsedEscrowWebhook, "redacted">;

  protected guard(): never {
    if (!this.credsPresent()) throw new DomainError("conflict", `${this.label} escrow partner is not configured (missing credentials).`);
    throw new DomainError("conflict", `${this.label} escrow partner is not implemented yet: awaiting partner contract (ADR-012).`);
  }
  async createCollect(_r: CollectRequest): Promise<CollectResponse> { return this.guard(); }
  async releasePayout(_r: TransferRequest): Promise<TransferResult> { return this.guard(); }
  async refund(_r: TransferRequest): Promise<TransferResult> { return this.guard(); }
  async fetchStatement(_r: { from: Date; to: Date }): Promise<StatementEntry[]> { return this.guard(); }

  verifyWebhook(raw: Uint8Array | string, headers: Headers | Record<string, string | undefined>): ParsedEscrowWebhook | null {
    if (!process.env.ESCROW_WEBHOOK_SECRET) throw new DomainError("conflict", `${this.label} escrow partner is not configured (missing webhook secret).`);
    const buf = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
    if (!this.verify(buf, headers)) return null;
    const body = parseJson(buf);
    return { ...this.parse(body), redacted: obj(redact(body)) };
  }
}

export class RazorpayRoutePartner extends StubPartner {
  readonly name = "razorpay_route" as const;
  protected label = "Razorpay Route";
  protected credsPresent = (): boolean => !!process.env.RAZORPAY_KEY_ID && !!process.env.RAZORPAY_KEY_SECRET;
  protected verify(raw: Buffer, h: Headers | Record<string, string | undefined>): boolean {
    const sig = header(h, "x-razorpay-signature");
    return !!sig && safeEqual(sig, hmac(process.env.ESCROW_WEBHOOK_SECRET!, raw, "hex"));
  }
  protected parse(b: Record<string, unknown>): Omit<ParsedEscrowWebhook, "redacted"> {
    const event = str(b.event);
    const payload = obj(b.payload);
    const pay = obj(obj(payload.payment).entity);
    const po = obj(obj(payload.payout).entity);
    const notes = obj(pay.notes);
    const eventId = str(b.id) ?? `rzp_${event}_${str(pay.id) ?? str(po.id) ?? "x"}`;
    if (event === "payment.captured") return { eventId, type: "collect.captured", escrowId: str(notes.escrow_id), partnerRef: str(pay.id), amountPaise: num(pay.amount) };
    if (event === "payout.processed") return { eventId, type: "payout.settled", payoutId: str(po.reference_id), partnerRef: str(po.id), amountPaise: num(po.amount) };
    if (event === "payout.failed" || event === "payout.reversed") return { eventId, type: "payout.failed", payoutId: str(po.reference_id), partnerRef: str(po.id), amountPaise: num(po.amount) };
    return { eventId, type: "ignored" };
  }
}

export class CashfreePartner extends StubPartner {
  readonly name = "cashfree" as const;
  protected label = "Cashfree";
  protected credsPresent = (): boolean => !!process.env.CASHFREE_CLIENT_ID && !!process.env.CASHFREE_CLIENT_SECRET;
  protected verify(raw: Buffer, h: Headers | Record<string, string | undefined>): boolean {
    const sig = header(h, "x-webhook-signature");
    const ts = header(h, "x-webhook-timestamp");
    return !!sig && !!ts && safeEqual(sig, hmac(process.env.ESCROW_WEBHOOK_SECRET!, `${ts}${raw.toString("utf8")}`, "base64"));
  }
  protected parse(b: Record<string, unknown>): Omit<ParsedEscrowWebhook, "redacted"> {
    const type = str(b.type);
    const data = obj(b.data);
    const order = obj(data.order);
    const pay = obj(data.payment);
    const transfer = obj(data.transfer);
    const eventId = str(b.event_id) ?? `cf_${type}_${str(pay.cf_payment_id) ?? str(transfer.transfer_id) ?? "x"}`;
    if (type === "PAYMENT_SUCCESS_WEBHOOK") {
      const amt = num(pay.payment_amount);
      return { eventId, type: "collect.captured", escrowId: str(order.order_id), partnerRef: str(pay.cf_payment_id), amountPaise: amt === undefined ? undefined : Math.round(amt * 100) };
    }
    if (type === "TRANSFER_SUCCESS") return { eventId, type: "payout.settled", payoutId: str(transfer.transfer_id), partnerRef: str(transfer.cf_transfer_id) };
    if (type === "TRANSFER_FAILED" || type === "TRANSFER_REVERSED") return { eventId, type: "payout.failed", payoutId: str(transfer.transfer_id), partnerRef: str(transfer.cf_transfer_id) };
    return { eventId, type: "ignored" };
  }
}

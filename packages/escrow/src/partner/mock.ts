// Deterministic in-process partner (default). Lets dev and tests fund, release and refund without credentials:
// `simulateCollect` produces a SIGNED webhook that is fed through the same handleEscrowWebhook path as a real partner.
import { DomainError } from "@cnote/core";
import { header, hmac, obj, num, parseJson, redact, safeEqual, str } from "./util";
import type { CollectRequest, CollectResponse, EscrowPartner, ParsedEscrowWebhook, StatementEntry, TransferRequest, TransferResult } from "./types";

export const MOCK_SIGNATURE_HEADER = "x-escrow-signature";
export const mockSecret = (): string => process.env.ESCROW_WEBHOOK_SECRET || "mock-escrow-webhook-secret";
export const mockSign = (body: string): string => hmac(mockSecret(), body, "hex");

interface MockOptions { payoutStatus?: "settled" | "pending" }

export class MockPartner implements EscrowPartner {
  readonly name = "mock" as const;
  readonly authoritativeStatement = false;
  private readonly transfers = new Map<string, TransferResult>();
  private readonly statement: StatementEntry[] = [];
  private readonly collects = new Map<string, CollectResponse>();

  constructor(private readonly opts: MockOptions = {}) {}

  async createCollect(req: CollectRequest): Promise<CollectResponse> {
    const hit = this.collects.get(req.escrowId);
    if (hit) return hit;
    const short = req.escrowId.replace(/-/g, "").slice(0, 12);
    const res: CollectResponse = { partnerRef: `mock_va_${short}`, checkoutUrl: `mock://escrow/${req.escrowId}`, virtualAccount: { accountNumber: `MOCK${short.toUpperCase()}`, ifsc: "MOCK0000001" } };
    this.collects.set(req.escrowId, res);
    return res;
  }

  private transfer(req: TransferRequest, kind: "payout" | "refund"): TransferResult {
    const hit = this.transfers.get(req.transferId);
    if (hit) return hit;
    if (!Number.isSafeInteger(req.amountPaise) || req.amountPaise <= 0) throw new DomainError("validation", "Transfer amount must be positive.", undefined, "escrow.transferAmountMustPositive");
    const res: TransferResult = { partnerRef: `mock_${kind === "payout" ? "po" : "rf"}_${req.transferId.replace(/-/g, "").slice(0, 12)}`, status: this.opts.payoutStatus ?? "settled" };
    this.transfers.set(req.transferId, res);
    this.statement.push({ partnerRef: res.partnerRef, escrowRef: req.escrowId, kind, amountPaise: req.amountPaise, at: new Date().toISOString() });
    return res;
  }
  async releasePayout(req: TransferRequest): Promise<TransferResult> { return this.transfer(req, "payout"); }
  async refund(req: TransferRequest): Promise<TransferResult> { return this.transfer(req, "refund"); }

  /** Test/dev helper: the signed webhook body+headers a partner would send when the buyer pays. */
  simulateCollect(escrowId: string, amountPaise: number, at: Date = new Date()): { rawBody: string; headers: Record<string, string> } {
    const partnerRef = this.collects.get(escrowId)?.partnerRef ?? `mock_va_${escrowId.replace(/-/g, "").slice(0, 12)}`;
    this.statement.push({ partnerRef, escrowRef: escrowId, kind: "collect", amountPaise, at: at.toISOString() });
    return this.event({ id: `mock_evt_collect_${escrowId}`, type: "collect.captured", escrowId, partnerRef, amountPaise });
  }
  /** Signed webhook for an arbitrary mock event (e.g. payout.settled for a pending transfer). */
  event(body: Record<string, unknown>): { rawBody: string; headers: Record<string, string> } {
    const rawBody = JSON.stringify(body);
    return { rawBody, headers: { [MOCK_SIGNATURE_HEADER]: mockSign(rawBody) } };
  }

  verifyWebhook(raw: Uint8Array | string, headers: Headers | Record<string, string | undefined>): ParsedEscrowWebhook | null {
    const sig = header(headers, MOCK_SIGNATURE_HEADER);
    const body = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
    if (!sig || !safeEqual(sig, mockSign(body))) return null;
    const j = parseJson(body);
    const type = str(j.type);
    const known = type === "collect.captured" || type === "payout.settled" || type === "payout.failed";
    return {
      eventId: str(j.id) ?? `mock_${mockSign(body).slice(0, 16)}`,
      type: known ? type : "ignored",
      escrowId: str(j.escrowId), payoutId: str(j.payoutId), partnerRef: str(j.partnerRef), amountPaise: num(j.amountPaise),
      redacted: obj(redact(j)),
    };
  }

  async fetchStatement(range: { from: Date; to: Date }): Promise<StatementEntry[]> {
    return this.statement.filter((e) => e.at >= range.from.toISOString() && e.at <= range.to.toISOString());
  }

  /** Test helper: forget everything. */
  reset(): void { this.transfers.clear(); this.statement.length = 0; this.collects.clear(); }
  /** Test helper: inject a statement line (e.g. a mismatching one). */
  pushStatement(e: StatementEntry): void { this.statement.push(e); }
}

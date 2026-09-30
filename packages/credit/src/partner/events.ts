import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PartnerEvent, PartnerOffer } from "./types";

export const SIGNATURE_HEADER = "x-credit-signature";
export const hmacHex = (secret: string, body: Uint8Array | string): string => createHmac("sha256", secret).update(body).digest("hex");
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const offerSchema = z.object({
  offerRef: z.string().min(1).max(200), amountPaise: z.number().int().positive(), aprBps: z.number().int().min(0).max(10_000), tenorDays: z.number().int().positive().max(730),
  processingFeePaise: z.number().int().min(0), otherFeesPaise: z.number().int().min(0), expiresAt: z.string().optional(),
});
const eventSchema = z.object({
  eventId: z.string().min(1).max(200),
  type: z.enum(["application.offered", "application.rejected", "loan.disbursed", "loan.repayment", "loan.overdue", "loan.closed", "loan.written_off", "loan.cancelled"]),
  partnerRef: z.string().min(1).max(300),
  loanRef: z.string().max(300).optional(),
  offers: z.array(offerSchema).max(10).optional(),
  amountPaise: z.number().int().min(0).optional(),
  dpd: z.number().int().min(0).max(5000).optional(),
  reason: z.string().max(500).optional(),
  source: z.enum(["borrower", "escrow_release", "partner"]).optional(),
  at: z.string(),
});

const toOffer = (o: z.infer<typeof offerSchema>): PartnerOffer => ({ ...o, expiresAt: o.expiresAt ? new Date(o.expiresAt) : undefined });

/** Parse and validate a partner webhook body into the normalised event, or null. */
export function parsePartnerEvent(raw: Uint8Array): PartnerEvent | null {
  let json: unknown;
  try { json = JSON.parse(Buffer.from(raw).toString("utf8")); } catch { return null; }
  const r = eventSchema.safeParse(json);
  if (!r.success) return null;
  const at = new Date(r.data.at);
  if (Number.isNaN(at.getTime())) return null;
  return { ...r.data, offers: r.data.offers?.map(toOffer), at };
}

/** Shared HMAC-SHA256 (hex) verification over the RAW body, then normalisation. */
export function verifySigned(secret: string | undefined, raw: Uint8Array, headers: Headers): PartnerEvent | null {
  if (!secret) return null;
  const sig = headers.get(SIGNATURE_HEADER);
  if (!sig || !safeEqual(sig, hmacHex(secret, raw))) return null;
  return parsePartnerEvent(raw);
}

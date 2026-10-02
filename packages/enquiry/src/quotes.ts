// Quotes: structured terms, public reads (ADR-007, ADR-014 follow-up). Quote rows are owned by this module.
import { DomainError } from "@cnote/core";
import { prisma, type Quote } from "@cnote/db";
import { z } from "zod";
import type { AttachmentView } from "./attachments";
import { categoryById } from "./support";
import type { Actor } from "./types";

export const DELIVERY_TERMS = ["ex_works", "fob", "door_delivery", "buyer_pickup", "other"] as const;
export const PAYMENT_TERMS = ["advance", "on_delivery", "net_7", "net_15", "net_30", "escrow", "other"] as const;
export type DeliveryTerms = (typeof DELIVERY_TERMS)[number];
export type PaymentTerms = (typeof PAYMENT_TERMS)[number];

const note = z.string().trim().max(300).nullish().transform((v) => v || null);

/** Structured, all-optional quote terms. Old callers that send none keep working. */
export const quoteTermsSchema = z.object({
  moq: z.number().int().positive().max(2_000_000_000).nullish().transform((v) => v ?? null),
  moqUnit: z.string().trim().max(20).nullish().transform((v) => v || null),
  deliveryTerms: z.enum(DELIVERY_TERMS).nullish().transform((v) => v ?? null),
  deliveryNote: note,
  deliveryChargePaise: z.number().int().min(0).max(10_000_000_000_00).nullish().transform((v) => v ?? null),
  paymentTerms: z.enum(PAYMENT_TERMS).nullish().transform((v) => v ?? null),
  paymentNote: note,
  gstIncluded: z.boolean().nullish().transform((v) => v ?? null),
});
export type QuoteTermsInput = z.input<typeof quoteTermsSchema>;

export const quoteSchema = z.object({
  pricePaise: z.number().int().positive().max(10_000_000_000_00),
  quantity: z.number().int().positive().max(2_000_000_000),
  unit: z.string().trim().min(1).max(20),
  leadTimeDays: z.number().int().min(0).max(730).nullish().transform((v) => v ?? null),
  notes: z.string().trim().max(2000).nullish().transform((v) => v || null),
  validUntil: z
    .string()
    .nullish()
    .refine((v) => !v || !Number.isNaN(Date.parse(v)), "Enter a valid date")
    .transform((v) => v ?? null),
}).extend(quoteTermsSchema.shape);

export interface QuoteView {
  id: string;
  pricePaise: number;
  quantity: number;
  unit: string;
  leadTimeDays: number | null;
  notes: string | null;
  validUntil: string | null;
  createdAt: string;
  moq: number | null;
  moqUnit: string | null;
  deliveryTerms: DeliveryTerms | null;
  deliveryNote: string | null;
  deliveryChargePaise: number | null;
  paymentTerms: PaymentTerms | null;
  paymentNote: string | null;
  gstIncluded: boolean | null;
  /** Seller-attached files (comparison view only). */
  attachments?: AttachmentView[];
  /** Buyer's shortlist flag (comparison view only; never shown to the seller). */
  shortlisted?: boolean;
}

const asDelivery = (v: string | null) => ((DELIVERY_TERMS as readonly string[]).includes(v ?? "") ? (v as DeliveryTerms) : v ? "other" : null);
const asPayment = (v: string | null) => ((PAYMENT_TERMS as readonly string[]).includes(v ?? "") ? (v as PaymentTerms) : v ? "other" : null);

export function toQuoteView(q: Quote): QuoteView {
  return {
    id: q.id,
    pricePaise: Number(q.pricePaise),
    quantity: q.quantity,
    unit: q.unit,
    leadTimeDays: q.leadTimeDays,
    notes: q.notes,
    validUntil: q.validUntil ? q.validUntil.toISOString().slice(0, 10) : null,
    createdAt: q.createdAt.toISOString(),
    moq: q.moq,
    moqUnit: q.moqUnit,
    deliveryTerms: asDelivery(q.deliveryTerms),
    deliveryNote: q.deliveryNote,
    deliveryChargePaise: q.deliveryChargePaise == null ? null : Number(q.deliveryChargePaise),
    paymentTerms: asPayment(q.paymentTerms),
    paymentNote: q.paymentNote,
    gstIncluded: q.gstIncluded,
  };
}

export interface QuoteDetail extends QuoteView {
  conversationId: string;
  matchId: string;
  enquiryId: string;
  enquiryTitle: string;
  sellerBusinessId: string;
  buyerBusinessId: string;
  role: "buyer" | "seller";
}

/** One quote, visible to the two businesses on its conversation only (anyone else: null, indistinguishable from not found). */
export async function getQuote(actor: Actor, quoteId: string): Promise<QuoteDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(quoteId)) return null;
  const q = await prisma.quote.findUnique({ where: { id: quoteId }, include: { conversation: { include: { match: { include: { enquiry: true } } } } } });
  if (!q) return null;
  const { match } = q.conversation;
  const buyerBusinessId = match.enquiry.buyerBusinessId;
  const role = actor.businessId === buyerBusinessId ? "buyer" : actor.businessId === match.sellerBusinessId ? "seller" : null;
  if (!role) return null;
  return {
    ...toQuoteView(q),
    conversationId: q.conversationId,
    matchId: match.id,
    enquiryId: match.enquiryId,
    enquiryTitle: match.enquiry.title,
    sellerBusinessId: match.sellerBusinessId,
    buyerBusinessId,
    role,
  };
}

export interface SellerQuoteRow extends QuoteView {
  conversationId: string;
  matchId: string;
  enquiryId: string;
  enquiryTitle: string;
  category: { slug: string; name: string } | null;
}

/** The acting seller's own sent quotes, newest first, keyset-paged (`cursor` is the previous page's `nextCursor`). */
export async function listSellerQuotes(
  actor: Actor,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<{ items: SellerQuoteRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), 100);
  let where: { sellerBusinessId: string; OR?: object[] } = { sellerBusinessId: actor.businessId };
  if (opts.cursor) {
    const [at, id] = opts.cursor.split("|");
    const d = new Date(at ?? "");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(d.getTime())) throw new DomainError("validation", "Invalid cursor");
    where = { ...where, OR: [{ createdAt: { lt: d } }, { createdAt: d, id: { lt: id } }] };
  }
  const rows = await prisma.quote.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: { conversation: { select: { matchId: true, match: { select: { enquiryId: true, enquiry: { select: { title: true, categoryId: true } } } } } } },
  });
  const page = rows.slice(0, limit);
  const items: SellerQuoteRow[] = [];
  for (const r of page) {
    const enq = r.conversation.match.enquiry;
    const cat = await categoryById(enq.categoryId);
    items.push({
      ...toQuoteView(r),
      conversationId: r.conversationId,
      matchId: r.conversation.matchId,
      enquiryId: r.conversation.match.enquiryId,
      enquiryTitle: enq.title,
      category: cat ? { slug: cat.slug, name: cat.name } : null,
    });
  }
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null };
}

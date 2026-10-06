// Buyer side of the request: create (from a product page or a matched conversation) and cancel. Abuse guards live here.
import { DomainError, emit, rateLimit } from "@cnote/core";
import { getPublicListing } from "@cnote/catalogue";
import { prisma } from "@cnote/db";
import { getConversation } from "@cnote/enquiry";
import { getTrustProfiles } from "@cnote/identity";
import { z } from "zod";
import { HOUR_MS, sampleConfig } from "./config";
import { UUID, isUniqueViolation, loadForParty, lockSample, logStatus, requireEnabled, status, viewOf } from "./internal";
import { OPEN_STATUSES, activeKeyFor, assertTransition } from "./state";
import type { Actor, RequestSampleInput, SampleView } from "./types";

const LANGS = ["en", "hi", "kn", "ta", "te", "mr", "gu", "bn"] as const;

const text = (max: number) => z.string().trim().max(max);
const requestSchema = z.object({
  listingId: z.string().regex(UUID, "Choose a product").optional(),
  conversationId: z.string().regex(UUID, "Choose a conversation").optional(),
  quoteId: z.string().regex(UUID).nullish(),
  quantity: z.number().int("Quantity must be a whole number").min(1, "Ask for at least 1 unit").max(1_000_000),
  note: text(1000).nullish(),
  language: z.enum(LANGS).optional().default("en"),
  shipTo: z.object({
    name: text(100).min(2, "Enter the name of the person who will receive the sample"),
    phone: z.string().trim().regex(/^(\+91[\s-]?)?[6-9]\d{9}$/, "Enter a valid 10-digit mobile number").or(z.literal("")).nullish(),
    line1: text(160).min(3, "Enter the street address"),
    line2: text(160).nullish(),
    city: text(80).min(2, "Enter the city"),
    pincode: z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit pincode"),
  }),
});

const zodMessage = (err: z.ZodError) => err.issues[0]?.message ?? "Invalid input";

interface Context {
  sellerBusinessId: string;
  listingId: string | null;
  matchId: string | null;
  enquiryId: string | null;
  quoteId: string | null;
  subject: string;
  unit: string | null;
  amountPaise: number;
  maxQty: number;
  minTier: number;
}

async function fromListing(actor: Actor, listingId: string, defaultMaxQty: number): Promise<Context> {
  const l = await getPublicListing(listingId);
  if (!l) throw new DomainError("not_found", "Product not found");
  if (l.sellerBusinessId === actor.businessId) throw new DomainError("validation", "You cannot request a sample of your own product.", undefined, "samples.ownProduct");
  const t = l.trade ?? {};
  if (!t.sampleAvailable) throw new DomainError("conflict", "This supplier does not offer samples for this product.", undefined, "samples.notOffered");
  return {
    sellerBusinessId: l.sellerBusinessId, listingId: l.id, matchId: null, enquiryId: null, quoteId: null, subject: l.title, unit: l.priceUnit ?? l.moqUnit,
    amountPaise: t.samplePricePaise ?? 0, maxQty: t.sampleMaxQty ?? defaultMaxQty, minTier: t.sampleMinBuyerTier ?? 0,
  };
}

async function fromConversation(actor: Actor, conversationId: string, quoteId: string | null | undefined, defaultMaxQty: number): Promise<Context> {
  const c = await getConversation(actor, conversationId);
  if (!c || c.role !== "buyer") throw new DomainError("not_found", "Conversation not found");
  const quote = quoteId ? c.quotes.find((q) => q.id === quoteId) : undefined;
  if (quoteId && !quote) throw new DomainError("not_found", "Quote not found");
  return {
    sellerBusinessId: c.seller.businessId, listingId: null, matchId: c.matchId, enquiryId: c.enquiryId ?? null, quoteId: quote?.id ?? null,
    subject: c.enquiryTitle, unit: quote?.unit ?? null, amountPaise: 0, maxQty: defaultMaxQty, minTier: 0,
  };
}

/**
 * Creates a sample request. Guards, in order: flag, input, per-person daily rate limit, seller offers samples, quantity cap,
 * seller's minimum buyer tier (ADR-003), open-request cap per buyer business, one open request per product/conversation.
 */
export async function requestSample(actor: Actor, raw: RequestSampleInput): Promise<SampleView> {
  requireEnabled();
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new DomainError("validation", zodMessage(parsed.error));
  const input = parsed.data;
  if (!!input.listingId === !!input.conversationId) throw new DomainError("validation", "Request a sample from a product page or from a conversation.");
  const cfg = sampleConfig();

  if (!(await rateLimit(`samples:req:${actor.personId}`, cfg.requestsPerDay, 24 * 3600))) {
    throw new DomainError("rate_limited", "You are requesting samples too fast. Try again tomorrow.", undefined, "samples.rateLimited");
  }

  const ctx = input.listingId ? await fromListing(actor, input.listingId, cfg.defaultMaxQty) : await fromConversation(actor, input.conversationId!, input.quoteId, cfg.defaultMaxQty);
  if (input.quantity > ctx.maxQty) {
    throw new DomainError("validation", `This supplier allows up to ${ctx.maxQty} units per sample request.`, undefined, "samples.quantityTooHigh", { max: ctx.maxQty });
  }
  const buyerTier = (await getTrustProfiles([actor.businessId])).get(actor.businessId)?.verificationTier ?? 0;
  if (buyerTier < ctx.minTier) {
    throw new DomainError("forbidden", `This supplier only accepts sample requests from buyers verified at tier ${ctx.minTier} or above.`, undefined, "samples.tierRequired", { tier: ctx.minTier });
  }
  const open = await prisma.sampleRequest.count({ where: { buyerBusinessId: actor.businessId, status: { in: OPEN_STATUSES } } });
  if (open >= cfg.maxOpenPerBuyer) {
    throw new DomainError("conflict", `You already have ${cfg.maxOpenPerBuyer} open sample requests. Wait for one to finish before asking for another.`, undefined, "samples.tooManyOpen", { max: cfg.maxOpenPerBuyer });
  }

  const now = new Date();
  const respondBy = new Date(now.getTime() + cfg.responseHours * HOUR_MS);
  const s = input.shipTo;
  try {
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.sampleRequest.create({
        data: {
          buyerBusinessId: actor.businessId, buyerPersonId: actor.personId, sellerBusinessId: ctx.sellerBusinessId,
          listingId: ctx.listingId, matchId: ctx.matchId, enquiryId: ctx.enquiryId, quoteId: ctx.quoteId, subject: ctx.subject.slice(0, 200),
          quantity: input.quantity, unit: ctx.unit, buyerNote: input.note || null, language: input.language, buyerTier,
          shipName: s.name, shipPhone: s.phone || null, shipLine1: s.line1, shipLine2: s.line2 || null, shipCity: s.city, shipPincode: s.pincode,
          amountPaise: BigInt(ctx.amountPaise), respondBy, activeKey: activeKeyFor(actor.businessId, ctx),
        },
      });
      await logStatus(tx, created.id, "requested", "buyer");
      await emit(tx, "SampleRequested", { type: "sample", id: created.id }, {
        sampleId: created.id, buyerBusinessId: actor.businessId, sellerBusinessId: ctx.sellerBusinessId, listingId: ctx.listingId, quantity: input.quantity,
        amountPaise: ctx.amountPaise, respondBy: respondBy.toISOString(),
      });
      return created;
    });
    return await viewOf(row.id, actor);
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError("conflict", "You already have an open sample request for this.", undefined, "samples.duplicate");
    throw err;
  }
}

/** The buyer withdraws a request before it is dispatched. */
export async function cancelSample(actor: Actor, id: string): Promise<SampleView> {
  requireEnabled();
  const { r, role } = await loadForParty(actor, id);
  if (role !== "buyer") throw new DomainError("forbidden", "Only the buyer can cancel a sample request.");
  await prisma.$transaction(async (tx) => {
    await lockSample(tx, id);
    const cur = await tx.sampleRequest.findUniqueOrThrow({ where: { id } });
    assertTransition(status(cur), "cancelled");
    await tx.sampleRequest.update({ where: { id }, data: { status: "cancelled", activeKey: null } });
    await logStatus(tx, id, "cancelled", "buyer");
    await emit(tx, "SampleCancelled", { type: "sample", id }, { sampleId: id, buyerBusinessId: r.buyerBusinessId, sellerBusinessId: r.sellerBusinessId });
  });
  return viewOf(id, actor);
}

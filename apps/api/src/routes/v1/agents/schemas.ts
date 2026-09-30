import { z } from "@hono/zod-openapi";

const uuid = (example = "0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10") => z.string().openapi({ format: "uuid", example });
const iso = z.string().openapi({ format: "date-time" });

export const Side = z.enum(["buyer", "seller"]);
export const Status = z.enum(["open", "agreed", "accepted", "rejected", "withdrawn", "expired"]);

export const OfferTerms = z
  .object({
    pricePaise: z.number().int().positive().openapi({ description: "Unit price in integer paise (INR x 100).", example: 125000 }),
    quantity: z.number().int().positive().openapi({ example: 500 }),
    unit: z.string().min(1).max(20).openapi({ example: "pc" }),
    leadTimeDays: z.number().int().min(0).max(365).openapi({ example: 10 }),
    deliveryTerms: z.string().max(300).nullish(),
    validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).openapi({ description: "Last day (inclusive, YYYY-MM-DD) the offer can be accepted. At most 90 days ahead.", example: "2026-10-15" }),
    paymentTerms: z.string().max(200).nullish(),
  })
  .openapi("AgentOfferTerms");
const OfferOut = OfferTerms.extend({ deliveryTerms: z.string().nullable(), paymentTerms: z.string().nullable() }).openapi("AgentOffer");

export const NegotiationMessageBody = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("offer"), offer: OfferTerms }).openapi({ description: "Opening offer (only when there is no standing offer)." }),
    z.object({ type: z.literal("counter"), offer: OfferTerms }).openapi({ description: "Counter the other side's standing offer." }),
    z.object({ type: z.literal("accept") }).openapi({ description: "Accept the other side's standing offer." }),
    z.object({ type: z.literal("reject") }).openapi({ description: "Reject the other side's standing offer and close the negotiation." }),
    z.object({ type: z.literal("withdraw") }).openapi({ description: "Withdraw from the negotiation (either side, any time while open)." }),
  ])
  .openapi("AgentNegotiationMessage");

export const NegotiationStart = z
  .object({ mandateId: uuid(), matchId: uuid() })
  .openapi("AgentNegotiationStart");

export const idempotencyHeader = z.object({
  "idempotency-key": z.string().min(1).max(100).openapi({ description: "REQUIRED. Unique per message you intend to send; retrying with the same key returns the original result.", example: "neg-42-counter-1" }),
});
export const optionalIdempotencyHeader = z.object({
  "idempotency-key": z.string().min(1).max(100).optional().openapi({ description: "Optional. Makes a retried start return the same negotiation." }),
});

export const Mandate = z
  .object({
    id: uuid(), businessId: uuid(), side: Side, status: z.string(), name: z.string(), categorySlug: z.string().nullable(),
    quantity: z.number().nullable(), unit: z.string().nullable(), targetPricePaise: z.number().nullable(),
    limitPricePaise: z.number().nullable().openapi({ description: "Your own limit (buyer: maximum price; seller: floor). Never visible to the counterparty." }),
    maxLeadTimeDays: z.number().nullable(), maxRounds: z.number(), expiresAt: iso.nullable(),
    autoAccept: z.boolean().openapi({ description: "Set by the business's people in the app; cannot be changed through the API." }),
    autoAcceptLimitPaise: z.number().nullable(), version: z.number(), createdAt: iso, updatedAt: iso,
  })
  .passthrough()
  .openapi("AgentMandate");

export const Negotiation = z
  .object({
    id: uuid(), status: Status, youAre: Side,
    buyer: z.object({ businessId: uuid(), name: z.string() }), seller: z.object({ businessId: uuid(), name: z.string() }),
    enquiryId: uuid(), matchId: uuid(), round: z.number(), maxRounds: z.number(), turn: Side.nullable(),
    lastOffer: OfferOut.extend({ by: Side }).nullable(), agreed: OfferOut.nullable(),
    yourConfirmation: z.enum(["pending", "human", "auto", "declined"]), counterpartyConfirmed: z.boolean(),
    canConfirm: z.boolean().openapi({ description: "Informational: only the business's people can confirm, in the app." }),
    yourLimits: z.record(z.string(), z.unknown()).nullable().openapi({ description: "Your own limits only; the counterparty's are never included." }),
    expiresAt: iso, createdAt: iso, closedAt: iso.nullable(),
    messages: z.array(z.object({
      seq: z.number(), side: Side, type: z.enum(["offer", "counter", "accept", "reject", "withdraw"]), offer: OfferOut.nullable(),
      actor: z.enum(["agent", "external_agent", "person"]), mine: z.boolean(), createdAt: iso,
    })),
  })
  .passthrough()
  .openapi("AgentNegotiation");

export const NegotiationSummary = z
  .object({
    id: uuid(), status: Status, youAre: Side, counterparty: z.object({ businessId: uuid(), name: z.string() }), enquiryId: uuid(), matchId: uuid(),
    round: z.number(), maxRounds: z.number(), turn: Side.nullable(), lastPricePaise: z.number().nullable(), agreedPricePaise: z.number().nullable(),
    canConfirm: z.boolean(), createdAt: iso, expiresAt: iso,
  })
  .passthrough()
  .openapi("AgentNegotiationSummary");

export const NegotiationListQuery = z.object({
  status: Status.optional(), side: Side.optional(),
  cursor: z.string().optional().openapi({ description: "Opaque cursor from a previous response's `nextCursor`." }),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const MandateListQuery = z.object({
  side: Side.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const pageOf = <T extends z.ZodType>(name: string, item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() }).openapi(name);

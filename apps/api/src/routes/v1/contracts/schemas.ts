import { z } from "@hono/zod-openapi";

const uuid = (example = "0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10") => z.string().openapi({ format: "uuid", example });
const iso = z.string().openapi({ format: "date-time" });
const day = (example: string) => z.string().openapi({ description: "Indian calendar date, YYYY-MM-DD.", example });
const Role = z.enum(["buyer", "seller"]);
export const ContractStatus = z.enum(["draft", "proposed", "active", "expired", "terminated"]);
const paise = (description: string) => z.number().int().openapi({ description });

export const ContractListQuery = z.object({
  role: Role.default("buyer").openapi({ description: "Which side of the contracts to list: those where your business is the buyer or the seller." }),
  status: ContractStatus.optional(),
  cursor: z.string().optional().openapi({ description: "Opaque cursor from a previous response's `nextCursor`." }),
  limit: z.coerce.number().int().min(1).max(50).default(25).openapi({ description: "Page size (1-50)." }),
});

export const ContractRow = z
  .object({
    id: uuid(),
    number: z.string().openapi({ example: "RC/26-27/000003" }),
    title: z.string(),
    status: ContractStatus,
    role: Role,
    counterparty: z.object({ businessId: uuid(), name: z.string() }),
    validFrom: day("2026-10-06").nullable(),
    validTo: day("2027-10-05").nullable(),
    valuePercent: z.number().int().nullable().openapi({ description: "Percent of the contract value cap used; null without a value cap." }),
    needsAnswer: z.boolean().openapi({ description: "True when your business has to accept or decline a pending revision." }),
    createdAt: iso,
  })
  .openapi("RateContractRow");

const Item = z
  .object({
    itemKey: uuid(),
    lineNo: z.number().int(),
    listingId: z.string().nullable(),
    description: z.string(),
    hsn: z.string().nullable(),
    unit: z.string(),
    unitPricePaise: paise("Contract price per unit before GST, integer paise (INR x 100)."),
    gstRateBps: z.number().int().openapi({ description: "GST rate in basis points (1800 = 18%)." }),
    moq: z.number().int().nullable().openapi({ description: "Minimum quantity per call-off." }),
    quantityCap: z.number().int().nullable().openapi({ description: "Cap on the total quantity over the life of the contract." }),
    variationKind: z.enum(["fixed", "indexed"]),
    variationCapBps: z.number().int().nullable().openapi({ description: "For indexed items: the most a call-off price may differ from the contract price, in basis points." }),
    variationNote: z.string().nullable(),
    consumedQuantity: z.number().int(),
    remainingQuantity: z.number().int().nullable(),
    usedPercent: z.number().int().nullable(),
  })
  .openapi("RateContractItem");

const Answer = z.enum(["pending", "accepted", "rejected"]);
const Revision = z
  .object({
    revision: z.number().int(),
    proposedByRole: Role,
    createdAt: iso,
    validFrom: day("2026-10-06"),
    validTo: day("2027-10-05"),
    paymentTermsDays: z.number().int(),
    priceBasis: z.enum(["ex_works", "for_destination", "delivered", "other"]),
    valueCapPaise: z.number().int().nullable(),
    notes: z.string().nullable(),
    changeNote: z.string().nullable(),
    items: z.array(Item),
    answers: z.object({ buyer: Answer, seller: Answer, buyerReason: z.string().nullable(), sellerReason: z.string().nullable() }),
  })
  .openapi("RateContractRevision");

const CallOff = z
  .object({
    id: uuid(),
    callOffNo: z.number().int(),
    orderId: uuid(),
    revision: z.number().int(),
    status: z.enum(["placed", "cancelled"]),
    taxablePaise: paise("Order value before GST, paise."),
    createdAt: iso,
    lines: z.array(z.object({
      itemKey: uuid(), description: z.string(), unit: z.string(), quantity: z.number().int(),
      contractPricePaise: z.number().int(), appliedPricePaise: z.number().int(), taxablePaise: z.number().int(),
    })),
  })
  .openapi("RateContractCallOff");

export const Contract = z
  .object({
    id: uuid(),
    number: z.string(),
    title: z.string(),
    status: ContractStatus,
    role: Role,
    counterparty: z.object({ businessId: uuid(), name: z.string() }),
    latestRevision: z.number().int(),
    activeRevision: z.number().int().nullable(),
    phase: z.enum(["not_started", "in_force", "ended"]).nullable(),
    daysLeft: z.number().int().nullable(),
    current: Revision.nullable().openapi({ description: "The terms in force (the revision both parties accepted)." }),
    pending: Revision.nullable().openapi({ description: "A revision waiting for an answer, if any." }),
    history: z.array(z.object({
      revision: z.number().int(), proposedByRole: Role, createdAt: iso, changeNote: z.string().nullable(), state: z.enum(["active", "superseded", "pending", "declined"]),
    })),
    consumption: z.object({ valueUsedPaise: z.number().int(), valueCapPaise: z.number().int().nullable(), valuePercent: z.number().int().nullable() }),
    callOffs: z.array(CallOff),
    sourceQuoteId: z.string().nullable(),
    renewedFromId: z.string().nullable(),
    terminationReason: z.string().nullable(),
    terminatedByRole: Role.nullable(),
    createdAt: iso,
    actions: z.object({ edit: z.boolean(), send: z.boolean(), propose: z.boolean(), respond: z.boolean(), terminate: z.boolean(), callOff: z.boolean(), renew: z.boolean() }),
  })
  .openapi("RateContract");

export const CallOffCreate = z
  .object({
    lines: z.array(z.object({
      itemKey: uuid().openapi({ description: "`itemKey` of an item on the contract's current terms." }),
      quantity: z.number().int().positive().openapi({ example: 500 }),
      unitPricePaise: z.number().int().positive().nullish().openapi({ description: "Only for an `indexed` item: the price for this call-off, within the item's cap. Fixed prices cannot be overridden." }),
    })).min(1).max(50),
    addressId: uuid().nullish().openapi({ description: "One of your saved delivery addresses; required while purchase orders are enabled." }),
    expectedDelivery: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().openapi({ description: "YYYY-MM-DD, not in the past." }),
    notes: z.string().max(1000).nullish(),
  })
  .openapi("RateContractCallOffCreate", {
    example: { lines: [{ itemKey: "0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10", quantity: 500 }], addressId: "0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d11", expectedDelivery: "2026-11-15" },
  });

export const CallOffResult = z
  .object({
    callOff: CallOff,
    orderId: uuid(),
    purchaseOrder: z.object({ id: uuid(), number: z.string(), status: z.string(), totalPaise: z.number().int() }).nullable(),
    purchaseOrderError: z.string().nullable().openapi({ description: "Set when the order exists but its purchase order could not be issued; issue it from the order page." }),
    contract: Contract,
  })
  .openapi("RateContractCallOffResult");

export const idempotencyHeader = z.object({
  "idempotency-key": z.string().min(1).max(100).openapi({
    description: "REQUIRED. Unique per call-off you intend to place; retrying with the same key returns the original result instead of ordering twice.",
    example: "po-run-2026-10-06-1",
  }),
});

import { z } from "@hono/zod-openapi";

const iso = (example: string) => z.string().openapi({ format: "date-time", example });
const uuid = (example = "0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10") => z.string().openapi({ format: "uuid", example });
export const Currency = z.literal("INR").openapi({ description: "All money is integer paise in INR." });

export const ErrorEnvelope = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "insufficient_scope" }),
      message: z.string(),
      requestId: z.string(),
      issues: z.array(z.object({ path: z.string(), message: z.string() })).optional().openapi({ description: "Present on 422 validation errors." }),
    }),
  })
  .openapi("Error");

export const Id = z.object({ id: uuid() });

export const pageQuery = {
  cursor: z.string().optional().openapi({ description: "Opaque cursor from a previous response's `nextCursor`." }),
  limit: z.coerce.number().int().min(1).max(100).default(25).openapi({ description: "Page size (1-100)." }),
};
export const pageOf = <T extends z.ZodType>(name: string, item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable().openapi({ description: "null when there are no more results." }) }).openapi(name);

export const Category = z
  .object({
    id: uuid(),
    slug: z.string().openapi({ example: "industrial-fasteners" }),
    name: z.string(),
    icon: z.string().nullable(),
    parentId: z.string().nullable(),
    attributeSchema: z.object({
      fields: z.array(z.object({
        key: z.string(), label: z.string(), type: z.enum(["text", "number", "select"]),
        required: z.boolean().optional(), unit: z.string().optional(), options: z.array(z.string()).optional(),
      })),
    }).openapi({ description: "Attributes a listing in this category may/must carry." }),
  })
  .openapi("Category");

export const TrustProfile = z
  .object({
    businessId: uuid(),
    name: z.string().openapi({ example: "Sharma Fasteners Pvt Ltd" }),
    city: z.string().nullable(),
    state: z.string().nullable(),
    pincode: z.string().nullable(),
    verificationTier: z.number().int().openapi({ description: "0 = unverified ... higher = more verified (GSTIN/Udyam)." }),
    trustScore: z.number(),
    badgeActive: z.boolean().openapi({ description: "Trust badge earned (not purchasable)." }),
    languages: z.array(z.string()),
  })
  .openapi("TrustProfile");

const listingBase = {
  id: uuid(),
  sellerBusinessId: uuid(),
  category: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  title: z.string().openapi({ example: "M8 Stainless Steel Hex Bolts (A2-70)" }),
  description: z.string(),
  attributes: z.record(z.string(), z.union([z.string(), z.number()])),
  pricePaise: z.number().int().nullable().openapi({ example: 1250, description: "Unit price in paise." }),
  currency: Currency,
  priceUnit: z.string().nullable().openapi({ example: "piece" }),
  moq: z.number().int().nullable(),
  moqUnit: z.string().nullable(),
  hsn: z.string().nullable(),
  language: z.string(),
  imageUrls: z.array(z.string()),
  aiGenerated: z.boolean(),
  createdAt: iso("2026-09-01T10:00:00.000Z"),
  updatedAt: iso("2026-09-02T10:00:00.000Z"),
};
export const Listing = z.object(listingBase).openapi("Listing");
export const SellerListing = z
  .object({
    ...listingBase,
    status: z.enum(["draft", "published", "archived"]),
    moderationStatus: z.enum(["pending", "approved", "review", "rejected"]),
    moderationReason: z.string().nullable(),
  })
  .openapi("SellerListing");

export const SearchHit = z
  .object({
    listing: Listing,
    seller: TrustProfile,
    score: z.number().openapi({ description: "Relevance x trust. Never influenced by paid tier (ADR-009)." }),
    sponsored: z.literal(false).openapi({ description: "Always false: there are no paid placements." }),
  })
  .openapi("SearchHit");

const listingWritable = {
  categoryId: z.string().optional().openapi({ description: "Category id. Alternatively pass categorySlug." }),
  categorySlug: z.string().optional().openapi({ example: "industrial-fasteners" }),
  title: z.string().min(3).max(200),
  description: z.string().max(5000),
  attributes: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  pricePaise: z.number().int().min(0).nullable().default(null),
  priceUnit: z.string().nullable().default(null),
  moq: z.number().int().min(1).nullable().default(null),
  moqUnit: z.string().nullable().default(null),
  hsn: z.string().nullable().default(null),
  language: z.string().default("en"),
  imageUrls: z.array(z.string()).default([]),
};
export const ListingCreate = z
  .object(listingWritable)
  .openapi("ListingCreate", {
    example: {
      categorySlug: "industrial-fasteners", title: "M8 Stainless Steel Hex Bolts (A2-70)", description: "DIN 933, full thread, A2-70.",
      attributes: { material: "SS304" }, pricePaise: 1250, priceUnit: "piece", moq: 500, moqUnit: "piece", hsn: "73181500", language: "en", imageUrls: [],
    },
  });
export const ListingPatch = z
  .object({
    categoryId: listingWritable.categoryId,
    categorySlug: listingWritable.categorySlug,
    title: listingWritable.title.optional(),
    description: listingWritable.description.optional(),
    attributes: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    pricePaise: z.number().int().min(0).nullable().optional(),
    priceUnit: z.string().nullable().optional(),
    moq: z.number().int().min(1).nullable().optional(),
    moqUnit: z.string().nullable().optional(),
    hsn: z.string().nullable().optional(),
    language: z.string().optional(),
    imageUrls: z.array(z.string()).optional(),
  })
  .openapi("ListingPatch");

export const Match = z
  .object({
    id: uuid(),
    enquiryId: uuid(),
    sellerBusinessId: uuid(),
    sellerName: z.string(),
    rank: z.number().int(),
    of: z.number().int().openapi({ description: "N: the enquiry is exclusive to at most N sellers (ADR-002)." }),
    matchScore: z.number(),
    status: z.enum(["offered", "accepted", "declined", "expired", "refunded"]),
    respondBy: iso("2026-09-30T10:00:00.000Z"),
    conversationId: z.string().nullable(),
    seller: z.object({ verificationTier: z.number(), badgeActive: z.boolean(), trustScore: z.number(), city: z.string().nullable() }).optional(),
  })
  .openapi("Match");

const enquiryBase = {
  id: uuid(),
  title: z.string(),
  requirement: z.string(),
  category: z.object({ slug: z.string(), name: z.string() }).nullable(),
  quantity: z.number().nullable(),
  quantityUnit: z.string().nullable(),
  targetPricePaise: z.number().int().nullable(),
  currency: Currency,
  deliveryCity: z.string().nullable(),
  deliveryPincode: z.string().nullable(),
  neededBy: z.string().nullable(),
  intentScore: z.number().nullable().openapi({ description: "AI intent score; low-intent enquiries are held for review." }),
  intentReasons: z.array(z.string()),
  status: z.enum(["scoring", "review", "matched", "unmatched", "closed", "rejected"]),
  createdAt: iso("2026-09-01T10:00:00.000Z"),
  buyerPicks: z.boolean().optional(),
  sellerCap: z.number().int().optional(),
  awaitingPick: z.boolean().optional(),
};
export const Enquiry = z.object({ ...enquiryBase, matches: z.array(Match) }).openapi("Enquiry");

export const EnquiryCreate = z
  .object({
    title: z.string().min(5).max(140),
    requirement: z.string().min(10).max(4000),
    categorySlug: z.string().nullish(),
    quantity: z.number().int().positive().nullish(),
    quantityUnit: z.string().max(20).nullish(),
    targetPricePaise: z.number().int().positive().nullish().openapi({ description: "Target unit price in paise." }),
    deliveryCity: z.string().max(80).nullish(),
    deliveryPincode: z.string().regex(/^[1-9]\d{5}$/).nullish(),
    neededBy: z.string().nullish().openapi({ description: "ISO date." }),
    language: z.string().max(8).default("en"),
    preferredListingId: z.string().nullish().openapi({ description: "Rank this listing's seller first if eligible." }),
  })
  .openapi("EnquiryCreate", {
    example: {
      title: "500 kg SS304 sheets", requirement: "Need 500 kg of 2mm SS304 sheets, mill test certificate required, delivery to Pune.",
      categorySlug: "steel-sheets", quantity: 500, quantityUnit: "kg", targetPricePaise: 21000, deliveryCity: "Pune", deliveryPincode: "411001", language: "en",
    },
  });

export const Lead = z
  .object({
    matchId: uuid(),
    enquiry: z.object(enquiryBase),
    rank: z.number().int(),
    of: z.number().int(),
    status: z.enum(["offered", "accepted", "declined", "expired", "refunded"]),
    respondBy: iso("2026-09-30T10:00:00.000Z"),
    buyer: z.object({
      businessName: z.string(), city: z.string().nullable(), verificationTier: z.number(),
      phone: z.string().nullable().openapi({ description: "Revealed only after accepting the lead and with the buyer's consent." }),
    }),
    conversationId: z.string().nullable(),
    contactNote: z.string().nullable().optional(),
  })
  .openapi("Lead");

export const Quote = z
  .object({
    id: uuid(), pricePaise: z.number().int(), currency: Currency, quantity: z.number(), unit: z.string(),
    leadTimeDays: z.number().nullable(), notes: z.string().nullable(), validUntil: z.string().nullable(), createdAt: iso("2026-09-03T10:00:00.000Z"),
  })
  .openapi("Quote");
export const Conversation = z
  .object({
    id: uuid(), matchId: uuid(), enquiryId: z.string().optional(), enquiryTitle: z.string(),
    role: z.enum(["buyer", "seller"]).optional().openapi({ description: "Which side the key's business is on." }),
    buyer: z.object({ businessId: z.string(), name: z.string() }),
    seller: z.object({ businessId: z.string(), name: z.string() }),
    messages: z.array(z.object({ id: z.string(), senderPersonId: z.string(), body: z.string(), createdAt: iso("2026-09-03T10:00:00.000Z") })),
    quotes: z.array(Quote),
    dealReported: z.enum(["won", "lost", "pending"]).nullable(),
  })
  .openapi("Conversation");
export const MessageCreate = z.object({ body: z.string().min(1).max(4000) }).openapi("MessageCreate");
export const QuoteCreate = z
  .object({
    pricePaise: z.number().int().positive().openapi({ description: "Unit price in paise." }),
    quantity: z.number().int().positive(),
    unit: z.string().min(1).max(20),
    leadTimeDays: z.number().int().min(0).max(730).nullish(),
    notes: z.string().max(2000).nullish(),
    validUntil: z.string().nullish().openapi({ description: "ISO date." }),
  })
  .openapi("QuoteCreate", { example: { pricePaise: 20500, quantity: 500, unit: "kg", leadTimeDays: 7, notes: "MTC included", validUntil: "2026-10-15" } });
export const DealReportCreate = z
  .object({ outcome: z.enum(["won", "lost", "pending"]), valuePaise: z.number().int().min(0).nullish().openapi({ description: "Final deal value in paise." }) })
  .openapi("DealReportCreate");
export const Ok = z.object({ ok: z.literal(true) }).openapi("Ok");

export const WishlistSummary = z
  .object({ id: uuid(), name: z.string(), isDefault: z.boolean(), itemCount: z.number().int(), createdAt: iso("2026-09-01T10:00:00.000Z"), updatedAt: iso("2026-09-01T10:00:00.000Z") })
  .openapi("WishlistSummary");
export const WishlistDetail = WishlistSummary.extend({
  items: z.array(z.object({
    id: z.string(), listingId: z.string(), note: z.string().nullable(), savedPricePaise: z.number().nullable(), currentPricePaise: z.number().nullable(),
    currency: Currency, priceDropped: z.boolean(), createdAt: z.string(), listing: Listing.nullable(),
  })),
}).openapi("WishlistDetail");
export const WishlistAdd = z.object({ listingId: z.string() }).openapi("WishlistAdd");

export const Review = z
  .object({
    id: uuid(), rating: z.number().int().min(1).max(5), title: z.string().nullable(), body: z.string(), authorName: z.string(),
    verifiedEnquiry: z.boolean().openapi({ description: "Author had an accepted enquiry with this seller." }),
    helpfulCount: z.number().int(), createdAt: iso("2026-09-01T10:00:00.000Z"),
    sellerReply: z.object({ body: z.string(), at: z.string() }).nullable(),
  })
  .openapi("Review");
export const RatingSummary = z
  .object({ listingId: z.string(), count: z.number().int(), average: z.number(), histogram: z.array(z.number().int()).openapi({ description: "Counts for 1..5 stars (index 0 = 1 star)." }) })
  .openapi("RatingSummary");
export const ReviewList = z.object({ items: z.array(Review), nextCursor: z.string().nullable(), summary: RatingSummary }).openapi("ReviewList");
export const ReviewCreate = z
  .object({
    rating: z.number().int().min(1).max(5),
    title: z.string().max(120).optional(),
    body: z.string().min(10).max(2000).openapi({ description: "No phone numbers, emails or ID numbers (rejected)." }),
    language: z.string().default("en"),
  })
  .openapi("ReviewCreate", { example: { rating: 5, title: "Reliable supplier", body: "Delivered on time and the quality matched the sample." } });
export const MyReview = z
  .object({
    id: uuid(), rating: z.number().int(), title: z.string().nullable(), body: z.string(),
    status: z.enum(["pending", "approved", "rejected"]).openapi({ description: "New reviews are `pending` until staff moderate them; only approved reviews are public." }),
    moderationNote: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
  })
  .openapi("MyReview");

export const Balance = z
  .object({ credits: z.number().int().openapi({ description: "Lead credits available. Accepting a lead consumes 1." }), subscription: z.object({ planCode: z.string(), status: z.string(), periodEnd: z.string() }).nullable() })
  .openapi("CreditBalance");
export const Me = z
  .object({
    personId: uuid(), keyId: uuid(), scopes: z.array(z.string()), businessId: z.string().nullable(),
    business: TrustProfile.nullable(),
  })
  .openapi("Me");

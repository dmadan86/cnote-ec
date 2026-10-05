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
      variantAxes: z.array(z.object({ key: z.string(), label: z.string(), options: z.array(z.string()).optional() })).optional().openapi({ description: "Variant axes (size, colour, grade ...) a listing in this category can use; absent = no variants." }),
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

export const Availability = z.enum(["in_stock", "made_to_order", "out_of_stock"]).openapi({ description: "Stock state. `in_stock` ships now, `made_to_order` ships after the lead time, `out_of_stock` cannot be ordered." });

export const VariantAxis = z
  .object({ key: z.string().openapi({ example: "size" }), label: z.string().openapi({ example: "Size" }), options: z.array(z.string()).optional() })
  .openapi("VariantAxis");
const QuantityTier = z.object({ minQty: z.number().int().min(1), pricePaise: z.number().int().min(0) });
export const Variant = z
  .object({
    id: uuid(),
    sku: z.string().openapi({ example: "BOLT-M8-SS" }),
    axisValues: z.record(z.string(), z.string()).openapi({ example: { size: "M8", grade: "A2-70" }, description: "One value per variant axis of the category." }),
    pricePaise: z.number().int().nullable().openapi({ description: "Price override in paise; null = the listing's price." }),
    priceTiers: z.array(QuantityTier).openapi({ description: "Quantity tiers overriding the listing's; empty = inherit (or flat price when `pricePaise` is set)." }),
    moq: z.number().int().nullable().openapi({ description: "MOQ override; null = the listing's." }),
    availability: Availability,
    availableQty: z.number().int().nullable(),
    leadTimeDays: z.number().int().nullable().openapi({ description: "Days to deliver; null = the listing's lead time." }),
    imageId: z.string().nullable().openapi({ description: "Listing image id this variant shows, if any." }),
    sortOrder: z.number().int(),
    stockUpdatedAt: iso("2026-09-02T10:00:00.000Z").nullable().optional().openapi({ description: "Seller keys only." }),
  })
  .openapi("Variant");

const stockFields = {
  availability: Availability,
  availableQty: z.number().int().nullable().openapi({ description: "Units on hand, if the seller tracks it." }),
  stockUpdatedAt: iso("2026-09-02T10:00:00.000Z").nullable().openapi({ description: "When the seller last set the stock; null = never stated." }),
  variantAxes: z.array(VariantAxis).openapi({ description: "Variant axes of the listing's category (empty = no variants)." }),
  variants: z.array(Variant).openapi({ description: "0..100 variants. `availability` above is the best of them (the listing is in stock while any variant is)." }),
};

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
  ...stockFields,
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
    sku: z.string().nullable().optional().openapi({ description: "Your own product code, if set." }),
  })
  .openapi("SellerListing");

export const StockPatch = z
  .object({
    availability: Availability.optional(),
    availableQty: z.number().int().min(0).nullable().optional(),
    leadTimeDays: z.number().int().min(0).max(730).nullable().optional().openapi({ description: "Required (here or already stored) for `made_to_order`." }),
    variants: z
      .array(
        z.object({
          id: z.string().optional(),
          sku: z.string().optional().openapi({ description: "Match a variant by sku when `id` is not given." }),
          availability: Availability.optional(),
          availableQty: z.number().int().min(0).nullable().optional(),
          leadTimeDays: z.number().int().min(0).max(730).nullable().optional(),
        }),
      )
      .max(100)
      .optional(),
  })
  .openapi("StockPatch", { example: { availability: "made_to_order", leadTimeDays: 14 } });

export const VariantInput = z
  .object({
    id: z.string().optional().openapi({ description: "Keeps an existing variant's identity; otherwise matched by `sku`." }),
    sku: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    axisValues: z.record(z.string(), z.string().min(1).max(60)),
    pricePaise: z.number().int().min(0).nullable().optional(),
    priceTiers: z.array(QuantityTier).max(8).optional(),
    moq: z.number().int().min(1).nullable().optional(),
    availability: Availability.optional(),
    availableQty: z.number().int().min(0).nullable().optional(),
    leadTimeDays: z.number().int().min(0).max(730).nullable().optional(),
    imageId: z.string().nullable().optional(),
  })
  .openapi("VariantInput");
export const VariantsPut = z.object({ variants: z.array(VariantInput).max(100) }).openapi("VariantsPut");

export const Facets = z
  .object({
    category: z.array(z.object({ key: z.string(), count: z.number().int() })),
    city: z.array(z.object({ key: z.string(), count: z.number().int() })),
    state: z.array(z.object({ key: z.string(), count: z.number().int() })),
    verificationTier: z.array(z.object({ key: z.string(), count: z.number().int() })),
    price: z.array(z.object({ key: z.string(), count: z.number().int(), fromPaise: z.number().nullable(), toPaise: z.number().nullable() })),
    variant: z.array(z.object({ key: z.string().openapi({ example: "size:m" }), count: z.number().int() })).openapi({ description: "Lower-cased `axis:value` pairs of listing variants, most common first." }),
  })
  .openapi("Facets");

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
  sku: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).nullable().optional().openapi({ description: "Your own product code (letters, digits, . _ -; unique per seller). Used to update listings from bulk imports." }),
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
    sku: listingWritable.sku,
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

export const EnquiryLine = z
  .object({
    id: uuid(),
    ordinal: z.number().int().openapi({ description: "1-based line number." }),
    itemName: z.string(),
    spec: z.string().nullable(),
    quantity: z.number().int(),
    unit: z.string(),
    targetPricePaise: z.number().int().nullable().openapi({ description: "Target unit price in paise." }),
    category: z.object({ slug: z.string(), name: z.string() }).nullable(),
    hsn: z.string().nullable(),
  })
  .openapi("EnquiryLine");
export const EnquiryLineCreate = z
  .object({
    itemName: z.string().min(1).max(140),
    spec: z.string().max(1000).nullish(),
    quantity: z.number().int().positive(),
    unit: z.string().min(1).max(20),
    targetPricePaise: z.number().int().positive().nullish().openapi({ description: "Target unit price in paise." }),
    categorySlug: z.string().max(100).nullish(),
    hsn: z.string().regex(/^\d{4}(\d{2}(\d{2})?)?$/).nullish().openapi({ description: "HSN code, 4, 6 or 8 digits." }),
  })
  .openapi("EnquiryLineCreate");

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
  status: z.enum(["scoring", "review", "matched", "unmatched", "closed", "rejected", "pending_approval"]),
  createdAt: iso("2026-09-01T10:00:00.000Z"),
  buyerPicks: z.boolean().optional(),
  sellerCap: z.number().int().optional(),
  awaitingPick: z.boolean().optional(),
  lines: z.array(EnquiryLine).openapi({ description: "Bill-of-materials lines (always at least one). Line 1 mirrors `quantity`/`quantityUnit`." }),
};
export const Enquiry = z.object({ ...enquiryBase, matches: z.array(Match) }).openapi("Enquiry");

export const EnquiryCreate = z
  .object({
    title: z.string().min(5).max(140).optional().openapi({ description: "Required unless `lines` is given (then derived from the lines)." }),
    requirement: z.string().min(10).max(4000).optional().openapi({ description: "Required unless `lines` is given." }),
    lines: z.array(EnquiryLineCreate).min(1).max(50).nullish().openapi({
      description: "Multi-line RFQ (bill of materials), 1-50 lines. `quantity`, `quantityUnit` and `targetPricePaise` then mirror line 1 and are ignored if sent. Each line is matched, moderated and intent-scored with the rest of the RFQ.",
    }),
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
  .refine((v) => !!v.lines?.length || (!!v.title && !!v.requirement), { message: "title and requirement are required unless lines are given", path: ["title"] })
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

export const QuoteLine = z
  .object({
    id: uuid(), enquiryLineId: uuid(), ordinal: z.number().int(),
    unitPricePaise: z.number().int().nullable().openapi({ description: "Per unit; null when the supplier cannot supply the line." }),
    gstRatePct: z.number().int().nullable(), leadTimeDays: z.number().int().nullable(), cantSupply: z.boolean(), notes: z.string().nullable(),
    quantity: z.number().int().openapi({ description: "The requirement line's quantity the amounts were computed for." }),
    lineSubtotalPaise: z.number().int().nullable(), lineGstPaise: z.number().int().nullable(), lineTotalPaise: z.number().int().nullable(),
  })
  .openapi("QuoteLine");
export const Quote = z
  .object({
    id: uuid(), pricePaise: z.number().int(), currency: Currency, quantity: z.number(), unit: z.string(),
    leadTimeDays: z.number().nullable(), notes: z.string().nullable(), validUntil: z.string().nullable(), createdAt: iso("2026-09-03T10:00:00.000Z"),
    lineTotals: z.object({ subtotalPaise: z.number().int(), gstPaise: z.number().int(), totalPaise: z.number().int(), quotedLineCount: z.number().int() }).nullable()
      .openapi({ description: "Server-computed totals of a per-line quote (null on single-field quotes). `pricePaise`/`quantity`/`unit` then mirror the first priced line." }),
    lines: z.array(QuoteLine).optional().openapi({ description: "Per-line prices of a multi-line quote." }),
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
    sellerClaimedWon: z.boolean().optional().openapi({ description: "The seller reported the deal as won; only the buyer's own report records it." }),
  })
  .openapi("Conversation");
export const MessageCreate = z.object({ body: z.string().min(1).max(4000) }).openapi("MessageCreate");
export const QuoteLineCreate = z
  .object({
    enquiryLineId: z.string().nullish().openapi({ description: "Requirement line id. Give this or `ordinal`." }),
    ordinal: z.number().int().positive().nullish().openapi({ description: "1-based requirement line number. Give this or `enquiryLineId`." }),
    unitPricePaise: z.number().int().positive().nullish().openapi({ description: "Unit price in paise. Required unless `cantSupply`." }),
    gstRatePct: z.number().int().min(0).max(40).nullish(),
    leadTimeDays: z.number().int().min(0).max(730).nullish(),
    cantSupply: z.boolean().nullish().openapi({ description: "The supplier cannot supply this line. Lines you leave out are treated as skipped (partial quote)." }),
    notes: z.string().max(300).nullish(),
  })
  .openapi("QuoteLineCreate");
export const QuoteCreate = z
  .object({
    pricePaise: z.number().int().positive().optional().openapi({ description: "Unit price in paise. Required unless `lines` is given (then mirrored from the first priced line)." }),
    quantity: z.number().int().positive().optional(),
    unit: z.string().min(1).max(20).optional(),
    leadTimeDays: z.number().int().min(0).max(730).nullish(),
    notes: z.string().max(2000).nullish(),
    validUntil: z.string().nullish().openapi({ description: "ISO date." }),
    gstIncluded: z.boolean().nullish().openapi({ description: "Unit prices already include GST. Applies to every line." }),
    lines: z.array(QuoteLineCreate).min(1).max(50).nullish().openapi({
      description: "Per-line prices for a multi-line RFQ (required when the enquiry has more than one line; partial quotes are fine). Totals are computed by the server.",
    }),
  })
  .refine((v) => !!v.lines?.length || (v.pricePaise != null && v.quantity != null && !!v.unit), { message: "pricePaise, quantity and unit are required unless lines are given", path: ["pricePaise"] })
  .openapi("QuoteCreate", { example: { pricePaise: 20500, quantity: 500, unit: "kg", leadTimeDays: 7, notes: "MTC included", validUntil: "2026-10-15" } });
export const LineAwardCreate = z
  .object({
    awards: z.array(z.object({ enquiryLineId: z.string(), quoteId: z.string() })).min(1).max(50).openapi({
      description: "One entry per requirement line: which supplier quote gets it. Lines may go to different suppliers; each supplier gets one order covering only its lines.",
    }),
  })
  .openapi("LineAwardCreate");
export const LineAwardResult = z
  .object({
    results: z.array(z.object({
      orderId: uuid(), quoteId: uuid(), matchId: uuid(), sellerBusinessId: uuid(), enquiryLineIds: z.array(z.string()),
      totalPaise: z.number().int().openapi({ description: "Payable for the awarded lines, GST per line." }),
    })),
  })
  .openapi("LineAwardResult");
export const AwardedLine = z
  .object({
    enquiryLineId: uuid(), quoteLineId: uuid(), quoteId: uuid(), orderId: uuid(), enquiryId: uuid(), sellerBusinessId: uuid(), ordinal: z.number().int(),
    itemName: z.string(), spec: z.string().nullable(), hsn: z.string().nullable(), quantity: z.number().int(), unit: z.string(), unitPricePaise: z.number().int(),
    gstRatePct: z.number().int().nullable(), gstIncluded: z.boolean().nullable(), leadTimeDays: z.number().int().nullable(),
    lineSubtotalPaise: z.number().int(), lineGstPaise: z.number().int(), lineTotalPaise: z.number().int(), awardedAt: iso("2026-09-05T10:00:00.000Z"),
  })
  .openapi("AwardedLine");
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
    person: z.object({ id: uuid(), name: z.string().nullable(), email: z.string().nullable().openapi({ description: "Masked, e.g. a***@gmail.com" }) }),
    businesses: z.array(z.object({
      businessId: uuid(), name: z.string(), role: z.enum(["owner", "staff", "admin", "requester", "approver", "finance", "viewer"]), isSeller: z.boolean(), isBuyer: z.boolean(),
      verificationTier: z.number().int(), badgeActive: z.boolean(),
    })),
  })
  .openapi("Me");

const rangeSchema = z.object({ min: z.number().int(), max: z.number().int() });
export const FreightEstimate = z
  .object({
    listingId: uuid(),
    quantity: z.number().int(),
    unit: z.string().nullable(),
    unitPricePaise: z.number().int().nullable(),
    goodsPaise: z.number().int().nullable(),
    estimate: z.object({
      mode: z.enum(["parcel", "ltl", "ftl"]).openapi({ description: "parcel = courier, ltl = part truck, ftl = full truck." }),
      zone: z.enum(["local", "intra_state", "metro", "regional", "national", "special"]),
      destinationState: z.string().nullable(),
      actualWeightKg: z.number(),
      volumetricWeightKg: z.number().nullable(),
      chargeableWeightKg: z.number(),
      vehicles: z.number().int(),
      lowPaise: z.number().int().openapi({ description: "Low end of the freight range in paise, before GST." }),
      highPaise: z.number().int().openapi({ description: "High end of the freight range in paise, before GST." }),
      midPaise: z.number().int(),
      gstLowPaise: z.number().int(),
      gstHighPaise: z.number().int(),
      gstRateBps: z.number().int(),
      fuelSurchargeBps: z.number().int(),
      transitDays: rangeSchema,
      assumptions: z.array(z.string()).openapi({ description: "Machine codes for every assumption made (for example weight_default, dims_missing, origin_unknown)." }),
      estimateOnly: z.literal(true).openapi({ description: "Always true: the final freight is quoted by the seller." }),
    }),
    landed: z.object({ low: z.record(z.string(), z.unknown()), high: z.record(z.string(), z.unknown()) }).nullable().openapi({ description: "Goods + freight + GST on freight (low and high). Product GST is not included." }),
  })
  .openapi("FreightEstimate");

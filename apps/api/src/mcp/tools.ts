import type { Scope } from "@cnote/developer";
import { z } from "zod";
import * as ops from "../ops";
import { AGENT_TOOLS } from "./tools/agents";

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  scope: Scope;
  title: string;
  description: string;
  input: S;
  /** MCP annotations: readOnly for reads; destructive/idempotent for writes. */
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: false };
  run: (p: Parameters<typeof ops.me>[0], args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

const tool = <S extends z.ZodRawShape>(t: ToolDef<S>) => t as unknown as ToolDef;
const read = { readOnlyHint: true, openWorldHint: false } as const;
const write = (o: { destructive?: boolean; idempotent?: boolean } = {}) =>
  ({ readOnlyHint: false, destructiveHint: o.destructive ?? false, idempotentHint: o.idempotent ?? false, openWorldHint: false }) as const;

const id = (what: string) => z.string().describe(`${what} (UUID)`);
const page = { cursor: z.string().optional().describe("nextCursor from the previous page"), limit: z.number().int().min(1).max(100).default(25) };
const listingFields = {
  categorySlug: z.string().optional().describe("Category slug from list_categories"),
  categoryId: z.string().optional(),
  title: z.string().min(3).max(200),
  description: z.string().max(5000),
  attributes: z.record(z.string(), z.union([z.string(), z.number()])).default({}).describe("Keys must match the category's attributeSchema"),
  pricePaise: z.number().int().min(0).nullable().default(null).describe("Unit price in integer paise (INR x 100)"),
  priceUnit: z.string().nullable().default(null),
  moq: z.number().int().min(1).nullable().default(null),
  moqUnit: z.string().nullable().default(null),
  hsn: z.string().nullable().default(null),
  language: z.string().default("en"),
  imageUrls: z.array(z.string()).default([]),
};

export const TOOLS: ToolDef[] = [
  tool({
    name: "search_products", scope: "search:read", title: "Search products", annotations: read,
    description:
      "Search published product listings. Results are ranked by relevance x seller trust (never by paid tier); `sponsored` is always false. Prices are integer paise in INR.",
    input: {
      q: z.string().max(500).describe("What the buyer needs, e.g. 'M8 stainless hex bolts'"),
      category: z.string().optional().describe("Category slug"),
      limit: z.number().int().min(1).max(50).default(10),
      inStock: z.boolean().optional().describe("Only listings in stock now (made-to-order excluded). A filter only: never affects ranking"),
      variant: z.string().max(400).optional().describe("Variant filter as comma-separated axis:value pairs, e.g. 'size:m,size:l,colour:red' (OR within an axis, AND across axes)"),
    },
    run: (_p, a) => ops.search(a),
  }),
  tool({
    name: "get_listing", scope: "catalogue:read", title: "Get listing", annotations: read,
    description: "Get one published, approved listing by id. Drafts, archived or unapproved listings are reported as not found.",
    input: { listingId: id("Listing id") },
    run: (_p, a) => ops.listing(a.listingId),
  }),
  tool({
    name: "list_categories", scope: "catalogue:read", title: "List categories", annotations: read,
    description: "List browsable categories with the attribute schema each listing can carry. Use the `slug` in other tools.",
    input: {},
    run: async () => ({ items: await ops.categories() }),
  }),
  tool({
    name: "get_seller_profile", scope: "catalogue:read", title: "Get seller trust profile", annotations: read,
    description: "Public trust profile of a seller business: verification tier, trust score, badge. Trust is earned, not bought.",
    input: { sellerId: id("Seller business id") },
    run: (_p, a) => ops.seller(a.sellerId),
  }),
  tool({
    name: "create_enquiry", scope: "enquiries:write", title: "Create enquiry (RFQ)", annotations: write(),
    description:
      "Post a buyer requirement. It is intent-scored and, if it passes, matched exclusively to at most N sellers (N is in `sellerCap`), ranked by relevance and trust. Low-intent enquiries are held for review; prohibited categories are rejected. Not idempotent: calling twice creates two enquiries. Money is in integer paise.",
    input: {
      title: z.string().min(5).max(140).optional().describe("Required unless `lines` is given"),
      requirement: z.string().min(10).max(4000).optional().describe("Specs, standards, certifications, delivery constraints. Required unless `lines` is given"),
      lines: z.array(z.object({
        itemName: z.string().min(1).max(140),
        spec: z.string().max(1000).optional(),
        quantity: z.number().int().positive(),
        unit: z.string().min(1).max(20),
        targetPricePaise: z.number().int().positive().optional().describe("Target unit price in paise"),
        categorySlug: z.string().optional(),
        hsn: z.string().optional().describe("4, 6 or 8 digit HSN"),
      })).min(1).max(50).optional().describe("Bill of materials: 1-50 lines for a multi-line RFQ. quantity/quantityUnit/targetPricePaise then mirror line 1"),
      categorySlug: z.string().optional(),
      quantity: z.number().int().positive().optional(),
      quantityUnit: z.string().max(20).optional(),
      targetPricePaise: z.number().int().positive().optional().describe("Target unit price in paise"),
      deliveryCity: z.string().max(80).optional(),
      deliveryPincode: z.string().regex(/^[1-9]\d{5}$/).optional(),
      neededBy: z.string().optional().describe("ISO date"),
      preferredListingId: z.string().optional().describe("Listing whose seller should be ranked first if eligible"),
    },
    run: (p, a) => ops.newEnquiry(p, { ...a, language: "en" }),
  }),
  tool({
    name: "list_my_enquiries", scope: "enquiries:read", title: "List my enquiries", annotations: read,
    description: "List the enquiries posted by the key's business, newest first, with their matches.",
    input: page,
    run: (p, a) => ops.myEnquiries(p, a.cursor, a.limit),
  }),
  tool({
    name: "get_enquiry", scope: "enquiries:read", title: "Get enquiry", annotations: read,
    description: "Get one enquiry of the key's business with match status and conversation ids.",
    input: { enquiryId: id("Enquiry id") },
    run: (p, a) => ops.enquiry(p, a.enquiryId),
  }),
  tool({
    name: "list_leads", scope: "leads:read", title: "List leads (seller)", annotations: read,
    description:
      "Seller: list enquiries offered to your business. Each lead is exclusive to at most N sellers and expires at `respondBy`. Buyer phone is revealed only after accept_lead.",
    input: page,
    run: (p, a) => ops.leads(p, a.cursor, a.limit),
  }),
  tool({
    name: "accept_lead", scope: "leads:write", title: "Accept lead (consumes 1 credit)", annotations: write({ idempotent: true }),
    description:
      "Seller: accept a lead. CONSUMES 1 LEAD CREDIT and opens a conversation with the buyer. Fails with an insufficient_credits error when the balance is 0 (check get_credit_balance first). Confirm with the human before calling. Re-accepting an already accepted lead does not charge twice.",
    input: { matchId: id("Lead match id from list_leads") },
    run: (p, a) => ops.acceptLeadOp(p, a.matchId),
  }),
  tool({
    name: "decline_lead", scope: "leads:write", title: "Decline lead", annotations: write({ idempotent: true }),
    description: "Seller: decline a lead for free. The lead is offered to the next-ranked seller.",
    input: { matchId: id("Lead match id"), reason: z.string().max(300).optional() },
    run: (p, a) => ops.declineLeadOp(p, a.matchId, a.reason),
  }),
  tool({
    name: "list_my_listings", scope: "listings:read", title: "List my listings (seller)", annotations: read,
    description: "Seller: list your own listings including drafts, with status and moderationStatus.",
    input: page,
    run: (p, a) => ops.myListings(p, a.cursor, a.limit),
  }),
  tool({
    name: "create_listing", scope: "listings:write", title: "Create draft listing (seller)", annotations: write(),
    description: "Seller: create a DRAFT listing (not visible to buyers). Use publish_listing to submit it for moderation. Prices in integer paise.",
    input: listingFields,
    run: (p, a) => ops.newListing(p, a),
  }),
  tool({
    name: "update_listing_stock", scope: "listings:write", title: "Update stock / availability (seller)", annotations: write({ idempotent: true }),
    description:
      "Seller: set availability (in_stock | made_to_order | out_of_stock), available quantity and lead time for a listing and/or its variants (matched by id or sku). Takes effect on a live listing immediately, without moderation. made_to_order needs leadTimeDays. Buyers who saved the listing are alerted when it comes back in stock.",
    input: {
      listingId: id("Listing id"),
      availability: z.enum(["in_stock", "made_to_order", "out_of_stock"]).optional(),
      availableQty: z.number().int().min(0).nullable().optional(),
      leadTimeDays: z.number().int().min(0).max(730).nullable().optional(),
      variants: z
        .array(z.object({ id: z.string().optional(), sku: z.string().optional(), availability: z.enum(["in_stock", "made_to_order", "out_of_stock"]).optional(), availableQty: z.number().int().min(0).nullable().optional(), leadTimeDays: z.number().int().min(0).max(730).nullable().optional() }))
        .max(100)
        .optional()
        .describe("Per-variant stock changes"),
    },
    run: (p, { listingId, ...u }) => ops.patchStock(p, listingId, u),
  }),
  tool({
    name: "set_listing_variants", scope: "listings:write", title: "Replace listing variants (seller)", annotations: write({ idempotent: true, destructive: true }),
    description:
      "Seller: replace the COMPLETE variant set (0-100) of a listing; variants not listed are deleted. Each variant needs a sku and a value for every variant axis of the listing's category (see list_categories attributeSchema.variantAxes) and may override pricePaise, priceTiers, moq and stock. Structure changes are reviewed when the listing is published; confirm with the human before deleting variants.",
    input: {
      listingId: id("Listing id"),
      variants: z
        .array(z.object({
          id: z.string().optional(), sku: z.string(), axisValues: z.record(z.string(), z.string()),
          pricePaise: z.number().int().min(0).nullable().optional(), priceTiers: z.array(z.object({ minQty: z.number().int().min(1), pricePaise: z.number().int().min(0) })).max(8).optional(),
          moq: z.number().int().min(1).nullable().optional(), availability: z.enum(["in_stock", "made_to_order", "out_of_stock"]).optional(),
          availableQty: z.number().int().min(0).nullable().optional(), leadTimeDays: z.number().int().min(0).max(730).nullable().optional(), imageId: z.string().nullable().optional(),
        }))
        .max(100),
    },
    run: (p, a) => ops.putVariants(p, a.listingId, a.variants),
  }),
  tool({
    name: "publish_listing", scope: "listings:write", title: "Publish listing (seller)", annotations: write({ idempotent: true }),
    description:
      "Seller: submit a draft listing for publication. It goes through automated + human moderation and is publicly visible only when moderationStatus is 'approved'; check the returned status.",
    input: { listingId: id("Listing id") },
    run: (p, a) => ops.publish(p, a.listingId),
  }),
  tool({
    name: "send_message", scope: "messages:write", title: "Send chat message", annotations: write(),
    description:
      "Send a message in a conversation you take part in (buyer or seller). Do not include contact details you have not been asked to share. Rate limited to 30 messages/minute. Confirm wording with the human first.",
    input: { conversationId: id("Conversation id"), body: z.string().min(1).max(4000) },
    run: (p, a) => ops.message(p, a.conversationId, a.body),
  }),
  tool({
    name: "send_quote", scope: "messages:write", title: "Send quote (seller)", annotations: write(),
    description: "Seller: send a price quote in a conversation. Only the seller side can quote. pricePaise is the UNIT price in integer paise. For a multi-line RFQ (enquiry.lines has more than one line) send `lines` instead: one entry per line you can supply (skip or mark cantSupply the rest); the server computes totals. A quote is a commercial offer; confirm terms with the human first.",
    input: {
      conversationId: id("Conversation id"),
      pricePaise: z.number().int().positive().optional().describe("Unit price in paise; not needed when `lines` is given"),
      quantity: z.number().int().positive().optional(),
      unit: z.string().min(1).max(20).optional(),
      gstIncluded: z.boolean().optional().describe("Unit prices already include GST"),
      lines: z.array(z.object({
        ordinal: z.number().int().positive().describe("1-based line number of the enquiry line"),
        unitPricePaise: z.number().int().positive().optional(),
        gstRatePct: z.number().int().min(0).max(40).optional(),
        leadTimeDays: z.number().int().min(0).max(730).optional(),
        cantSupply: z.boolean().optional(),
        notes: z.string().max(300).optional(),
      })).min(1).max(50).optional(),
      leadTimeDays: z.number().int().min(0).max(730).optional(),
      notes: z.string().max(2000).optional(),
      validUntil: z.string().optional().describe("ISO date"),
    },
    run: (p, { conversationId, ...q }) => ops.quote(p, conversationId, q),
  }),
  tool({
    name: "award_lines", scope: "enquiries:write", title: "Award RFQ lines to supplier quotes (buyer)", annotations: write(),
    description:
      "Buyer: award requirement lines of a multi-line RFQ to supplier quotes (the supplier's latest quote on get_enquiry's conversations). Lines can go to different suppliers; each supplier gets one order covering only its lines. A line can be awarded once. This records a won deal: confirm with the human first.",
    input: { enquiryId: id("Enquiry id"), awards: z.array(z.object({ enquiryLineId: id("Requirement line id"), quoteId: id("Quote id") })).min(1).max(50) },
    run: (p, a) => ops.awardEnquiryLines(p, a.enquiryId, a.awards),
  }),
  tool({
    name: "list_wishlists", scope: "wishlist:read", title: "List wishlists", annotations: read,
    description: "List the key owner's wishlists (named lists of saved products).",
    input: {},
    run: async (p) => ({ items: await ops.wishlists(p) }),
  }),
  tool({
    name: "add_to_wishlist", scope: "wishlist:write", title: "Add to wishlist", annotations: write({ idempotent: true }),
    description: "Save a published listing to a wishlist (get list ids from list_wishlists). Saving twice is a no-op.",
    input: { wishlistId: id("Wishlist id"), listingId: id("Listing id") },
    run: (p, a) => ops.wishlistAdd(p, a.wishlistId, a.listingId),
  }),
  tool({
    name: "list_reviews", scope: "reviews:read", title: "List listing reviews", annotations: read,
    description: "List approved reviews and the rating summary of a listing. Pending or rejected reviews are never shown.",
    input: { listingId: id("Listing id"), cursor: z.string().optional(), limit: z.number().int().min(1).max(50).default(10) },
    run: (_p, a) => ops.reviews(a.listingId, { cursor: a.cursor, limit: a.limit }),
  }),
  tool({
    name: "submit_review", scope: "reviews:write", title: "Submit review", annotations: write(),
    description:
      "Submit a review for a listing on behalf of the human. Reviews are MODERATED: the result has status 'pending' and it is not public until staff approve it. No phone numbers, emails or ID numbers in the text. Only submit what the human actually wrote or approved.",
    input: { listingId: id("Listing id"), rating: z.number().int().min(1).max(5), title: z.string().max(120).optional(), body: z.string().min(10).max(2000) },
    run: (p, { listingId, ...r }) => ops.review(p, listingId, { ...r, language: "en" }),
  }),
  tool({
    name: "get_credit_balance", scope: "billing:read", title: "Get lead-credit balance (seller)", annotations: read,
    description: "Seller: remaining lead credits and active plan. Each accepted lead consumes 1 credit.",
    input: {},
    run: (p) => ops.balance(p),
  }),
  ...AGENT_TOOLS,
];

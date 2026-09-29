import { z } from "@hono/zod-openapi";
import * as ops from "../../ops";
import { Balance, Id, Lead, ListingCreate, ListingPatch, Ok, SellerListing, pageOf, pageQuery } from "../../schemas";
import { api, body, json, router } from "../helpers";

export const sellerRoutes = router();
const SellerListingPage = pageOf("SellerListingPage", SellerListing);
const LeadPage = pageOf("LeadPage", Lead);
const MatchParam = z.object({ matchId: z.string().openapi({ format: "uuid" }) });
const sellerNote = "Requires a key bound to a seller business.";

sellerRoutes.openapi(
  api({
    scope: "listings:read",
    cfg: {
      method: "get", path: "/seller/listings", operationId: "listSellerListings", tags: ["Seller listings"], summary: "List your listings",
      description: `Includes drafts and archived listings, with moderation status. ${sellerNote}`,
      request: { query: z.object(pageQuery) },
      responses: { 200: json(SellerListingPage, "Page of listings") },
    },
  }),
  async (c) => {
    const q = c.req.valid("query");
    return c.json(await ops.myListings(c.get("principal"), q.cursor, q.limit), 200);
  },
);

sellerRoutes.openapi(
  api({
    scope: "listings:write", errors: [422],
    cfg: {
      method: "post", path: "/seller/listings", operationId: "createSellerListing", tags: ["Seller listings"], summary: "Create a draft listing",
      description: `Creates a **draft**; call the publish endpoint to submit it. Pass \`categorySlug\` or \`categoryId\`. ${sellerNote}`,
      request: { body: body(ListingCreate) },
      responses: { 201: json(SellerListing, "Draft listing") },
    },
  }),
  async (c) => c.json(await ops.newListing(c.get("principal"), c.req.valid("json")), 201),
);

sellerRoutes.openapi(
  api({
    scope: "listings:write", errors: [404, 422],
    cfg: {
      method: "patch", path: "/seller/listings/{id}", operationId: "updateSellerListing", tags: ["Seller listings"], summary: "Edit a listing",
      description: `Partial update of your own listing. Edits to a published listing are re-moderated. ${sellerNote}`,
      request: { params: Id, body: body(ListingPatch) },
      responses: { 200: json(SellerListing, "Updated listing") },
    },
  }),
  async (c) => c.json(await ops.patchListing(c.get("principal"), c.req.valid("param").id, c.req.valid("json")), 200),
);

sellerRoutes.openapi(
  api({
    scope: "listings:write", errors: [404, 409, 422],
    cfg: {
      method: "post", path: "/seller/listings/{id}/publish", operationId: "publishSellerListing", tags: ["Seller listings"], summary: "Publish a listing",
      description: `Submits the listing for automated + human moderation. It becomes publicly visible only when \`moderationStatus\` is \`approved\`. ${sellerNote}`,
      request: { params: Id },
      responses: { 200: json(SellerListing, "Listing with its moderation outcome") },
    },
  }),
  async (c) => c.json(await ops.publish(c.get("principal"), c.req.valid("param").id), 200),
);

sellerRoutes.openapi(
  api({
    scope: "listings:write", errors: [404],
    cfg: {
      method: "post", path: "/seller/listings/{id}/archive", operationId: "archiveSellerListing", tags: ["Seller listings"], summary: "Archive a listing",
      description: `Removes the listing from search. ${sellerNote}`,
      request: { params: Id },
      responses: { 200: json(Ok, "Archived") },
    },
  }),
  async (c) => c.json(await ops.archive(c.get("principal"), c.req.valid("param").id), 200),
);

sellerRoutes.openapi(
  api({
    scope: "leads:read",
    cfg: {
      method: "get", path: "/seller/leads", operationId: "listSellerLeads", tags: ["Seller leads"], summary: "List leads offered to you",
      description: `Each enquiry is intent-scored and offered exclusively to at most N sellers (ADR-002). Buyer contact details are revealed only after you accept. ${sellerNote}`,
      request: { query: z.object(pageQuery) },
      responses: { 200: json(LeadPage, "Page of leads") },
    },
  }),
  async (c) => {
    const q = c.req.valid("query");
    return c.json(await ops.leads(c.get("principal"), q.cursor, q.limit), 200);
  },
);

sellerRoutes.openapi(
  api({
    scope: "leads:write", errors: [402, 404, 409],
    cfg: {
      method: "post", path: "/seller/leads/{matchId}/accept", operationId: "acceptSellerLead", tags: ["Seller leads"], summary: "Accept a lead (consumes 1 credit)",
      description: `**Consumes 1 lead credit** from your balance and opens a conversation with the buyer. Fails with 402 when you have no credits; a lead that expired or was already answered returns 409. ${sellerNote}`,
      request: { params: MatchParam },
      responses: { 200: json(Lead, "Accepted lead, with buyer contact where consented") },
    },
  }),
  async (c) => c.json(await ops.acceptLeadOp(c.get("principal"), c.req.valid("param").matchId), 200),
);

sellerRoutes.openapi(
  api({
    scope: "leads:write", errors: [404, 409],
    cfg: {
      method: "post", path: "/seller/leads/{matchId}/decline", operationId: "declineSellerLead", tags: ["Seller leads"], summary: "Decline a lead",
      description: `Free. The lead cascades to the next-ranked seller. ${sellerNote}`,
      request: { params: MatchParam, body: { required: false, content: { "application/json": { schema: z.object({ reason: z.string().max(300).optional() }) } } } },
      responses: { 200: json(Ok, "Declined") },
    },
  }),
  async (c) => {
    const reason = (await c.req.json().catch(() => ({})) as { reason?: string }).reason;
    return c.json(await ops.declineLeadOp(c.get("principal"), c.req.valid("param").matchId, reason), 200);
  },
);

sellerRoutes.openapi(
  api({
    scope: "billing:read",
    cfg: {
      method: "get", path: "/seller/billing/balance", operationId: "getCreditBalance", tags: ["Seller billing"], summary: "Lead-credit balance",
      description: `Credits available to accept leads. ${sellerNote}`,
      responses: { 200: json(Balance, "Balance") },
    },
  }),
  async (c) => c.json(await ops.balance(c.get("principal")), 200),
);

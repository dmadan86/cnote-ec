import { z } from "@hono/zod-openapi";
import * as ops from "../../ops";
import { Category, FreightEstimate, Id, Listing, Me, SearchHit, TrustProfile } from "../../schemas";
import { api, json, router } from "../helpers";

export const catalogueRoutes = router();

catalogueRoutes.openapi(
  api({
    scope: "profile:read",
    cfg: {
      method: "get", path: "/me", operationId: "getMe", tags: ["Account"], summary: "Who am I",
      description: "Returns the key's owner, its scopes and the business the key is bound to (if any).",
      responses: { 200: json(Me, "Key principal") },
    },
  }),
  async (c) => c.json(await ops.me(c.get("principal")), 200),
);

catalogueRoutes.openapi(
  api({
    scope: "catalogue:read",
    cfg: {
      method: "get", path: "/categories", operationId: "listCategories", tags: ["Catalogue"], summary: "List categories",
      description: "All browsable categories with their attribute schema (use `slug` in search and listings).",
      responses: { 200: json(z.object({ items: z.array(Category) }), "Categories") },
    },
  }),
  async (c) => c.json({ items: await ops.categories() }, 200),
);

catalogueRoutes.openapi(
  api({
    scope: "catalogue:read", errors: [404],
    cfg: {
      method: "get", path: "/categories/{slug}", operationId: "getCategory", tags: ["Catalogue"], summary: "Get a category",
      request: { params: z.object({ slug: z.string().openapi({ example: "industrial-fasteners" }) }) },
      responses: { 200: json(Category, "Category") },
    },
  }),
  async (c) => c.json(await ops.category(c.req.valid("param").slug), 200),
);

catalogueRoutes.openapi(
  api({
    scope: "search:read", errors: [422],
    cfg: {
      method: "get", path: "/search", operationId: "searchListings", tags: ["Search"], summary: "Search listings",
      description:
        "Hybrid lexical + semantic search. Results are ranked by relevance x seller trust, never by paid tier (ADR-009); `sponsored` is always `false`. Only published, moderation-approved listings are returned.",
      request: {
        query: z.object({
          q: z.string().max(500).openapi({ example: "stainless steel hex bolts", description: "Free-text query (any supported language)." }),
          category: z.string().optional().openapi({ description: "Category slug filter." }),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
      },
      responses: { 200: json(z.object({ items: z.array(SearchHit) }), "Ranked hits") },
    },
  }),
  async (c) => c.json(await ops.search(c.req.valid("query")), 200),
);

catalogueRoutes.openapi(
  api({
    scope: "catalogue:read", errors: [404],
    cfg: {
      method: "get", path: "/listings/{id}", operationId: "getListing", tags: ["Catalogue"], summary: "Get a listing",
      description: "Only published and moderation-approved listings are visible; anything else is 404.",
      request: { params: Id },
      responses: { 200: json(Listing, "Listing") },
    },
  }),
  async (c) => c.json(await ops.listing(c.req.valid("param").id), 200),
);

catalogueRoutes.openapi(
  api({
    scope: "catalogue:read", errors: [404],
    cfg: {
      method: "get", path: "/sellers/{id}", operationId: "getSeller", tags: ["Catalogue"], summary: "Get a seller's public trust profile",
      description: "Verification tier, trust score and badge. Contact details are never exposed here.",
      request: { params: Id },
      responses: { 200: json(TrustProfile, "Trust profile") },
    },
  }),
  async (c) => c.json(await ops.seller(c.req.valid("param").id), 200),
);

catalogueRoutes.openapi(
  api({
    scope: "catalogue:read", errors: [404, 422, 429],
    cfg: {
      method: "get", path: "/listings/{id}/freight-estimate", operationId: "estimateListingFreight", tags: ["Catalogue"], summary: "Estimate freight for a listing",
      description:
        "ESTIMATE ONLY: a low-high freight range (before GST), shipping mode, transit days and the assumptions used, from the seller's pincode to the delivery pincode. The final freight is always quoted by the seller; the platform does not book or own logistics.",
      request: {
        params: Id,
        query: z.object({
          quantity: z.coerce.number().int().min(1).max(1_000_000_000).openapi({ example: 500, description: "Units (the listing's price unit)." }),
          pincode: z.string().regex(/^[1-9]\d{5}$/).openapi({ example: "400001", description: "6-digit delivery pincode." }),
        }),
      },
      responses: { 200: json(FreightEstimate, "Freight estimate") },
    },
  }),
  async (c) => {
    const q = c.req.valid("query");
    return c.json(await ops.listingFreightEstimate(c.get("principal"), c.req.valid("param").id, q.quantity, q.pincode), 200);
  },
);

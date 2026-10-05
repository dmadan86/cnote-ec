import { z } from "@hono/zod-openapi";
import * as ops from "../../ops";
import { Category, Facets, Id, Listing, Me, SearchHit, TrustProfile } from "../../schemas";
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
          in_stock: z.enum(["true", "false"]).optional().openapi({ description: "`true` = only listings that are in stock now (made-to-order does not count). A filter only: it never changes ranking." }),
          variant: z.string().max(400).optional().openapi({ example: "size:m,size:l,colour:red", description: "Variant filter as comma-separated `axis:value` pairs: OR within an axis, AND across axes, case-insensitive. Axes come from the category's `attributeSchema.variantAxes`." }),
        }),
      },
      responses: { 200: json(z.object({ items: z.array(SearchHit), facets: Facets.optional().openapi({ description: "Facet counts (incl. `variant` buckets) when the backend provides them." }) }), "Ranked hits") },
    },
  }),
  async (c) => {
    const { in_stock, ...q } = c.req.valid("query");
    return c.json(await ops.search({ ...q, inStock: in_stock === "true" }), 200);
  },
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

import { z } from "@hono/zod-openapi";
import * as ops from "../../ops";
import { Id, MyReview, ReviewCreate, ReviewList, WishlistAdd, WishlistDetail, WishlistSummary } from "../../schemas";
import { api, body, json, router } from "../helpers";

export const engagementRoutes = router();

engagementRoutes.openapi(
  api({
    scope: "wishlist:read",
    cfg: {
      method: "get", path: "/wishlists", operationId: "listWishlists", tags: ["Wishlist"], summary: "List your wishlists",
      description: "Named lists of saved products (one per project). Belongs to the key's person.",
      responses: { 200: json(z.object({ items: z.array(WishlistSummary) }), "Wishlists") },
    },
  }),
  async (c) => c.json({ items: await ops.wishlists(c.get("principal")) }, 200),
);

engagementRoutes.openapi(
  api({
    scope: "wishlist:read", errors: [404],
    cfg: {
      method: "get", path: "/wishlists/{id}", operationId: "getWishlist", tags: ["Wishlist"], summary: "Get a wishlist with items",
      request: { params: Id },
      responses: { 200: json(WishlistDetail, "Wishlist") },
    },
  }),
  async (c) => c.json(await ops.wishlist(c.get("principal"), c.req.valid("param").id), 200),
);

engagementRoutes.openapi(
  api({
    scope: "wishlist:write", errors: [404, 409, 422],
    cfg: {
      method: "post", path: "/wishlists/{id}/items", operationId: "addWishlistItem", tags: ["Wishlist"], summary: "Save a listing to a wishlist",
      description: "Idempotent: saving an already-saved listing returns `added: false`. Lists are capped in size.",
      request: { params: Id, body: body(WishlistAdd) },
      responses: { 201: json(z.object({ added: z.boolean(), listId: z.string() }), "Result") },
    },
  }),
  async (c) => c.json(await ops.wishlistAdd(c.get("principal"), c.req.valid("param").id, c.req.valid("json").listingId), 201),
);

engagementRoutes.openapi(
  api({
    scope: "wishlist:write", errors: [404],
    cfg: {
      method: "delete", path: "/wishlists/{id}/items/{listingId}", operationId: "removeWishlistItem", tags: ["Wishlist"], summary: "Remove a listing from a wishlist",
      request: { params: z.object({ id: z.string().openapi({ format: "uuid" }), listingId: z.string().openapi({ format: "uuid" }) }) },
      responses: { 200: json(z.object({ removed: z.boolean() }), "Result") },
    },
  }),
  async (c) => {
    const p = c.req.valid("param");
    return c.json(await ops.wishlistRemove(c.get("principal"), p.id, p.listingId), 200);
  },
);

engagementRoutes.openapi(
  api({
    scope: "reviews:read", errors: [404],
    cfg: {
      method: "get", path: "/listings/{id}/reviews", operationId: "listListingReviews", tags: ["Reviews"], summary: "List approved reviews",
      description: "Only moderation-approved reviews are returned; ratings count approved reviews only.",
      request: {
        params: Id,
        query: z.object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
          sort: z.enum(["recent", "helpful", "rating_high", "rating_low"]).default("recent"),
        }),
      },
      responses: { 200: json(ReviewList, "Reviews with rating summary") },
    },
  }),
  async (c) => c.json(await ops.reviews(c.req.valid("param").id, c.req.valid("query")), 200),
);

engagementRoutes.openapi(
  api({
    scope: "reviews:write", errors: [404, 409, 422],
    cfg: {
      method: "post", path: "/listings/{id}/reviews", operationId: "submitListingReview", tags: ["Reviews"], summary: "Submit a review (held for moderation)",
      description:
        "The review lands as `pending` and is **not public until staff approve it** (ADR-008 human-in-the-loop). Text containing phone numbers, emails or ID numbers is rejected. One review per person per listing (resubmitting edits it).",
      request: { params: Id, body: body(ReviewCreate) },
      responses: { 201: json(MyReview, "Your review and its moderation status") },
    },
  }),
  async (c) => c.json(await ops.review(c.get("principal"), c.req.valid("param").id, c.req.valid("json")), 201),
);

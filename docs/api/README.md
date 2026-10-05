# cnote public API

A versioned REST API (`/v1`) and an MCP server (`/mcp`) for external teams and AI agents (ADR-020 early access). Both use the same personal API keys and the same scopes. The service lives in `apps/api` (port 3003) and is deployed separately from the web apps.

- OpenAPI 3.1 spec: `GET {API_PUBLIC_URL}/openapi.json` (also committed at `docs/api/openapi.json`)
- Human-readable endpoint list: `GET {API_PUBLIC_URL}/docs`
- Health: `GET {API_PUBLIC_URL}/health` (Postgres + Redis)

## Run it

```bash
pnpm --filter @cnote/api dev        # http://localhost:3003
pnpm --filter @cnote/api test
pnpm --filter @cnote/api openapi    # regenerates docs/api/openapi.json
```

Env: `PORT` (3003), `API_PUBLIC_URL` (used in the spec and docs), `API_CORS_ORIGINS` (comma-separated allowlist; empty = no browser cross-origin access), `API_RATE_LIMIT_PER_MIN` (120), `SENTRY_DSN`, plus the usual `DATABASE_URL` / `REDIS_URL`.

## Authentication

Create a key in the web app under **Account > Developers** (buyer) or in the seller portal settings (seller; bind the key to your business). The secret (`ck_live_...`) is shown once. Send it as a bearer token:

```bash
curl -H "Authorization: Bearer $CNOTE_KEY" https://api.example.com/v1/me
```

Expiry options: 1 day, 7 days, 30 days, 90 days, 1 year, never. Revoked or expired keys stop working immediately. Buyer/seller endpoints require a key bound to a business; a key only ever acts as its own person and business.

Missing or invalid key: `401` with `WWW-Authenticate`. Missing scope: `403` naming the scope.

## Scopes

`:write` implies the matching `:read`.

| Scope | Grants |
|---|---|
| `profile:read` | Read the key owner's profile and business summary (GET /v1/me). |
| `catalogue:read` | Browse categories, published listings and seller trust profiles. |
| `search:read` | Search the catalogue (trust-ranked). |
| `listings:read` | Read your own listings, including drafts (seller keys). |
| `listings:write` | Create, edit, publish and archive your own listings (seller keys). |
| `enquiries:read` | Read your enquiries and their matches (buyer). |
| `enquiries:write` | Create enquiries (buyer). |
| `leads:read` | Read leads offered to your business (seller). |
| `leads:write` | Accept (consumes 1 credit) or decline leads (seller). |
| `messages:read` | Read conversations you take part in. |
| `messages:write` | Send messages and quotes, report deal outcomes. |
| `wishlist:read` | Read your wishlists. |
| `wishlist:write` | Add and remove wishlist items. |
| `reviews:read` | Read approved reviews. |
| `reviews:write` | Submit reviews (held for moderation). |
| `billing:read` | Read your lead-credit balance (seller). |

## Rate limits

`API_RATE_LIMIT_PER_MIN` requests per minute per key (default 120, REST and MCP combined). Over the limit: `429` with `Retry-After` (seconds). Some actions are stricter (chat messages: 30/min per person).

## Errors

```json
{ "error": { "code": "insufficient_scope", "message": "This API key lacks the required scope: leads:write.", "requestId": "…" } }
```

Codes: `unauthenticated` (401), `insufficient_scope` / `forbidden` (403), `not_found` (404), `conflict` (409), `insufficient_credits` (402), `validation` (422, with `issues: [{path, message}]`), `rate_limited` (429), `internal` (500). Quote `requestId` (also the `X-Request-Id` header) in support requests.

## Conventions

- Money is integer paise, with `currency: "INR"` on the object.
- Dates are ISO 8601.
- Long lists use cursor pagination: `?limit=25&cursor=…` (limit up to 100); repeat with `nextCursor` until it is `null`.
- Search ranks by relevance x seller trust and never by paid tier; `sponsored` is always `false` (ADR-009).
- Enquiries are intent-scored and matched exclusively to at most N sellers (ADR-002). Buyer contact is revealed only after a seller accepts.
- **Accepting a lead consumes 1 credit** (`402` when the balance is empty).
- Listings and reviews are moderated. Only published + approved listings are visible; a submitted review is `pending` and not public until staff approve it.

## Endpoints

| Method and path | Scope |
|---|---|
| `GET /v1/me` | profile:read |
| `GET /v1/categories`, `GET /v1/categories/{slug}` | catalogue:read |
| `GET /v1/search?q&category&limit&in_stock&variant` | search:read |
| `GET /v1/listings/{id}`, `GET /v1/sellers/{id}` | catalogue:read |
| `GET/POST /v1/seller/listings`, `PATCH /v1/seller/listings/{id}`, `POST …/{id}/publish`, `POST …/{id}/archive`, `PATCH …/{id}/stock`, `PUT …/{id}/variants` | listings:read / listings:write |
| `GET /v1/seller/leads` | leads:read |
| `POST /v1/seller/leads/{matchId}/accept` (1 credit), `…/decline` | leads:write |
| `GET /v1/seller/billing/balance` | billing:read |
| `POST /v1/enquiries` | enquiries:write |
| `GET /v1/enquiries`, `GET /v1/enquiries/{id}` | enquiries:read |
| `GET /v1/conversations/{id}` | messages:read |
| `POST /v1/conversations/{id}/messages`, `…/quotes` (seller), `POST /v1/matches/{matchId}/deal-report` | messages:write |
| `GET /v1/wishlists`, `GET /v1/wishlists/{id}` | wishlist:read |
| `POST /v1/wishlists/{id}/items`, `DELETE /v1/wishlists/{id}/items/{listingId}` | wishlist:write |
| `GET /v1/listings/{id}/reviews` | reviews:read |
| `POST /v1/listings/{id}/reviews` | reviews:write |

## Examples

```bash
export API=http://localhost:3003 CNOTE_KEY=ck_live_...

# Search
curl -s -H "Authorization: Bearer $CNOTE_KEY" "$API/v1/search?q=stainless%20steel%20bolts&limit=5"

# Post an enquiry (buyer key bound to a business)
curl -s -X POST "$API/v1/enquiries" -H "Authorization: Bearer $CNOTE_KEY" -H "Content-Type: application/json" \
  -d '{"title":"500 kg SS304 sheets","requirement":"Need 500 kg of 2mm SS304 sheets, MTC required.","categorySlug":"steel-sheets","quantity":500,"quantityUnit":"kg","deliveryPincode":"411001"}'

# Seller: leads, then accept one (consumes 1 credit)
curl -s -H "Authorization: Bearer $CNOTE_KEY" "$API/v1/seller/leads"
curl -s -X POST -H "Authorization: Bearer $CNOTE_KEY" "$API/v1/seller/leads/$MATCH_ID/accept"
```

## Import into Apidog

1. Apidog: **Import > OpenAPI/Swagger > URL** and enter `${API_PUBLIC_URL}/openapi.json` (or **File** and pick `docs/api/openapi.json`).
2. Create an environment variable `token` with your `ck_live_...` key and set the project's auth to **Bearer Token** = `{{token}}`.
3. Set the environment base URL to your API host (the spec's `servers` entry is `API_PUBLIC_URL`).

## MCP

Endpoint: `POST {API_PUBLIC_URL}/mcp` (Streamable HTTP, stateless, same bearer key). Only tools whose scope the key holds are listed.

Tools: `search_products`, `get_listing`, `list_categories`, `get_seller_profile` (catalogue/search), `create_enquiry`, `list_my_enquiries`, `get_enquiry`, `list_leads`, `accept_lead` (1 credit), `decline_lead`, `list_my_listings`, `create_listing`, `update_listing_stock`, `set_listing_variants`, `publish_listing`, `send_message`, `send_quote`, `list_wishlists`, `add_to_wishlist`, `list_reviews`, `submit_review` (moderated), `get_credit_balance`. Mutating tools carry `destructiveHint` / `idempotentHint` annotations; failures return `isError` with the domain message.

**Claude Code**

```bash
claude mcp add --transport http cnote http://localhost:3003/mcp --header "Authorization: Bearer ck_live_..."
```

**Claude Desktop / generic JSON config** (via the `mcp-remote` bridge)

```json
{
  "mcpServers": {
    "cnote": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3003/mcp", "--header", "Authorization: Bearer ck_live_..."]
    }
  }
}
```

Clients with native remote-HTTP support can use `{ "type": "http", "url": "…/mcp", "headers": { "Authorization": "Bearer ck_live_..." } }`.

**MCP Inspector**

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: http://localhost:3003/mcp
# Add header  Authorization: Bearer ck_live_...
```


## Stock, availability and variants

Every listing carries `availability` (`in_stock` | `made_to_order` | `out_of_stock`), `availableQty`, `stockUpdatedAt`, `variantAxes` and `variants` (0 to 100). `availability` is the best of the variants when there are any. Variant axes (size, colour, grade ...) are configured per category (`attributeSchema.variantAxes` on `GET /v1/categories`); a category without axes cannot have variants.

- `GET /v1/search?...&in_stock=true` keeps only listings that are in stock now (made-to-order does not count). `&variant=size:m,size:l,colour:red` filters on variant values (OR within an axis, AND across axes, case-insensitive). Both are filters only and never change ranking. The response includes `facets` (with `variant` buckets such as `size:m`) when the search backend provides them.
- `PATCH /v1/seller/listings/{id}/stock` (`listings:write`) sets availability, quantity and lead time for the listing and/or per variant (`variants[]`, matched by `id` or `sku`). Stock is operational: it takes effect on a live listing at once, without review. `made_to_order` needs `leadTimeDays`.
- `PUT /v1/seller/listings/{id}/variants` (`listings:write`) replaces the complete variant set. Variants are matched by `id`, else `sku`; unlisted ones are deleted. Structure changes are content and are moderated when the listing is published; stock fields in the payload take effect at once.
- Bulk CSV/XLSX: `availability`, `available_qty`, `lead_time_days` columns on product rows; variant rows have `variant_sku` filled, the product's `sku`, and one `variant:<axis>` column per axis (see the Instructions sheet of the template).

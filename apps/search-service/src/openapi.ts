// OpenAPI 3.1 for the read-only search query contract (ADR-009 + scale.md). Indexing is event-driven via the outbox and is
// deliberately not part of this API. Export: `pnpm --filter @cnote/search-service openapi` -> docs/design/search-service.openapi.json.
import { SEARCH_SERVICE_AUDIENCE } from "@cnote/search/remote";

const errorResponse = (description: string) => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });
const errors = { "401": errorResponse("Missing/invalid/expired service token or wrong audience"), "422": errorResponse("Invalid query"), "500": errorResponse("Internal error (retryable)"), "503": errorResponse("Overloaded (Retry-After set)") };

export function buildOpenApi(version = "1.0.0") {
  return {
    openapi: "3.1.0",
    info: { title: "cnote search service", version, description: "Read-only hybrid search (lexical + semantic, ranked by relevance x trust, never by paid tier). Every response carries `X-Request-Id`." },
    servers: [{ url: "http://search-service.internal:3006" }],
    security: [{ serviceToken: [] }],
    paths: {
      "/health": { get: { summary: "Liveness", security: [], responses: { "200": { description: "Process is up" } } } },
      "/ready": { get: { summary: "Readiness (Postgres and Redis reachable)", security: [], responses: { "200": { description: "Ready" }, "503": errorResponse("Not ready") } } },
      "/v1/search": {
        post: {
          operationId: "search", summary: "Search listings",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SearchRequest" } } } },
          responses: { "200": { description: "Ranked hits", content: { "application/json": { schema: { $ref: "#/components/schemas/SearchResponse" } } } }, ...errors },
        },
      },
      "/v1/suggest": {
        get: {
          operationId: "suggest", summary: "Query suggestions for a prefix",
          parameters: [
            { name: "prefix", in: "query", schema: { type: "string", maxLength: 200 } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 8 } },
          ],
          responses: { "200": { description: "Suggestions", content: { "application/json": { schema: { type: "object", required: ["suggestions"], properties: { suggestions: { type: "array", items: { type: "string" } } } } } } }, ...errors },
        },
      },
    },
    components: {
      securitySchemes: {
        serviceToken: {
          type: "http", scheme: "bearer", bearerFormat: "JWT",
          description: `HS256 JWT signed with SEARCH_SERVICE_TOKEN_SECRET. Claims: iss (caller), aud="${SEARCH_SERVICE_AUDIENCE}", iat, exp (<= 300s, default 60s), jti. Secret may be a comma list for rotation.`,
        },
      },
      schemas: {
        SearchRequest: {
          type: "object", required: ["q"],
          properties: { q: { type: "string", maxLength: 500 }, categorySlug: { type: "string", maxLength: 100 }, limit: { type: "integer", minimum: 1, maximum: 50, default: 20 }, cursor: { type: "string", maxLength: 200 },
            filters: {
              type: "object", description: "Buyer filters; every field optional. Places are case-insensitive. A parent category also matches its subcategories.",
              properties: {
                categories: { type: "array", items: { type: "string", maxLength: 100 }, maxItems: 10 },
                minTier: { type: "integer", minimum: 0, maximum: 3, description: "Minimum seller verification tier" },
                states: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 10 },
                cities: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 10 },
                priceMinPaise: { type: "integer", minimum: 0 }, priceMaxPaise: { type: "integer", minimum: 0 },
                maxMoq: { type: "integer", minimum: 1, description: "Listings with no stated MOQ always qualify" },
                hasPrice: { type: "boolean", description: "Exclude price-on-request listings" },
                inStockOnly: { type: "boolean", description: "Only listings that are in stock (made-to-order does not count). A filter, never a ranking signal." },
                variantOptions: { type: "object", additionalProperties: { type: "array", items: { type: "string", maxLength: 60 }, maxItems: 20 }, description: "Variant axis -> chosen values, e.g. { \"size\": [\"M\", \"L\"], \"colour\": [\"red\"] }. OR within an axis, AND across axes, case-insensitive; at most 6 axes." },
              },
            },
            sort: { type: "string", enum: ["relevance", "price_asc", "price_desc", "newest", "trust"], default: "relevance", description: "Organic sort. Never influenced by plan or ad spend." },
          },
        },
        SearchResponse: {
          type: "object", required: ["hits", "tookMs"],
          properties: {
            hits: { type: "array", items: { type: "object", description: "{ listing: ListingView, seller: TrustProfile, score: number, sponsored: false }" } },
            tookMs: { type: "integer" }, nextCursor: { type: ["string", "null"] }, facets: { type: "object" },
          },
        },
        Error: { type: "object", required: ["error"], properties: { error: { type: "object", required: ["code", "message", "requestId"], properties: { code: { type: "string" }, message: { type: "string" }, requestId: { type: "string" } } } } },
      },
    },
  };
}

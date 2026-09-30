// Remote search transport (ADR-018 pattern applied to search, ADR-009): read-only query API served by apps/search-service.
// SEARCH_TRANSPORT=http routes searchListings/suggest there; indexing stays event-driven via the outbox (indexer.ts) and is
// NOT exposed. On availability failures (breaker open, timeout, 5xx) callers answer in-process (SEARCH_REMOTE_FALLBACK=inproc,
// the default); 4xx always surface. The wire contract is docs/design/search-service.openapi.json.
import { ServiceClient, ServiceUnavailableError, type ServiceClientOptions } from "@cnote/ai/service-client";

export const SEARCH_SERVICE_AUDIENCE = "search-service";
export type SearchTransport = "inproc" | "http";

/** SEARCH_TRANSPORT=inproc (default) | http, read per call. */
export function searchTransport(env: NodeJS.ProcessEnv = process.env): SearchTransport {
  return env.SEARCH_TRANSPORT === "http" ? "http" : "inproc";
}
/** SEARCH_REMOTE_FALLBACK=inproc (default) | none. */
export function searchFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SEARCH_REMOTE_FALLBACK !== "none";
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export function searchServiceClientFromEnv(env: NodeJS.ProcessEnv = process.env, extra: Partial<ServiceClientOptions> = {}): ServiceClient {
  const baseUrl = env.SEARCH_SERVICE_URL;
  const secret = env.SEARCH_SERVICE_TOKEN_SECRET;
  if (!baseUrl || !secret) throw new Error("SEARCH_TRANSPORT=http requires SEARCH_SERVICE_URL and SEARCH_SERVICE_TOKEN_SECRET");
  return new ServiceClient({
    name: "search-service", baseUrl, secret, audience: SEARCH_SERVICE_AUDIENCE, issuer: env.SERVICE_NAME || "cnote",
    // search is on the interactive path (ADR-009 target < 2s): short timeout, one quick retry
    timeoutMs: num(env.SEARCH_SERVICE_TIMEOUT_MS, 2500), retries: num(env.SEARCH_SERVICE_RETRIES, 1), backoffMs: num(env.SEARCH_SERVICE_BACKOFF_MS, 50),
    ...extra,
  });
}

let shared: ServiceClient | null = null;
/** One client (one circuit breaker) per process. */
export function sharedSearchServiceClient(): ServiceClient {
  return (shared ??= searchServiceClientFromEnv());
}
export function resetSharedSearchServiceClientForTests() { shared = null; }

async function withFallback<T>(call: () => Promise<T>, local: (() => Promise<T>) | null, what: string): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!local || !(err instanceof ServiceUnavailableError)) throw err;
    console.warn(`[search] search-service unavailable for ${what} (${err.message}); answering in-process`);
    return local();
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** POST /v1/search. Read-only and cacheable, so always retry-safe. */
export function remoteSearch<R extends { hits: unknown[] }>(client: ServiceClient, opts: object, local: (() => Promise<R>) | null): Promise<R> {
  return withFallback(async () => {
    const { data } = await client.request<R>("POST", "/v1/search", opts, { retry: true });
    if (!isObject(data) || !Array.isArray(data.hits)) throw new ServiceUnavailableError("search-service /v1/search: malformed body");
    return data;
  }, local, "search");
}

/** GET /v1/suggest?prefix=&limit= */
export function remoteSuggest(client: ServiceClient, prefix: string, limit: number, local: (() => Promise<string[]>) | null): Promise<string[]> {
  return withFallback(async () => {
    const { data } = await client.request<{ suggestions: string[] }>("GET", `/v1/suggest?prefix=${encodeURIComponent(prefix)}&limit=${limit}`, undefined, { retry: true });
    if (!isObject(data) || !Array.isArray(data.suggestions)) throw new ServiceUnavailableError("search-service /v1/suggest: malformed body");
    return data.suggestions;
  }, local, "suggest");
}

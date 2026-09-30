import { randomUUID } from "node:crypto";
import { verifyServiceToken } from "@cnote/ai/service-client";
import { DomainError, HTTP_STATUS } from "@cnote/core";
import { searchListings, suggest } from "@cnote/search";
import { SEARCH_SERVICE_AUDIENCE, searchTransport } from "@cnote/search/remote";
import { Hono } from "hono";
import { ZodError } from "zod";
import { loadConfig, type SearchServiceConfig } from "./env";
import { buildOpenApi } from "./openapi";

type Vars = { requestId: string; caller: string };

export interface AppDeps {
  config?: SearchServiceConfig;
  search?: typeof searchListings;
  suggest?: typeof suggest;
  /** dependency probes for /ready; each resolves when the dependency answers */
  probes?: Record<string, () => Promise<unknown>>;
  now?: () => number;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

const err = (code: string, message: string, requestId: string) => ({ error: { code, message, requestId } });

export function createApp(deps: AppDeps = {}) {
  const env = deps.env ?? process.env;
  const config = deps.config ?? loadConfig(env);
  // The service IS the in-process implementation. With SEARCH_TRANSPORT=http it would call itself forever.
  if (searchTransport(env) === "http") throw new Error("search-service must run with SEARCH_TRANSPORT=inproc (it would call itself)");
  const doSearch = deps.search ?? searchListings;
  const doSuggest = deps.suggest ?? suggest;
  const probes = deps.probes ?? {};
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l: string) => console.log(l));
  let inflight = 0;

  const app = new Hono<{ Variables: Vars }>();

  app.use("*", async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const id = incoming && /^[\w.-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    c.set("requestId", id);
    c.header("X-Request-Id", id);
    const started = now();
    await next();
    log(JSON.stringify({ svc: "search-service", requestId: id, caller: c.get("caller") ?? null, method: c.req.method, path: c.req.path, status: c.res.status, ms: now() - started }));
  });

  app.onError((e, c) => {
    const requestId = c.get("requestId");
    if (e instanceof ZodError) return c.json(err("validation", e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), requestId), 422);
    if (e instanceof DomainError) return c.json(err(e.code, e.message, requestId), (HTTP_STATUS[e.code] ?? 422) as 422);
    console.error(`[search-service] ${requestId} failed:`, e);
    return c.json(err("internal", "Internal error", requestId), 500);
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/ready", async (c) => {
    const problems: string[] = [];
    if (!config.tokenSecret) problems.push("SEARCH_SERVICE_TOKEN_SECRET not set");
    if (inflight >= config.maxInflight) problems.push("shedding load");
    await Promise.all(Object.entries(probes).map(async ([name, probe]) => {
      try {
        await probe();
      } catch {
        problems.push(`${name} unreachable`);
      }
    }));
    return problems.length ? c.json({ status: "not_ready", problems }, 503) : c.json({ status: "ready", backend: env.SEARCH_BACKEND || "postgres" });
  });

  app.get("/openapi.json", (c) => c.json(buildOpenApi()));

  app.use("/v1/*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const v = config.tokenSecret && token
      ? verifyServiceToken(token, { secret: config.tokenSecret, audience: SEARCH_SERVICE_AUDIENCE, nowMs: now() })
      : ({ ok: false, reason: "malformed" } as const);
    if (!v.ok) {
      c.header("WWW-Authenticate", `Bearer error="invalid_token", error_description="${v.reason}"`);
      return c.json(err("unauthorized", `Invalid service token (${v.reason})`, c.get("requestId")), 401);
    }
    c.set("caller", v.claims.iss);
    await next();
  });

  app.use("/v1/*", async (c, next) => {
    if (inflight >= config.maxInflight) {
      c.header("Retry-After", "1");
      return c.json(err("overloaded", "Service is shedding load", c.get("requestId")), 503);
    }
    inflight++;
    try {
      await next();
    } finally {
      inflight--;
    }
  });

  app.post("/v1/search", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json(err("validation", "Body must be a JSON object", c.get("requestId")), 422);
    // searchListings validates q/limit/cursor with zod (ZodError -> 422 above).
    return c.json(await doSearch(body as Parameters<typeof searchListings>[0]));
  });

  app.get("/v1/suggest", async (c) => {
    const limit = c.req.query("limit");
    return c.json({ suggestions: await doSuggest((c.req.query("prefix") ?? "").slice(0, 200), limit ? Number(limit) || 8 : 8) });
  });

  app.notFound((c) => c.json(err("not_found", "Not found", c.get("requestId")), 404));
  return app;
}

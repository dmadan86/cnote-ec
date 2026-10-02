import { randomUUID } from "node:crypto";
import { verifyServiceToken } from "@cnote/ai/service-client";
import { AI_CAPABILITIES, AI_SERVICE_AUDIENCE, aiTransport, type AiCapabilityName } from "@cnote/ai/remote";
import { decodeWire, encodeWire } from "@cnote/ai/service-client";
import { DomainError, HTTP_STATUS } from "@cnote/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { CAPABILITY_NAMES, inProcessHandlers, type CapabilityHandlers } from "./capabilities";
import { loadConfig, type AiServiceConfig } from "./env";
import { buildOpenApi } from "./openapi";

type Vars = { requestId: string; caller: string };

export interface AppDeps {
  config?: AiServiceConfig;
  handlers?: CapabilityHandlers;
  now?: () => number;
  /** one JSON line per request; never contains inputs or outputs (they may hold personal data, ADR-010) */
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

const err = (code: string, message: string, requestId: string) => ({ error: { code, message, requestId } });

export function createApp(deps: AppDeps = {}) {
  const env = deps.env ?? process.env;
  const config = deps.config ?? loadConfig(env);
  // The service IS the in-process implementation. With AI_TRANSPORT=http it would call itself forever.
  if (aiTransport(env) === "http") throw new Error("ai-service must run with AI_TRANSPORT=inproc (it would call itself)");
  const handlers = deps.handlers ?? inProcessHandlers();
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
    log(JSON.stringify({ svc: "ai-service", requestId: id, caller: c.get("caller") ?? null, method: c.req.method, path: c.req.path, status: c.res.status, ms: now() - started }));
  });

  app.onError((e, c) => {
    const requestId = c.get("requestId");
    if (e instanceof DomainError) return c.json(err(e.code, e.message, requestId), (HTTP_STATUS[e.code] ?? 422) as 422, {});
    console.error(`[ai-service] ${requestId} handler failed:`, e);
    return c.json(err("internal", "Internal error", requestId), 500);
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  // Readiness answers only a status to anonymous callers (orchestrator probes use the status code): the list of configuration problems
  // reveals which providers/keys are (not) configured, so it is returned only to a caller holding a valid service token (security audit).
  app.get("/ready", (c) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const privileged = !!config.tokenSecret && !!token && verifyServiceToken(token, { secret: config.tokenSecret, audience: AI_SERVICE_AUDIENCE, nowMs: now() }).ok;
    const problems: string[] = [];
    if (!config.tokenSecret) problems.push("AI_SERVICE_TOKEN_SECRET not set");
    if (env.AI_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) problems.push("AI_PROVIDER=anthropic but ANTHROPIC_API_KEY not set");
    if (env.ASR_PROVIDER === "sarvam" && !env.SARVAM_API_KEY) problems.push("ASR_PROVIDER=sarvam but SARVAM_API_KEY not set");
    if (inflight >= config.maxInflight) problems.push("shedding load");
    if (problems.length) return c.json(privileged ? { status: "not_ready", problems } : { status: "not_ready" }, 503);
    return c.json(privileged ? { status: "ready", provider: env.AI_PROVIDER || "heuristic", asr: env.ASR_PROVIDER || "mock", capabilities: CAPABILITY_NAMES.length } : { status: "ready" });
  });

  app.get("/openapi.json", (c) => c.json(buildOpenApi()));

  app.use("/v1/*", bodyLimit({ maxSize: config.maxBodyBytes, onError: (c) => c.json(err("payload_too_large", "Request body too large", c.get("requestId")), 413) }));

  app.use("/v1/*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const v = config.tokenSecret && token
      ? verifyServiceToken(token, { secret: config.tokenSecret, audience: AI_SERVICE_AUDIENCE, nowMs: now() })
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

  for (const name of CAPABILITY_NAMES) {
    app.post(AI_CAPABILITIES[name as AiCapabilityName].path, async (c) => {
      const body = (await c.req.json().catch(() => null)) as { input?: unknown } | null;
      const raw = body?.input;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return c.json(err("validation", "Body must be { input: object }", c.get("requestId")), 422);
      const input = decodeWire(raw) as Record<string, unknown>;
      if (name === "embed") {
        const texts = input.texts;
        if (!Array.isArray(texts) || texts.length === 0 || texts.length > 256 || texts.some((t) => typeof t !== "string" || t.length > 20_000)) {
          return c.json(err("validation", "embed expects { texts: string[1..256] } with each text <= 20000 chars", c.get("requestId")), 422);
        }
      }
      return c.json(encodeWire(await handlers[name as AiCapabilityName](input)) as object);
    });
  }

  app.notFound((c) => c.json(err("not_found", "Not found", c.get("requestId")), 404));
  return app;
}

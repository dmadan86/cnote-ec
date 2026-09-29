import { createRoute, OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import type { Hook } from "@hono/zod-openapi";
import type { Scope } from "@cnote/developer";
import { ErrorEnvelope } from "../schemas";
import { zodIssues } from "../lib/errors";
import { requireScope } from "../middleware/auth";
import type { AppEnv } from "../types";

export const validationHook: Hook<unknown, AppEnv, string, unknown> = (result, c) => {
  if (!result.success) {
    return c.json(
      { error: { code: "validation", message: "Request validation failed", requestId: c.get("requestId"), issues: zodIssues(result.error) } },
      422,
    );
  }
};

export const router = () => new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

const errorDescriptions = {
  401: "Missing, invalid, expired or revoked API key.",
  402: "Insufficient lead credits.",
  403: "The key lacks the required scope, or the key is not bound to a business.",
  404: "Resource not found (or not visible to this key).",
  409: "Conflict with the current state of the resource.",
  422: "Validation failed. `error.issues` lists the offending fields.",
  429: "Rate limit exceeded. Honour the `Retry-After` header.",
} as const;
type ErrStatus = keyof typeof errorDescriptions;

interface ApiRouteConfig<R extends Omit<RouteConfig, "security" | "middleware">> {
  cfg: R;
  scope: Scope | null;
  errors?: ErrStatus[];
}

/** createRoute + bearer security, x-required-scope, scope guard and standard error responses. */
export function api<const R extends Omit<RouteConfig, "security" | "middleware">>({ cfg, scope, errors = [] }: ApiRouteConfig<R>) {
  const codes = [...new Set<ErrStatus>([401, 403, 429, ...errors])];
  const errorResponses = Object.fromEntries(
    codes.map((s) => [s, { description: errorDescriptions[s], content: { "application/json": { schema: ErrorEnvelope } } }]),
  );
  const description = [cfg.description, scope ? `**Required scope:** \`${scope}\`` : "**Required scope:** none (any valid key)"].filter(Boolean).join("\n\n");
  return createRoute({
    ...cfg,
    description,
    security: [{ bearerAuth: [] }],
    middleware: scope ? [requireScope(scope)] : undefined,
    responses: { ...cfg.responses, ...errorResponses },
    ...({ "x-required-scope": scope ?? "none" } as object),
  } as R & { security: [{ bearerAuth: [] }] });
}

export const json = <T extends import("zod").ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
export const body = <T extends import("zod").ZodType>(schema: T) => ({ required: true as const, content: { "application/json": { schema } } });

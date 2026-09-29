import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const id = incoming && /^[\w.-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
};

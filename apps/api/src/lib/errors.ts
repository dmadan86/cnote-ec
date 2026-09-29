import { DomainError, HTTP_STATUS } from "@cnote/core";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";

export type ErrorStatus = 400 | 401 | 402 | 403 | 404 | 405 | 409 | 422 | 429 | 500;

export interface ErrorBody {
  error: { code: string; message: string; requestId: string; issues?: { path: string; message: string }[]; details?: unknown };
}

/** API-level codes beyond core's ErrorCode. */
export class ApiError extends Error {
  constructor(
    public readonly status: ErrorStatus,
    public readonly code: string,
    message: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function zodIssues(err: ZodError) {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** Postgres rejected a malformed id (22P02 on a uuid column): the resource cannot exist, so it is a 404, not a 500. */
export function isMalformedIdError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown; driverAdapterError?: { message?: unknown } };
  if (e.code === "P2023") return true;
  return [e.message, e.driverAdapterError?.message].some((m) => typeof m === "string" && m.includes("invalid input syntax for type uuid"));
}

/** Normalises anything thrown into a status + envelope. */
export function toErrorResponse(err: unknown, requestId: string): { status: ErrorStatus; body: ErrorBody; headers: Record<string, string> } {
  if (err instanceof ApiError) {
    return { status: err.status, headers: err.headers, body: { error: { code: err.code, message: err.message, requestId } } };
  }
  if (err instanceof DomainError) {
    const status = (HTTP_STATUS[err.code] ?? 500) as ErrorStatus;
    const headers: Record<string, string> = {};
    if (err.code === "rate_limited") {
      const d = err.details as { retryAfterSeconds?: number } | undefined;
      headers["Retry-After"] = String(d?.retryAfterSeconds ?? 30);
    }
    return { status, headers, body: { error: { code: err.code, message: err.message, requestId } } };
  }
  if (err instanceof ZodError) {
    return { status: 422, headers: {}, body: { error: { code: "validation", message: err.issues[0]?.message ?? "Invalid input", requestId, issues: zodIssues(err) } } };
  }
  if (err instanceof HTTPException && err.status >= 400 && err.status < 500) {
    // e.g. malformed JSON body (400): a client error, not a server fault.
    const status = ([400, 401, 403, 404, 405, 409, 422, 429] as number[]).includes(err.status) ? (err.status as ErrorStatus) : 400;
    return { status, headers: {}, body: { error: { code: "invalid_request", message: err.message, requestId } } };
  }
  if (isMalformedIdError(err)) return { status: 404, headers: {}, body: { error: { code: "not_found", message: "Resource not found", requestId } } };
  return { status: 500, headers: {}, body: { error: { code: "internal", message: "Internal server error", requestId } } };
}

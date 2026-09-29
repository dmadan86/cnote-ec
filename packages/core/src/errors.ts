export type ErrorCode = "not_found" | "forbidden" | "unauthenticated" | "validation" | "conflict" | "insufficient_credits" | "rate_limited";

/** Expected, user-facing failure. Route handlers map `code` to an HTTP status. */
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const HTTP_STATUS: Record<ErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  unauthenticated: 401,
  validation: 422,
  conflict: 409,
  insufficient_credits: 402,
  rate_limited: 429,
};

export type ErrorCode = "not_found" | "forbidden" | "unauthenticated" | "validation" | "conflict" | "insufficient_credits" | "rate_limited";

/** Placeholder values for a translated error message. */
export type ErrorParams = Record<string, string | number>;

/** Expected, user-facing failure. Route handlers map `code` to an HTTP status. */
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    /** Optional stable message key (e.g. "credits.insufficient") apps translate; `message` stays the English fallback. */
    public readonly key?: string,
    /** Optional ICU placeholder values for the translated `key` message (e.g. `{ max: 5 }`); the English `message` already has them interpolated. */
    public readonly params?: ErrorParams,
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

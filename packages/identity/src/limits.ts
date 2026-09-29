import { DomainError, rateLimit } from "@cnote/core";

/** Fixed-window limit that throws DomainError("rate_limited") instead of returning false. */
export async function enforceLimit(key: string, limit: number, windowSeconds: number, what = "Too many attempts. Please try again later."): Promise<void> {
  if (!(await rateLimit(key, limit, windowSeconds))) throw new DomainError("rate_limited", what);
}

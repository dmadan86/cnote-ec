import { DomainError, HTTP_STATUS } from "@cnote/core";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { errorKeyFor, FIELD_ERRORS_KEY } from "./error-catalogue";

/** Server-action return shape. Actions return this instead of throwing for expected failures. */
export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string; /** stable message key (see error-catalogue.ts); apps translate it, `error` is the English fallback */ errorKey?: string; fieldErrors?: Record<string, string> };

export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof DomainError) {
      const errorKey = errorKeyFor(err);
      return errorKey ? { ok: false, error: err.message, errorKey } : { ok: false, error: err.message };
    }
    if (err instanceof ZodError) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of err.issues) fieldErrors[issue.path.join(".")] ??= issue.message;
      return { ok: false, error: "Please fix the highlighted fields.", errorKey: FIELD_ERRORS_KEY, fieldErrors };
    }
    throw err;
  }
}

/** Route-handler error mapping. */
export function errorResponse(err: unknown) {
  if (err instanceof DomainError) {
    const key = errorKeyFor(err);
    return NextResponse.json({ error: err.message, code: err.code, ...(key ? { key } : {}) }, { status: HTTP_STATUS[err.code] });
  }
  if (err instanceof ZodError) return NextResponse.json({ error: "validation", issues: err.issues }, { status: 422 });
  console.error(err);
  return NextResponse.json({ error: "internal" }, { status: 500 });
}

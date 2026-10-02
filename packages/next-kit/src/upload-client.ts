// Client side of file uploads: lets a `useActionState` form keep its action signature while file-bearing submissions go to a route handler
// (see upload.ts for why). Plain browser code, no server imports.
import type { ActionResult } from "./action-result";

/** True when the form carries at least one non-empty file (an empty file input submits one zero-byte entry). */
export function hasFileEntries(fd: FormData): boolean {
  for (const v of fd.values()) if (typeof v !== "string" && v.size > 0) return true;
  return false;
}

interface RouteBody<T> {
  ok?: boolean;
  data?: T;
  redirect?: string;
  error?: string;
  code?: string;
  key?: string;
  params?: Record<string, string | number>;
  fieldErrors?: Record<string, string>;
  issues?: { path?: (string | number)[]; message?: string }[];
}

/**
 * POSTs the form to a route handler that answers `{ ok: true, data, redirect? }` or an `errorResponse()` body, and returns the
 * `ActionResult` a server action would have. `redirect` navigates after success. A 401 (the 15-minute access token expired while the user
 * filled the form) triggers one call to `refreshUrl` (a route that refreshes the session cookies) and a retry.
 */
export async function submitFormAsAction<T>(url: string, fd: FormData, opts: { refreshUrl?: string } = {}): Promise<ActionResult<T>> {
  const send = () => fetch(url, { method: "POST", body: fd, credentials: "same-origin" });
  let res: Response;
  try {
    res = await send();
    if (res.status === 401 && opts.refreshUrl) {
      await fetch(opts.refreshUrl, { credentials: "same-origin" }).catch(() => undefined);
      res = await send();
    }
  } catch {
    return { ok: false, error: "Network error. Check your connection and try again." };
  }
  const body = (await res.json().catch(() => ({}))) as RouteBody<T>;
  if (res.ok && body.ok) {
    if (body.redirect && typeof window !== "undefined") window.location.assign(body.redirect);
    return { ok: true, data: body.data as T };
  }
  if (body.issues?.length) {
    const fieldErrors: Record<string, string> = {};
    for (const i of body.issues) fieldErrors[String(i.path?.[0] ?? "")] ||= i.message ?? "Invalid value";
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors };
  }
  const message = body.error && body.error !== "internal" ? body.error : res.status === 413 ? "The upload is too large." : "Something went wrong. Please try again.";
  return {
    ok: false,
    error: message,
    ...(body.key ? { errorKey: body.key } : {}),
    ...(body.key && body.params ? { errorParams: body.params } : {}),
    ...(body.fieldErrors ? { fieldErrors: body.fieldErrors } : {}),
  };
}

import "server-only";
import { unstable_rethrow } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { runAction, type ActionResult } from "@cnote/next-kit";

/** Replaces a failed result's English `error` with the seller's language when its stable key is in the `errors` catalogue. */
export async function localizeResult<T>(result: ActionResult<T>): Promise<ActionResult<T>> {
  if (result.ok || !result.errorKey) return result;
  try {
    const t = await getTranslations("errors");
    if (t.has(result.errorKey)) return { ...result, error: t(result.errorKey, result.errorParams) };
  } catch {
    // catalogue unavailable: the English message stays
  }
  return result;
}

/**
 * runAction (DomainError/ZodError -> ActionResult, message translated by error key) plus a last-resort catch so a
 * not-yet-available dependency or transient failure shows an inline message rather than a crashed page.
 */
export async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return await localizeResult(await runAction(fn));
  } catch (err) {
    unstable_rethrow(err);
    console.error("[seller] action failed", err);
    let error = "Something went wrong on our side. Please try again in a moment.";
    try {
      error = (await getTranslations("common"))("error");
    } catch {
      // translation loading itself failed: keep the English fallback
    }
    return { ok: false, error };
  }
}

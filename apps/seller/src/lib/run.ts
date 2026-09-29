import "server-only";
import { unstable_rethrow } from "next/navigation";
import { runAction, type ActionResult } from "@cnote/next-kit";

/**
 * runAction (DomainError/ZodError -> ActionResult) plus a last-resort catch so a not-yet-available
 * dependency or transient failure shows an inline message rather than a crashed page.
 */
export async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return await runAction(fn);
  } catch (err) {
    unstable_rethrow(err);
    console.error("[seller] action failed", err);
    return { ok: false, error: "Something went wrong on our side. Please try again in a moment." };
  }
}

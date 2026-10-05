import "server-only";
import type { ActionResult } from "@cnote/next-kit";
import { getTranslations } from "next-intl/server";
import { getRequestLocale } from "@/lib/request-locale";
import { APPROVAL_ERROR_KEYS } from "./error-keys";

/** Swaps a failed result's English message for the buyer's language when it is one of the team/approval messages. */
export async function localizeApprovalError<T>(r: ActionResult<T>): Promise<ActionResult<T>> {
  if (r.ok) return r;
  const key = APPROVAL_ERROR_KEYS[r.error];
  if (!key) return r;
  try {
    const t = await getTranslations({ locale: await getRequestLocale(), namespace: "approvals" });
    if (t.has(`errors.${key}`)) return { ...r, error: t(`errors.${key}`) };
  } catch {
    /* keep the English message */
  }
  return r;
}

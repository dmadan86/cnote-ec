import "server-only";
import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@cnote/next-kit";
import { DEFAULT_LOCALE, isLocale } from "./config";

/**
 * Server-side: swaps a failed action result's English `error` for the buyer's language when its stable error key
 * (packages/next-kit error-catalogue, `errors.*` namespace) has a translation. Successes and unknown keys pass through.
 * Server actions on unprefixed routes have no locale in scope: pass the page's locale (defaults to English).
 */
export async function localizeActionResult<T>(result: ActionResult<T>, locale: string = DEFAULT_LOCALE): Promise<ActionResult<T>> {
  if (result.ok || !result.errorKey) return result;
  try {
    const t = await getTranslations({ locale: isLocale(locale) ? locale : DEFAULT_LOCALE, namespace: "errors" });
    if (t.has(result.errorKey)) return { ...result, error: t(result.errorKey) };
  } catch {
    // catalogue unavailable: keep the English message
  }
  return result;
}

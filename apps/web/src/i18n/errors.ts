import "server-only";
import { getTranslations } from "next-intl/server";
import { runAction, type ActionResult } from "@cnote/next-kit";
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
    if (t.has(result.errorKey)) return { ...result, error: t(result.errorKey, result.errorParams) };
  } catch {
    // catalogue unavailable: keep the English message
  }
  return result;
}

/**
 * `runAction` whose failure message is already in the buyer's language (by stable error key). Server actions on
 * unprefixed routes have no locale argument: the request's language (lib/request-locale.ts) is used, falling back to English.
 */
export async function runLocalized<T>(fn: () => Promise<T>, locale?: string): Promise<ActionResult<T>> {
  const result = await runAction(fn);
  if (result.ok || !result.errorKey) return result;
  let current = locale;
  if (!current) {
    try {
      // Server actions run outside any layout: resolve the buyer's language from the request (cookie, profile, Accept-Language).
      current = await (await import("@/lib/request-locale")).getRequestLocale();
    } catch {
      current = DEFAULT_LOCALE;
    }
  }
  return localizeActionResult(result, current);
}

import { getTranslations } from "next-intl/server";
import { isLocale, LOCALE_META, type Locale } from "@/i18n/config";
import { A2A_KEYS, type A2aLabels } from "./labels";

export function resolveLocale(given?: string | null): Locale {
  return given && isLocale(given) ? given : "en";
}

/** Raw catalogue strings for the `a2a` namespace in the buyer's language (English fills any gap). */
export async function loadA2aLabels(given?: string | null): Promise<{ t: A2aLabels; locale: Locale; bcp47: string }> {
  const locale = resolveLocale(given);
  const tr = await getTranslations({ locale, namespace: "a2a" });
  const t = Object.fromEntries(A2A_KEYS.map((k) => [k, tr.raw(k) as string])) as A2aLabels;
  return { t, locale, bcp47: LOCALE_META[locale].bcp47 };
}

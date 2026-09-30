import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE } from "./config";
import { loadMessages } from "./messages";

/** Locale = the seller's choice (cookie set by the language switcher / onboarding), else English. */
export async function currentLocale() {
  const v = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(v) ? v : DEFAULT_LOCALE;
}

export default getRequestConfig(async () => {
  const locale = await currentLocale();
  return { locale, messages: await loadMessages(locale), timeZone: "Asia/Kolkata" };
});

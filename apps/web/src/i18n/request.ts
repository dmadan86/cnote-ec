import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE, isLocale } from "./config";
import { loadMessages } from "./messages";

// Every server-side call passes the locale explicitly (getTranslations({ locale, namespace })), so nothing here reads
// headers/cookies and public pages stay statically generated. The fallback is only for stray calls.
export default getRequestConfig(async ({ locale }) => {
  const l = isLocale(locale) ? locale : DEFAULT_LOCALE;
  return { locale: l, messages: await loadMessages(l), timeZone: "Asia/Kolkata" };
});

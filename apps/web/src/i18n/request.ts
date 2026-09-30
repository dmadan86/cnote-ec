import { getRequestConfig } from "next-intl/server";
import { getAppLocale } from "./app-locale";
import { isLocale } from "./config";
import { loadMessages } from "./messages";

// Every server-side call on the static public pages passes the locale explicitly (getTranslations({ locale, namespace })),
// so nothing here reads headers/cookies and they stay statically generated. A call WITHOUT a locale gets the language the
// (app) layout stored for the dynamic routes (account, buyer, rfq, ...), else English.
export default getRequestConfig(async ({ locale }) => {
  const l = isLocale(locale) ? locale : getAppLocale();
  return { locale: l, messages: await loadMessages(l), timeZone: "Asia/Kolkata" };
});

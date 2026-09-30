import "server-only";
import { currentSession } from "@cnote/next-kit";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { LOCALE_COOKIE, resolvePreferredLocale, type Locale } from "@/i18n/config";

/**
 * Language for routes without a /<locale>/ prefix (account, buyer, rfq, auth, ...). These are dynamic, so it may depend
 * on the request: `cnote_locale` cookie, else the signed-in person's preferredLanguage, else Accept-Language, else
 * English (resolution order lives in i18n/config.ts `resolvePreferredLocale`). Never call this from a localised
 * ([locale]) page: that tree is statically generated and takes its locale from the URL.
 */
export const getRequestLocale = cache(async (): Promise<Locale> =>
  resolvePreferredLocale({
    cookie: async () => (await cookies()).get(LOCALE_COOKIE)?.value,
    preferred: async () => {
      try {
        return (await currentSession())?.preferredLanguage;
      } catch {
        return null; // no session backend reachable: fall through to Accept-Language
      }
    },
    acceptLanguage: async () => (await headers()).get("accept-language"),
  }),
);

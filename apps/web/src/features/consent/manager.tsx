"use client";

import { ConsentManager as KitManager } from "@cnote/next-kit/consent";
import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";
import { LocaleLink } from "@/i18n/link";
import { SITE_NAME } from "@/features/shell/site";
import { EMBEDS_ENABLED } from "./embeds-flag";
import { ConsentRecord } from "./consent-record";
import { syncFromAccount, WEB_CONSENT_CONFIG } from "./client";

const noopSubscribe = () => () => undefined;
const LINK = "font-semibold text-brand-700 underline hover:text-brand-800";

/** Reconcile the cookie with the signed-in person's consent ledger, once per page load (web only; see account-sync.ts). */
const afterFlush = (locale: string) => syncFromAccount(locale);

/**
 * The buyer web's consent manager (mounted once via <Analytics />): the shared banner + preferences dialog bound to this app's
 * config, plus the account-ledger sync. `siteOrigin` is the marketplace origin; on a storefront served from a seller's own domain
 * the cookie policy link must point back to it, because `/cookies` there would resolve inside the storefront.
 */
export function ConsentManager({ siteOrigin }: { siteOrigin?: string }) {
  const t = useTranslations("consent");
  const foreign = useSyncExternalStore(noopSubscribe, () => !!siteOrigin && window.location.origin !== siteOrigin, () => false);
  return (
    <KitManager
      config={WEB_CONSENT_CONFIG}
      siteName={SITE_NAME}
      note={EMBEDS_ENABLED ? t("embedsNote") : undefined}
      record={<ConsentRecord className="mt-4 border-t border-line pt-4" />}
      afterFlush={afterFlush}
      policyLink={(chunks) =>
        foreign ? (
          <a href={`${siteOrigin}/cookies`} className={LINK}>
            {chunks}
          </a>
        ) : (
          <LocaleLink href="/cookies" className={LINK}>
            {chunks}
          </LocaleLink>
        )
      }
    />
  );
}

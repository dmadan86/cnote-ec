"use client";

import { buttonClasses } from "@cnote/ui";
import { useTranslations } from "next-intl";
import type { Ref } from "react";
import { LocaleLink } from "@/i18n/link";
import { SITE_NAME } from "@/features/shell/site";

/** Identical for all three buttons: same variant, size and width rules (EDPB Cookie Banner Taskforce: no visual bias). */
export const BANNER_BUTTON_CLASS = buttonClasses("outline-brand", "md", "min-h-11 min-w-[7rem] flex-1");

/**
 * First layer: short notice naming the data fiduciary, what and why, a link to the cookie policy, and Accept all /
 * Reject all / Customise with equal prominence. Non-modal (a region, not a dialog): the site stays usable without choosing.
 * `hidden` keeps it mounted (so focus can return to Customise) but out of sight while the preferences dialog is open.
 */
export function ConsentBannerView({
  onAccept,
  onReject,
  onCustomise,
  customiseRef,
  bannerRef,
  hidden = false,
}: {
  onAccept: () => void;
  onReject: () => void;
  onCustomise: () => void;
  customiseRef?: Ref<HTMLButtonElement>;
  bannerRef?: Ref<HTMLElement>;
  hidden?: boolean;
}) {
  const t = useTranslations("consent");
  return (
    <section ref={bannerRef} hidden={hidden} aria-label={t("aria")} data-consent-banner="" className="fixed inset-x-0 bottom-0 z-50 p-2 sm:p-4">
      <div className="mx-auto flex max-w-4xl flex-col gap-3 rounded-card border border-line bg-surface p-3 shadow-lg sm:p-4 md:flex-row md:items-center">
        <p className="text-sm text-ink">
          {t.rich("bannerText", {
            site: SITE_NAME,
            link: (chunks) => (
              <LocaleLink href="/cookies" className="font-semibold text-brand-700 underline hover:text-brand-800">
                {chunks}
              </LocaleLink>
            ),
          })}
        </p>
        <div className="flex flex-wrap gap-2 md:shrink-0 md:flex-nowrap">
          <button type="button" className={BANNER_BUTTON_CLASS} onClick={onAccept}>
            {t("acceptAll")}
          </button>
          <button type="button" className={BANNER_BUTTON_CLASS} onClick={onReject}>
            {t("rejectAll")}
          </button>
          <button type="button" className={BANNER_BUTTON_CLASS} ref={customiseRef} onClick={onCustomise}>
            {t("customise")}
          </button>
        </div>
      </div>
    </section>
  );
}

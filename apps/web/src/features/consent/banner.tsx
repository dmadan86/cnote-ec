"use client";

import { BANNER_BUTTON_CLASS, ConsentBannerView as KitBanner } from "@cnote/next-kit/consent";
import type { ComponentProps } from "react";
import { LocaleLink } from "@/i18n/link";
import { SITE_NAME } from "@/features/shell/site";

export { BANNER_BUTTON_CLASS };

const LINK = "font-semibold text-brand-700 underline hover:text-brand-800";

/**
 * The buyer web's first layer: the shared banner with the site name and a link to the cookie policy. On a seller storefront
 * served from its own domain (`policyHref` absolute) the link points back at the marketplace, because `/cookies` on that host
 * would resolve inside the storefront.
 */
export function ConsentBannerView({ policyHref, ...props }: Omit<ComponentProps<typeof KitBanner>, "siteName" | "policyLink"> & { policyHref?: string }) {
  return (
    <KitBanner
      siteName={SITE_NAME}
      policyLink={(chunks) =>
        policyHref ? (
          <a href={policyHref} className={LINK}>
            {chunks}
          </a>
        ) : (
          <LocaleLink href="/cookies" className={LINK}>
            {chunks}
          </LocaleLink>
        )
      }
      {...props}
    />
  );
}

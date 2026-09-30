import type { ReactNode } from "react";
import { HeaderHeightVar } from "./header-height";
import { SiteRail } from "./buyer-rail";

/**
 * Page body under the (sticky) site header: [rail | main + footer]. Shared by the [locale] layout, the (app) layout and the
 * root fallback (not-found, storefront routes). Nothing here reads the request, so static/ISR pages stay static: the rail's
 * open/closed state is CSS keyed off <html data-rail>, and per-user items are a client island (see SiteRail).
 * The rail shows from lg up; below that the header's mobile menu is the navigation.
 */
export function SiteFrame({ footer, children }: { footer: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1">
      <HeaderHeightVar />
      <SiteRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
          {children}
        </main>
        {footer}
      </div>
    </div>
  );
}

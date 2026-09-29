import { MapPin } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { Avatar } from "./avatar";
import { Money } from "./money";
import type { LinkComponent } from "./link";
import { TrustBadge } from "./badge";
import { WishlistButton, type WishlistToggleResult } from "./wishlist-button";

/**
 * Product tile (DESIGN.md "Product card"). `image` is a slot so the app can use next/image.
 * Show `seller` (TrustBadge) on search results; omit it on home rails.
 */
export function ProductCard({
  id,
  href,
  title,
  image,
  pricePaise,
  priceUnit,
  moqText,
  seller,
  saved,
  onToggleSaved,
  footer,
  linkComponent,
  className,
}: {
  id: string;
  href: string;
  title: string;
  image: ReactNode;
  pricePaise: number | null;
  priceUnit: string | null;
  moqText?: string | null;
  seller?: { name: string; city?: string | null; tier: number; badgeActive: boolean } | null;
  /** Saved state for the signed-in person; pair with `onToggleSaved` (server action). Guests omit the action and are sent to sign in. */
  saved?: boolean;
  onToggleSaved?: (id: string) => Promise<WishlistToggleResult>;
  /** Extra interactive controls under the card (e.g. a compare toggle). Rendered above the stretched link. */
  footer?: ReactNode;
  linkComponent?: LinkComponent;
  className?: string;
}) {
  const A = linkComponent ?? "a";
  return (
    <li className={cn("group relative flex flex-col rounded-card border border-line bg-surface p-2.5 transition-shadow hover:shadow-md", className)}>
      <div className="relative aspect-square overflow-hidden rounded-lg bg-canvas">
        {image}
        <div className="absolute right-2 top-2 z-10">
          <WishlistButton id={id} title={title} saved={saved} onToggle={onToggleSaved} />
        </div>
      </div>
      <div className="mt-3 flex flex-1 flex-col gap-1 px-0.5">
        <h3 className="line-clamp-2 min-h-10 text-sm font-semibold leading-5 text-ink">
          <A href={href} className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-brand-600">
            {title}
          </A>
        </h3>
        {pricePaise != null ? (
          <Money paise={pricePaise} unit={priceUnit} className="text-base" />
        ) : (
          <span className="text-sm font-semibold text-muted">Price on request</span>
        )}
        {moqText ? <p className="text-xs text-muted">Min. order: {moqText}</p> : null}
        {seller ? (
          <div className="mt-1.5 flex flex-col gap-1 border-t border-line pt-2">
            <p className="truncate text-xs text-ink">{seller.name}</p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <TrustBadge tier={seller.tier} badgeActive={seller.badgeActive} />
              {seller.city ? (
                <span className="inline-flex items-center gap-0.5 text-xs text-muted">
                  <MapPin className="size-3" aria-hidden /> {seller.city}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
        {footer ? <div className="relative z-10 mt-2">{footer}</div> : null}
      </div>
    </li>
  );
}

/** Seller/manufacturer tile with real verification tier and trust score (ADR-003). */
export function SellerCard({
  href,
  name,
  city,
  state,
  tier,
  badgeActive,
  trustScore,
  linkComponent,
  className,
}: {
  href: string;
  name: string;
  city?: string | null;
  state?: string | null;
  tier: number;
  badgeActive: boolean;
  trustScore?: number;
  linkComponent?: LinkComponent;
  className?: string;
}) {
  const A = linkComponent ?? "a";
  const place = [city, state].filter(Boolean).join(", ");
  return (
    <li className={cn("relative flex items-start gap-3 rounded-card border border-line bg-surface p-4 transition-shadow hover:shadow-md", className)}>
      <Avatar name={name} size="lg" />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-base font-semibold text-ink">
          <A href={href} className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-brand-600">
            {name}
          </A>
        </h3>
        {place ? (
          <p className="mt-0.5 inline-flex items-center gap-1 text-sm text-muted">
            <MapPin className="size-3.5" aria-hidden /> {place}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <TrustBadge tier={tier} badgeActive={badgeActive} />
          {trustScore != null ? <span className="text-xs text-muted">Trust score {trustScore}/100</span> : null}
        </div>
      </div>
    </li>
  );
}

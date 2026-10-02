/** Placeholder brand name (see CLAUDE.md: the real name is TBD). Keep every reference to it here. */
export const SITE_NAME = "BizKart";

export const SITE_TAGLINE = "Verified suppliers, real prices, powered by AI";

/** Seller app origin (apps/seller). */
export const SELLER_APP_URL = process.env.SELLER_APP_URL ?? "http://localhost:3002";

export const PINCODE_COOKIE = "cnote_pincode";

export interface NavItem {
  /** Key under messages `shell.nav` (label) and `<key>Desc` (description). */
  key: string;
  href: string;
  soon?: boolean;
}
export interface NavGroup {
  /** Key under messages `shell.nav` for the group label. */
  key: string;
  items: NavItem[];
  /** When set the group is a plain link (no dropdown); `items` is then ignored. */
  href?: string;
}

/** Header/mobile navigation (labels live in messages/*.json). "Coming soon" entries are not in the ADRs yet (DESIGN.md). */
export const NAV: NavGroup[] = [
  {
    key: "products",
    items: [
      { key: "allProducts", href: "/search?tab=products" },
      { key: "shopByCategory", href: "/categories" },
      { key: "newArrivals", href: "/?rail=new#popular" },
      { key: "postRequirement", href: "/rfq/new" },
    ],
  },
  {
    key: "manufacturers",
    items: [
      { key: "allManufacturers", href: "/manufacturers" },
      { key: "requestQuotes", href: "/rfq/new" },
    ],
  },
  {
    key: "templates",
    items: [
      { key: "templates", href: "/coming-soon/templates-design", soon: true },
      { key: "aiDesign", href: "/coming-soon/ai-design", soon: true },
    ],
  },
  {
    key: "aiTools",
    items: [
      { key: "aiSearch", href: "/search?tab=ai" },
      { key: "moreAiTools", href: "/coming-soon/ai-tools", soon: true },
    ],
  },
  { key: "services", items: [{ key: "services", href: "/coming-soon/business-services", soon: true }] },
  { key: "help", href: "/help", items: [] },
];

/**
 * What the header, mobile menu and rail actually show: "coming soon" items are hidden, and so is any dropdown whose
 * items are all "coming soon". The /coming-soon/* routes stay in place for direct links (and the promo panels).
 */
export function visibleNav(groups: readonly NavGroup[] = NAV): NavGroup[] {
  return groups.flatMap((g) => {
    if (g.href) return [g];
    const items = g.items.filter((i) => !i.soon);
    return items.length ? [{ ...g, items }] : [];
  });
}

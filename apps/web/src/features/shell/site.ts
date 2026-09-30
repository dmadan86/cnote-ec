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
  { key: "resources", items: [{ key: "guides", href: "/coming-soon/resources", soon: true }] },
];

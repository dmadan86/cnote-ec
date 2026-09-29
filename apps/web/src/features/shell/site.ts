/** Placeholder brand name (see CLAUDE.md: the real name is TBD). Keep every reference to it here. */
export const SITE_NAME = "BizKart";

export const SITE_TAGLINE = "Verified suppliers, real prices, powered by AI";

/** Seller app origin (apps/seller). */
export const SELLER_APP_URL = process.env.SELLER_APP_URL ?? "http://localhost:3002";

export const PINCODE_COOKIE = "cnote_pincode";

export interface NavItem {
  label: string;
  href: string;
  description?: string;
  soon?: boolean;
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Header/mobile navigation. "Coming soon" entries are not in the ADRs yet (DESIGN.md). */
export const NAV: NavGroup[] = [
  {
    label: "Products",
    items: [
      { label: "All products", href: "/search?tab=products", description: "Search listings from verified suppliers" },
      { label: "Shop by category", href: "/categories", description: "Packaging, apparel, industrial and more" },
      { label: "New arrivals", href: "/?rail=new#popular", description: "Recently listed products" },
      { label: "Post your requirement", href: "/rfq/new", description: "Get quotes from up to 3 suppliers" },
    ],
  },
  {
    label: "Manufacturers",
    items: [
      { label: "All manufacturers", href: "/manufacturers", description: "Trust-ranked suppliers across India" },
      { label: "Request quotes", href: "/rfq/new", description: "Describe what you need once" },
    ],
  },
  {
    label: "Templates & Design",
    items: [
      { label: "Templates & Design", href: "/coming-soon/templates-design", description: "Logos, packaging and print templates", soon: true },
      { label: "AI Design", href: "/coming-soon/ai-design", description: "Design custom packaging with AI", soon: true },
    ],
  },
  {
    label: "AI Tools",
    items: [
      { label: "AI Search", href: "/search?tab=ai", description: "Ask for what you need in plain words" },
      { label: "More AI tools", href: "/coming-soon/ai-tools", description: "Quote comparison, sourcing assistant", soon: true },
    ],
  },
  {
    label: "Business Services",
    items: [{ label: "Business Services", href: "/coming-soon/business-services", description: "Logistics, compliance and finance partners", soon: true }],
  },
  {
    label: "Resources",
    items: [{ label: "Guides & resources", href: "/coming-soon/resources", description: "Sourcing guides for MSMEs", soon: true }],
  },
];

const trim = (u: string) => u.replace(/\/+$/, "");

/** Seller portal (sign-up, onboarding, listings). */
export const SELLER_APP_URL = trim(process.env.SELLER_APP_URL ?? "http://localhost:3002");
/** Buyer web, where published storefronts live at /store/<slug>. */
export const WEB_APP_URL = trim(process.env.APP_URL ?? "http://localhost:3000");
export const storeUrl = (slug: string, page = "") => `${WEB_APP_URL}/store/${slug}${page && page !== "home" ? `/${page}` : ""}`;

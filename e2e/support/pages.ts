import type { Page } from "@playwright/test";
import { DEMO } from "./env";

/** Seeded category (apps/worker/src/seed.ts). Category-specific logic is config/data, so we only rely on this slug existing. */
export const CATEGORY_SLUG = "packaging-printing";

/**
 * Resolves a real product URL through the UI (search -> first result) so specs do not hard-code seed ids.
 * The href is already locale-aware (/p/... or /hi/p/...).
 */
export async function firstProductHref(page: Page, locale: "en" | "hi" = "en", q = "box"): Promise<string> {
  await page.goto(`${locale === "hi" ? "/hi" : ""}/search?q=${encodeURIComponent(q)}`);
  const link = page.locator("main a[href*='/p/']").first();
  await link.waitFor();
  const href = await link.getAttribute("href");
  if (!href) throw new Error("no product link found in search results; is the e2e database seeded and projected to the live DB?");
  return href;
}

export { DEMO };

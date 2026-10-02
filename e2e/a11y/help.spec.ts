/**
 * Help centre (/help): axe WCAG 2.2 AA on the landing page and one article in English and Hindi, client-side search,
 * FAQPage + breadcrumb JSON-LD, the Help nav link, and the PWA manifest / offline page.
 */
import { expect, test } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";

type Locale = "en" | "hi";
const prefix = (l: Locale) => (l === "hi" ? "/hi" : "");
const ARTICLE = "/help/suppliers/how-ranked";

for (const locale of ["en", "hi"] as const) {
  test.describe(`help centre (${locale})`, () => {
    test("landing page passes axe and lists topics and popular articles", async ({ page }, info) => {
      await page.goto(`${prefix(locale)}/help`);
      await settle(page);
      await expect(page.locator("html")).toHaveAttribute("lang", locale === "hi" ? /^hi/ : /^en/);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator("main a[href*='/help/']").first()).toBeVisible();
      await expectNoBlockingViolations(page, info);
    });

    test("article page passes axe, has breadcrumbs and FAQPage JSON-LD", async ({ page }, info) => {
      await page.goto(`${prefix(locale)}${ARTICLE}`);
      await settle(page);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("navigation", { name: locale === "hi" ? "ब्रेडक्रम्ब" : "Breadcrumb" })).toBeVisible();
      const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
      const docs = blocks.flatMap((b) => {
        const j = JSON.parse(b) as unknown;
        return Array.isArray(j) ? j : [j];
      }) as { "@type": string; mainEntity?: { name: string; acceptedAnswer: { text: string } }[]; itemListElement?: unknown[] }[];
      const faq = docs.find((d) => d["@type"] === "FAQPage");
      expect(faq?.mainEntity?.length).toBeGreaterThanOrEqual(1);
      expect(faq?.mainEntity?.[0]?.acceptedAnswer.text.length).toBeGreaterThan(10);
      const crumbs = docs.find((d) => d["@type"] === "BreadcrumbList");
      expect(crumbs?.itemListElement?.length).toBe(4);
      await expectNoBlockingViolations(page, info);
    });
  });
}

test.describe("help centre search", () => {
  test("filters the article list as you type and clears", async ({ page }) => {
    await page.goto("/help");
    await settle(page);
    const box = page.getByRole("searchbox", { name: "Search help articles" });
    await box.fill("refund");
    const results = page.getByTestId("help-results");
    await expect(results.getByRole("link")).toHaveCount(1);
    await expect(results.getByRole("link").first()).toContainText("refunds");
    await expect(page.getByRole("status")).toContainText("1 article found");
    await box.fill("zzzzqqq");
    await expect(page.getByTestId("help-results")).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("No article matches");
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(box).toHaveValue("");
    await expect(page.getByRole("heading", { level: 2, name: "Browse by topic" })).toBeVisible();
  });

  test("opens an article from the results", async ({ page }) => {
    await page.goto("/help");
    await settle(page);
    await page.getByRole("searchbox", { name: "Search help articles" }).fill("verification tiers");
    await page.getByTestId("help-results").getByRole("link").first().click();
    await expect(page).toHaveURL(/\/help\/suppliers\/verification-tiers$/);
  });
});

test.describe("help in the navigation", () => {
  test("header has a Help link to /help, and no Coming soon items", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await page.goto("/");
    await settle(page);
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Help" })).toHaveAttribute("href", "/help");
    await expect(nav.getByRole("button", { name: "Resources" })).toHaveCount(0);
    await expect(nav.getByRole("button", { name: "Templates & Design" })).toHaveCount(0);
    await expect(nav.getByRole("button", { name: "Business Services" })).toHaveCount(0);
    await nav.getByRole("button", { name: "Products" }).click();
    await expect(nav.getByText("Coming soon")).toHaveCount(0);
  });
});

test.describe("PWA", () => {
  test("serves a valid web app manifest", async ({ request }) => {
    const res = await request.get("/manifest.webmanifest");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/json/);
    const m = (await res.json()) as { display: string; start_url: string; icons: { src: string; sizes: string }[]; theme_color: string };
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    expect(m.theme_color).toMatch(/^#/);
    expect(m.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    for (const icon of m.icons) {
      const r = await request.get(icon.src);
      expect(r.status(), icon.src).toBe(200);
      expect(r.headers()["content-type"]).toMatch(/image\/png/);
    }
  });

  test("serves the service worker and the offline pages in both languages", async ({ request, page }) => {
    const sw = await request.get("/sw.js");
    expect(sw.status()).toBe(200);
    expect(sw.headers()["content-type"]).toMatch(/javascript/);
    expect(sw.headers()["cache-control"]).toMatch(/no-cache/);
    for (const [path, title] of [["/offline", "You are offline"], ["/hi/offline", "आप ऑफ़लाइन हैं"]] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    }
  });
});

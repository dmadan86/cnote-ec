/**
 * 404 pages (apps/web/src/app/not-found.tsx, [locale]/not-found.tsx): axe WCAG 2.2 AA, a single h1, and the page language.
 * /hi/<unknown> hits the root not-found, which derives its language from the URL after hydration (src/i18n/fatal-locale.ts).
 */
import { expect, test } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";

const CASES = [
  { locale: "en", path: "/this-page-does-not-exist", lang: /^en/, title: "We could not find that page", home: "Go to home", homeHref: "/" },
  { locale: "hi", path: "/hi/this-page-does-not-exist", lang: /^hi/, title: "हमें वह पेज नहीं मिला", home: "होम पर जाएँ", homeHref: "/hi" },
] as const;

for (const c of CASES) {
  test.describe(`404 (${c.locale})`, () => {
    test("renders in the page language with correct lang and no axe violations", async ({ page }, info) => {
      const res = await page.goto(c.path);
      expect(res?.status()).toBe(404);
      await settle(page);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(c.title);
      await expect(page.locator("html")).toHaveAttribute("lang", c.lang);
      const home = page.getByRole("main").getByRole("link", { name: c.home });
      await expect(home).toHaveAttribute("href", c.homeHref);
      await expectNoBlockingViolations(page, info);
    });
  });
}

test("a missing product under /hi renders the localised not-found (segment boundary)", async ({ page }, info) => {
  await page.goto("/hi/p/00000000-0000-0000-0000-000000000000");
  await settle(page);
  await expect(page.locator("html")).toHaveAttribute("lang", /^hi/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("हमें वह पेज नहीं मिला");
  await expectNoBlockingViolations(page, info);
});

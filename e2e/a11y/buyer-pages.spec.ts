/**
 * axe-core WCAG 2.2 AA scans of the key buyer pages, English and Hindi (ADR-004, CLAUDE.md "Accessibility is a release
 * blocker for the buyer web"). Serious/critical violations fail; moderate/minor are attached as annotations.
 *
 * Known bugs: a violation we found but cannot fix from the test suite is excluded from the blocking scan through
 * `knownRules` and re-asserted in a sibling `test.fixme` so it stays visible (flip it to `test` when fixed).
 */
import { expect, test } from "../support/fixtures";
import { expectNoBlockingViolations, expectRuleClean, settle } from "../support/a11y";
import { DEMO } from "../support/env";
import { signIn } from "../support/auth";
import { CATEGORY_SLUG, firstProductHref } from "../support/pages";

type Locale = "en" | "hi";
const prefix = (l: Locale) => (l === "hi" ? "/hi" : "");

// Public discovery pages exist per locale (LOCALIZED_PREFIXES in apps/web/src/i18n/config.ts).
const localizedPages: { name: string; path: string; known?: string[] }[] = [
  { name: "home", path: "" },
  { name: "search results", path: "/search?q=box" },
  { name: "categories", path: "/categories" },
  { name: "category", path: `/c/${CATEGORY_SLUG}` },
  { name: "manufacturers", path: "/manufacturers" },
  { name: "pricing", path: "/pricing" },
  { name: "dispute policy", path: "/dispute-policy" },
  { name: "ranking and ads", path: "/ranking-and-ads" },
];

for (const locale of ["en", "hi"] as const) {
  test.describe(`axe WCAG 2.2 AA (${locale})`, () => {
    for (const p of localizedPages) {
      test(`${p.name}`, async ({ page }, info) => {
        await page.goto(`${prefix(locale)}${p.path || (locale === "hi" ? "" : "/")}`);
        await settle(page);
        await expect(page.locator("html")).toHaveAttribute("lang", locale === "hi" ? /^hi/ : /^en/);
        await expectNoBlockingViolations(page, info, { knownRules: p.known });
      });
    }


    test("product page", async ({ page }, info) => {
      await page.goto(await firstProductHref(page, locale));
      await settle(page);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoBlockingViolations(page, info);
    });
  });
}

// Not localised yet (they stay unprefixed English, see docs/guides/i18n.md): scan once.
test.describe("axe WCAG 2.2 AA (English-only pages)", () => {
  test("sign in", async ({ page }, info) => {
    await page.goto("/signin");
    await settle(page);
    await expectNoBlockingViolations(page, info);
  });

  test("sign up", async ({ page }, info) => {
    await page.goto("/signup");
    await settle(page);
    await expectNoBlockingViolations(page, info);
  });

  test("RFQ form (signed in)", async ({ page }, info) => {
    await signIn(page, DEMO.buyer.email, DEMO.buyer.password, "/rfq/new");
    await expect(page.getByRole("heading", { level: 1, name: "Post your requirement" })).toBeVisible();
    await settle(page);
    await expectNoBlockingViolations(page, info);
  });

  test("form errors are announced (sign in, empty submit)", async ({ page }, info) => {
    await page.goto("/signin");
    await page.getByRole("button", { name: "Sign in" }).click();
    // The invalid state must be exposed programmatically, not by colour alone.
    await expect(page.locator("[aria-invalid='true'], [role=alert]").first()).toBeVisible();
    await expectNoBlockingViolations(page, info);
  });
});

test("Hindi page keeps the landmark structure of the English one", async ({ page }) => {
  for (const path of ["/", "/hi"]) {
    await page.goto(path);
    await settle(page);
    await expect(page.getByRole("banner")).toHaveCount(1);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("contentinfo")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  }
});

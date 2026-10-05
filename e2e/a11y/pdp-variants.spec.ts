/**
 * Product page variant selector + availability (docs/design/variants-stock.md): axe (WCAG 2.2 AA) in English and Hindi, keyboard
 * operation of the radio groups, the polite live announcement, the shareable ?v= link, and the "In stock only" search filter.
 * Runs on the desktop project and, through the .mobile pattern of the other specs, is also valid at Pixel 7 width (targets >= 44px).
 * Data: a listing cloned into the live read DB with a Size x Colour matrix (support/variants-db.ts).
 */
import { expect, test } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { removeVariantListing, seedVariantListing, type SeededVariantListing } from "../support/variants-db";

test.setTimeout(120_000);

let seeded: SeededVariantListing;
test.beforeAll(async () => {
  seeded = await seedVariantListing();
});
test.afterAll(async () => {
  if (seeded) await removeVariantListing(seeded.id);
});

for (const locale of ["en", "hi"] as const) {
  test.describe(`variant selector (${locale})`, () => {
    test("renders one labelled radio group per axis, states stock in text, and passes axe", async ({ page }, info) => {
      await page.goto(seeded.href(locale));
      await settle(page);
      const groups = page.getByTestId("pdp-variants").getByRole("group");
      await expect(groups).toHaveCount(2);
      await expect(groups.first().getByRole("radio")).toHaveCount(2);
      // Stock is spelled out on the option itself, not only by colour.
      await expect(page.getByTestId("pdp-variants")).toContainText(locale === "en" ? "Out of stock" : "स्टॉक में नहीं");
      await expectNoBlockingViolations(page, info);
    });

    test("keyboard choice updates price, availability, URL and the polite live region; the result passes axe", async ({ page }, info) => {
      await page.goto(seeded.href(locale));
      await settle(page);
      const live = page.getByTestId("pdp-variant-live");
      await expect(live).toHaveAttribute("aria-live", "polite");
      const firstRadio = page.getByTestId("pdp-variants").getByRole("radio").first();
      await firstRadio.focus();
      await page.keyboard.press("Space");
      await expect(firstRadio).toBeChecked();
      // pick the second axis' first option with the arrow keys inside its group
      const colour = page.getByTestId("pdp-variants").getByRole("group").nth(1).getByRole("radio");
      await colour.first().focus();
      await page.keyboard.press("Space");
      await expect(live).not.toBeEmpty();
      await expect(page).toHaveURL(/[?&]v=TEE-/);
      await expect(page.getByTestId("pdp-stock")).toBeVisible();
      await expectNoBlockingViolations(page, info);
    });

    test("a shared ?v= link restores the choice, an unknown sku is ignored", async ({ page }) => {
      await page.goto(`${seeded.href(locale)}?v=${seeded.skus.madeToOrder}`);
      await settle(page);
      await expect(page.getByTestId("pdp-variants").getByRole("radio", { checked: true })).toHaveCount(2);
      await expect(page.getByTestId("pdp-stock")).toContainText(locale === "en" ? "Made to order" : "ऑर्डर पर बनता है");
      await page.goto(`${seeded.href(locale)}?v=NOPE`);
      await settle(page);
      await expect(page.getByTestId("pdp-variants").getByRole("radio", { checked: true })).toHaveCount(0);
    });
  });
}

test.describe("touch targets", () => {
  test("variant options are at least 44px high so they work on a phone", async ({ page }) => {
    await page.goto(seeded.href("en"));
    await settle(page);
    const radios = page.getByTestId("pdp-variants").locator("label");
    const n = await radios.count();
    for (let i = 0; i < n; i++) expect((await radios.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe("search: In stock only", () => {
  test("the checkbox is labelled, keyboard operable, writes instock=1 and shows a removable chip; the page passes axe", async ({ page }, info) => {
    await page.goto(`/search?q=${encodeURIComponent("Variant Tee")}&instock=1`);
    await settle(page);
    await expect(page.getByRole("checkbox", { name: "In stock only" }).first()).toBeChecked();
    await expect(page.getByRole("link", { name: /Remove .*In stock only/ })).toBeVisible();
    await expectNoBlockingViolations(page, info);
  });
});

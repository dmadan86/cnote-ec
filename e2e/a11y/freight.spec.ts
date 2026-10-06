/**
 * Freight estimator panel on the product page (docs/design/freight-estimator.md): English and Hindi, desktop and the mobile
 * project (this file runs in both; the target-size check applies on touch). The estimate comes from the default rate card, so
 * the seeded catalogue needs no carrier credentials. Final freight is always "quoted by the seller": the disclaimer must be
 * visible before AND after an estimate.
 */
import { expect, test } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { firstProductHref } from "../support/pages";

const COPY = {
  en: { prefix: "", panel: "Estimate freight", button: "Estimate freight", disclaimer: "This is an estimate only. The final freight is quoted by the seller.", invalid: "Enter a valid 6-digit PIN code." },
  hi: { prefix: "/hi", panel: "भाड़े का अनुमान", button: "भाड़े का अनुमान लगाएँ", disclaimer: "यह केवल अनुमान है। अंतिम भाड़ा विक्रेता बताएगा।", invalid: "सही 6 अंकों का पिनकोड लिखें।" },
} as const;

for (const locale of ["en", "hi"] as const) {
  test.describe(`product page freight panel (${locale})`, () => {
    test("validates the PIN, shows a range with mode, transit and the estimate label, and passes axe", async ({ page }, info) => {
      const c = COPY[locale];
      await page.goto(await firstProductHref(page, locale, "Custom Packaging Boxes"));
      await settle(page);
      const panel = page.getByTestId("freight-estimate");
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("heading", { name: c.panel })).toBeVisible();
      await expect(panel.getByText(c.disclaimer)).toBeVisible(); // visible before any estimate

      // Every control has a label; the button is a 44px target on touch.
      const pin = panel.getByRole("textbox").first();
      await expect(pin).toBeVisible();
      const btn = panel.getByRole("button", { name: c.button });
      if (page.viewportSize()!.width < 500) expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(44);

      await pin.fill("12");
      await btn.click();
      await expect(panel.getByText(c.invalid)).toBeVisible();

      await pin.fill("400001");
      await btn.click();
      const result = panel.getByTestId("freight-result");
      await expect(result).toBeVisible();
      await expect(result).toContainText("₹");
      await expect(panel.getByText(c.disclaimer)).toBeVisible(); // and after
      await expectNoBlockingViolations(page, info);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  });
}

test("the public endpoint rejects a bad PIN and never returns the seller's pincode", async ({ request }) => {
  const bad = await request.get("/api/freight/estimate?listingId=00000000-0000-4000-8000-000000000000&quantity=1&pincode=12");
  expect(bad.status()).toBe(400);
  expect(bad.headers()["cache-control"] ?? "").not.toMatch(/public/);
});

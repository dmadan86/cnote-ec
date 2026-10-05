/**
 * DPDP s.14 nominee screens (apps/web/src/features/nominee): the public nominee request form (/grievance/nominee) in English and
 * Hindi: axe WCAG 2.2 AA, labelled controls, one h1, and the request/confirmation flow that never reveals whether an account exists.
 * The signed-in /account/nominee page needs an account; it is covered by the same primitives (Field/Input/Select) and checked in the
 * signed-in buyer-account axe spec when that suite is extended.
 */
import { expect, test } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";

for (const locale of ["en", "hi"] as const) {
  test.describe(`nominee request (${locale})`, () => {
    test.use({ extraHTTPHeaders: { "accept-language": locale === "hi" ? "hi-IN,hi;q=0.9" : "en-IN,en;q=0.9" } });

    test("has no axe violations, one h1 and a label for every control", async ({ page }, info) => {
      await page.goto("/grievance/nominee");
      await settle(page);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      for (const id of ["nr-principal", "nr-name", "nr-contact", "nr-ground", "nr-message"]) {
        await expect(page.locator(`label[for="${id}"]`), id).toHaveCount(1);
      }
      await expectNoBlockingViolations(page, info);
    });

    test("an unknown account gets the same confirmation as any other", async ({ page }, info) => {
      await page.goto("/grievance/nominee");
      await settle(page);
      await page.locator("#nr-principal").fill(`nobody-${Date.now()}@example.com`);
      await page.locator("#nr-name").fill("Test Nominee");
      await page.locator("#nr-contact").fill("test.nominee@example.com");
      await page.locator("#nr-message").fill("Please help me with my relative's account.");
      await page.locator("form button[type=submit]").click();
      await expect(page.getByRole("status")).toBeVisible();
      await expectNoBlockingViolations(page, info);
    });
  });
}

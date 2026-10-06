/**
 * Rate contracts on the buyer web (docs/design/rate-contracts.md): WCAG 2.2 AA with axe in English and Hindi for the list, the new-contract
 * form, an active contract (terms table, usage bars, history), a contract with a revision waiting for the buyer's answer, and the call-off
 * form; plus keyboard reach of the main actions. Rows are seeded by e2e/support/phase2-db.ts (seedRateContract).
 */
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { reachByKeyboard, setLocaleCookie, type Locale } from "../support/a11y-extra";
import { signUpBuyer } from "../support/auth";
import { expect, test, type Page } from "../support/fixtures";
import { seedRateContract } from "../support/phase2-db";

const LOCALES: Locale[] = ["en", "hi"];
test.setTimeout(120_000); // many full page loads, each settled and scanned

async function scan(page: Page, info: Parameters<typeof expectNoBlockingViolations>[1], locale: Locale) {
  await settle(page);
  await expect(page.locator("html")).toHaveAttribute("lang", locale === "hi" ? /^hi/ : /^en/);
  await expectNoBlockingViolations(page, info);
}

for (const locale of LOCALES) {
  test.describe(`rate contracts (${locale})`, () => {
    test("list, new form, active contract, pending revision and call-off form", async ({ page }, info) => {
      const acct = await signUpBuyer(page, `rc${locale}`);
      await setLocaleCookie(page.context(), locale);

      // empty state before anything exists
      await page.goto("/buyer/contracts");
      await scan(page, info, locale);

      const seeded = await seedRateContract(acct.email);

      await page.goto("/buyer/contracts");
      await scan(page, info, locale);
      await page.goto("/buyer/contracts?status=proposed");
      await scan(page, info, locale);
      await expect(page.getByText("RC/26-27/000002").first()).toBeVisible();

      await page.goto("/buyer/contracts/new");
      await scan(page, info, locale);
      await reachByKeyboard(page, page.locator("main input[name=title]").first());

      await page.goto(`/buyer/contracts/${seeded.activeId}`);
      await scan(page, info, locale);
      await expect(page.getByRole("progressbar").first()).toBeVisible();
      await expect(page.locator("table caption").first()).toBeAttached();
      await reachByKeyboard(page, page.locator("main summary:visible").first());

      await page.goto(`/buyer/contracts/${seeded.pendingId}`);
      await scan(page, info, locale);
      await reachByKeyboard(page, page.locator("main button[type=submit][value=accepted]").first());

      await page.goto(`/buyer/contracts/${seeded.activeId}/call-off`);
      await scan(page, info, locale);
      await reachByKeyboard(page, page.locator("main input[type=number]").first());
    });
  });
}

/**
 * Goods receipts, three-way invoice match and returns on the buyer web (docs/design/grn-returns.md): WCAG 2.2 AA with axe in English and Hindi,
 * keyboard reach of the main actions, the receipt form with a rejection (conditional reason field) and the pay-anyway form behind a mismatch.
 * Rows are seeded by e2e/support/phase2-db.ts (seedGoodsReceipt); the seller's side lives in the seller app.
 */
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { reachByKeyboard, setLocaleCookie, type Locale } from "../support/a11y-extra";
import { signUpBuyer } from "../support/auth";
import { expect, test, type Page } from "../support/fixtures";
import { seedGoodsReceipt, seedOrder } from "../support/phase2-db";

const LOCALES: Locale[] = ["en", "hi"];
test.setTimeout(120_000); // many full page loads, each settled and scanned

async function scan(page: Page, info: Parameters<typeof expectNoBlockingViolations>[1], locale: Locale) {
  await settle(page);
  await expect(page.locator("html")).toHaveAttribute("lang", locale === "hi" ? /^hi/ : /^en/);
  await expectNoBlockingViolations(page, info);
}

for (const locale of LOCALES) {
  test.describe(`goods receipts, match and returns (${locale})`, () => {
    test("receipts page and form, match view with tolerances, returns list, request form, rejected return with dispute entry, pay-anyway form", async ({ page }, info) => {
      const acct = await signUpBuyer(page, `grn${locale}`);
      await setLocaleCookie(page.context(), locale);

      // an order without a purchase order: the receipts page points to issuing one
      const plain = await seedOrder(acct.email, { status: "dispatched" });
      await page.goto(`/buyer/orders/${plain.orderId}/receipts`);
      await scan(page, info, locale);

      const s = await seedGoodsReceipt(acct.email);
      // the order page shows the receipts / match / returns shortcuts
      await page.goto(`/buyer/orders/${s.orderId}`);
      await scan(page, info, locale);

      // receipts: progress table, the receipt form, the recorded receipt with the return link
      await page.goto(`/buyer/orders/${s.orderId}/receipts`);
      await scan(page, info, locale);
      await expect(page.getByText("GRN/26-27/000001").first()).toBeVisible();
      const rejected = page.locator("input[name='rejected__1']");
      await rejected.fill("2");
      await expect(page.locator("select[name='reason__1']")).toBeVisible(); // the reason field appears with a rejection
      await expectNoBlockingViolations(page, info);
      await reachByKeyboard(page, page.locator("main a[href*='/buyer/returns/new']").first());

      // match: mismatch (two invoices of 100 units against 90 accepted), tolerance form
      await page.goto(`/buyer/orders/${s.orderId}/match`);
      await scan(page, info, locale);
      await reachByKeyboard(page, page.locator("main input[name='qtyTolerance']"));

      // returns list, detail of the rejected return (dispute form), request form
      await page.goto("/buyer/returns");
      await scan(page, info, locale);
      await page.goto("/buyer/returns?filter=all");
      await scan(page, info, locale);
      await page.goto(`/buyer/returns/${s.returnId}`);
      await scan(page, info, locale);
      await expect(page.locator("textarea[name='text']")).toBeVisible();
      await page.goto(`/buyer/returns/new?receipt=${s.receiptId}`);
      await scan(page, info, locale);
      await reachByKeyboard(page, page.locator("main select[name='reasonCode']"));

      // payables: the mismatching invoice asks for a reason before it can be paid
      await page.goto("/buyer/payables");
      await scan(page, info, locale);
      // open the disclosure that holds the override field (the first one may belong to an invoice the match does not block)
      await page.locator("main details", { has: page.locator("input[name='overrideReason']") }).first().locator("summary").click();
      await expect(page.locator("input[name='overrideReason']").first()).toBeVisible();
      await expectNoBlockingViolations(page, info);
    });
  });
}

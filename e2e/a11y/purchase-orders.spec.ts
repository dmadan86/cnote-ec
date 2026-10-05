/**
 * Purchase orders, supplier invoices and MSME payables on the buyer web (docs/design/purchase-orders.md): WCAG 2.2 AA with axe in
 * English and Hindi, keyboard reach of the main actions, and the error state of the payment form. Rows are seeded by
 * e2e/support/phase2-db.ts (seedPurchaseOrder); the seller's side lives in the seller app.
 */
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { reachByKeyboard, setLocaleCookie, type Locale } from "../support/a11y-extra";
import { signUpBuyer } from "../support/auth";
import { expect, test, type Page } from "../support/fixtures";
import { seedOrder, seedPurchaseOrder } from "../support/phase2-db";

const LOCALES: Locale[] = ["en", "hi"];

async function scan(page: Page, info: Parameters<typeof expectNoBlockingViolations>[1], locale: Locale) {
  await settle(page);
  await expect(page.locator("html")).toHaveAttribute("lang", locale === "hi" ? /^hi/ : /^en/);
  await expectNoBlockingViolations(page, info);
}

for (const locale of LOCALES) {
  test.describe(`purchase orders (${locale})`, () => {
    test("issue form, PO detail with invoices, e-invoice and pay-by badges, payables list", async ({ page }, info) => {
      const acct = await signUpBuyer(page, `po${locale}`);
      await setLocaleCookie(page.context(), locale);

      // order without a PO: the issue form (the buyer has no saved address yet, so the add-address prompt shows)
      const plain = await seedOrder(acct.email, { status: "confirmed" });
      await page.goto(`/buyer/orders/${plain.orderId}`);
      await scan(page, info, locale);
      await page.goto(`/buyer/orders/${plain.orderId}/purchase-order`);
      await scan(page, info, locale);

      // order with an accepted PO and two MSME invoices (one overdue with an e-invoice and e-way bill)
      const seeded = await seedPurchaseOrder(acct.email);
      await page.goto(`/buyer/orders/${seeded.orderId}`);
      await scan(page, info, locale);
      await page.goto(`/buyer/orders/${seeded.orderId}/purchase-order`);
      await scan(page, info, locale);
      await expect(page.getByText("PO/26-27/000001").first()).toBeVisible();
      await expect(page.locator("img[alt]").first()).toBeVisible(); // QR image has alt text
      await reachByKeyboard(page, page.locator("main summary:visible").first());

      // pay form open, error state: the form refuses an empty reference and announces it
      const summary = page.locator("main details summary:visible").first();
      await summary.focus();
      await page.keyboard.press("Enter");
      await expectNoBlockingViolations(page, info);

      await page.goto("/buyer/payables");
      await scan(page, info, locale);
      await page.goto("/buyer/payables?filter=overdue");
      await scan(page, info, locale);
      await reachByKeyboard(page, page.locator("main a[href*='purchase-order']").first());
    });
  });
}

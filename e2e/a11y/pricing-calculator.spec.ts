/**
 * Public /pricing calculator (ADR-005): axe WCAG 2.2 AA in English and Hindi, keyboard-only operation, and the computed
 * values (GST-inclusive monthly or annual cost, cost per lead, credit expiry) read from the live region.
 * The page itself is static; the calculator is a client island.
 */
import { expect, test, type Page } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";

const path = (locale: "en" | "hi") => (locale === "hi" ? "/hi/pricing" : "/pricing");

async function open(page: Page, locale: "en" | "hi") {
  await page.goto(path(locale));
  await settle(page);
  // wait for hydration: the island responds to input
  await expect(page.getByRole("status").filter({ hasText: "₹" }).first()).toBeVisible();
}

for (const locale of ["en", "hi"] as const) {
  test.describe(`pricing calculator (${locale})`, () => {
    test("page passes axe with the calculator in its default and annual states", async ({ page }, info) => {
      await open(page, locale);
      await expectNoBlockingViolations(page, info);
      await page.locator('input[type="radio"]').last().check();
      await expectNoBlockingViolations(page, info);
    });
  });
}

test.describe("pricing calculator (values and keyboard)", () => {
  test("monthly and annual costs include GST; per-lead cost and the 90-day expiry are shown", async ({ page }) => {
    await open(page, "en");
    const results = page.getByRole("status", { name: "Estimated cost" });
    // default: 20 leads -> Starter
    await expect(results).toContainText("₹1,178.82 a month including GST (₹999 + ₹179.82 GST).");
    await expect(results).toContainText("About ₹58.94 per lead you accept");
    await expect(results).toContainText("stay usable for 90 days");
    await expect(results).toContainText("Nothing renews on its own");

    await page.getByLabel("Leads you expect to accept each month").fill("60");
    await page.getByLabel("Plan", { exact: true }).selectOption({ label: "Pro" });
    await expect(results).toContainText("₹3,538.82 a month including GST (₹2,999 + ₹539.82 GST).");
    await expect(results).toContainText("About ₹58.98 per lead you accept. The plan covers 60 of your 60 leads each month.");
    await expect(results).toContainText("190 spare credits a month roll over.");

    await page.getByRole("radio", { name: /Annual \(save 20%\)/ }).check();
    await expect(results).toContainText("₹33,972.67 once a year including GST (₹28,790.40 + ₹5,182.27 GST).");
    await expect(results).toContainText("That is ₹2,831.05 a month, and saves ₹7,197.60 before GST");
    await expect(results).toContainText("On the annual plan, credits are added month by month");
  });

  test("the free plan has no billing choice, and too many leads reports a shortfall", async ({ page }) => {
    await open(page, "en");
    const results = page.getByRole("status", { name: "Estimated cost" });
    await page.getByLabel("Plan", { exact: true }).selectOption({ label: "Free" });
    await expect(results).toContainText("The Free plan costs nothing and adds 10 lead credits every month.");
    await expect(page.getByRole("radio")).toHaveCount(0);
    await page.getByLabel("Plan", { exact: true }).selectOption({ label: "Pro" });
    await page.getByLabel("Leads you expect to accept each month").fill("400");
    await expect(results).toContainText("150 leads a month are more than this plan covers");
  });

  test("works with the keyboard alone and announces results in a polite live region", async ({ page }) => {
    await open(page, "en");
    const leads = page.getByLabel("Leads you expect to accept each month");
    await expect(page.getByRole("status", { name: "Estimated cost" })).toHaveAttribute("aria-live", "polite");
    await leads.focus();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("60");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Plan", { exact: true })).toBeFocused();
    await page.keyboard.type("Pro"); // type-ahead on the focused native select
    await page.keyboard.press("Tab");
    const monthly = page.getByRole("radio", { name: "Monthly" });
    await expect(monthly).toBeFocused();
    await page.keyboard.press("ArrowRight"); // radio group: arrow moves and selects
    await expect(page.getByRole("radio", { name: /Annual/ })).toBeChecked();
    await expect(page.getByRole("status", { name: "Estimated cost" })).toContainText("once a year including GST");
    // every control has a visible focus indicator (no outline:none without a replacement)
    for (const el of [leads, page.getByLabel("Plan", { exact: true })]) {
      await el.focus();
      const shadow = await el.evaluate((n) => getComputedStyle(n).boxShadow + getComputedStyle(n).outlineStyle);
      expect(shadow).not.toBe("nonenone");
    }
  });
});

test.describe("pricing page without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("is static: plans and annual prices render from the server", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByRole("heading", { level: 1, name: "Simple, public pricing" })).toBeVisible();
    await expect(page.getByText("Annual:").first()).toBeVisible();
  });
});

/**
 * Seller billing (ADR-005): cancel in at most 3 taps with the exact consequences shown first, and the in-app pricing
 * calculator. The cancel journey uses sellers seeded on a paid annual plan (e2e/setup/seed-billing.ts), one per attempt.
 */
import { expect, test, type Locator, type Page } from "../support/fixtures";
import { BILLING_E2E_PASSWORD, E2E_EXPECTED_REFUND_PAISE, billingE2eEmail } from "../support/billing";
import { DEMO, SELLER_URL } from "../support/env";

test.use({ baseURL: SELLER_URL });

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/signin");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/signin/);
}

const rupees = (paise: number) => (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

test.describe("cancel plan in 3 taps", () => {
  test("Billing -> Cancel plan -> confirm screen with the consequences -> done, in at most 3 activations", async ({ page }, info) => {
    await signIn(page, billingE2eEmail(info.retry), BILLING_E2E_PASSWORD);
    await page.goto("/billing");

    // Every click or key activation on the way counts as a tap.
    let taps = 0;
    const tap = async (target: Locator) => {
      await target.click();
      taps++;
    };

    await expect(page.getByText("Starter").first()).toBeVisible();
    await tap(page.getByRole("link", { name: "Cancel plan" })); // tap 1

    // The confirm screen says exactly what happens before anything is changed.
    await expect(page).toHaveURL(/\/billing\/cancel$/);
    await expect(page.getByRole("heading", { level: 1, name: "Cancel your Starter plan" })).toBeVisible();
    const main = page.getByRole("main");
    await expect(main).toContainText("Your plan ends");
    await expect(main).toContainText(/Today, .*You move to the Free plan/);
    await expect(main).toContainText("Nothing renews automatically");
    await expect(main).toContainText(`₹${rupees(E2E_EXPECTED_REFUND_PAISE)} including GST`); // pro-rated refund of the unused full months
    await expect(main).toContainText("10 unused months");
    await expect(main).toContainText("Lead credits you keep");
    await expect(main).toContainText("60 credits");
    await expect(main).toContainText(/60 credits expire on/); // 90-day rollover: each lot shows its own expiry
    // The reason is optional, nothing is pre-selected, and there is no retention step.
    const reason = page.getByRole("combobox", { name: /Why are you cancelling\? \(optional\)/ });
    await expect(reason).toHaveValue("");
    await expect(reason).not.toHaveAttribute("required", /.*/);

    await tap(page.getByRole("button", { name: "Yes, cancel my plan" })); // tap 2

    // Done: back on Billing with the result.
    await expect(page).toHaveURL(/\/billing\?cancelled=1/);
    const done = page.getByRole("main");
    await expect(done).toContainText("Your plan is cancelled");
    await expect(done).toContainText(`₹${rupees(E2E_EXPECTED_REFUND_PAISE)} is on its way back to your original payment method`);
    await expect(done).toContainText("lead credits stay usable until they expire");
    expect(taps).toBeLessThanOrEqual(3);
    expect(taps).toBe(2);

    // The plan really changed: no Cancel link any more, and the account is on Free.
    await page.goto("/billing");
    await expect(page.getByRole("link", { name: "Cancel plan" })).toHaveCount(0);
    await page.goto("/billing/cancel");
    await expect(page.getByText("You have no paid plan to cancel.")).toBeVisible();
  });

  test("keeping the plan leaves it untouched", async ({ page }, info) => {
    // Uses the last seeded account; the cancel test above uses accounts by retry index, never the last one (3 accounts, 1 retry).
    await signIn(page, billingE2eEmail(2), BILLING_E2E_PASSWORD);
    await page.goto("/billing/cancel");
    await page.getByRole("link", { name: "Keep my plan" }).click();
    await expect(page).toHaveURL(/\/billing$/);
    await expect(page.getByRole("link", { name: "Cancel plan" })).toBeVisible();
    void info;
  });
});

test.describe("seller pricing calculator and annual plans", () => {
  test("calculator shows GST-inclusive cost, cost per lead and credit expiry; annual option is offered on each paid plan", async ({ page }) => {
    await signIn(page, DEMO.seller.email, DEMO.seller.password);
    await page.goto("/billing");
    const results = page.getByRole("status", { name: "Estimated cost" });
    await page.getByLabel("Leads you expect to accept each month").fill("60");
    await page.getByLabel("Plan", { exact: true }).selectOption({ label: "Pro" });
    await expect(results).toContainText("₹3,538.82 a month including GST");
    await expect(results).toContainText("About ₹58.98 per lead you accept");
    await page.getByRole("radio", { name: /Annual \(save 20%\)/ }).check();
    await expect(results).toContainText("₹33,972.67 once a year including GST");
    await expect(results).toContainText("₹2,831.05 a month");
    await expect(results).toContainText("stay usable for 90 days");

    await expect(page.getByRole("link", { name: "Buy Starter for 12 months" })).toHaveAttribute("href", /\/billing\/checkout\?plan=starter&interval=annual/);
    await page.getByRole("link", { name: "Buy Pro for 12 months" }).click();
    await expect(page.getByText("Pro plan - 12 months")).toBeVisible();
    await expect(page.getByText("Billed once for 12 months")).toBeVisible();
    await expect(page.getByText("Due today")).toBeVisible();
  });
});

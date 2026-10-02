/**
 * Seller billing (ADR-005): cancel in at most 3 taps with the exact consequences shown first, and the in-app pricing
 * calculator. The cancel journey uses sellers seeded on a paid annual plan (e2e/setup/seed-billing.ts), one per attempt.
 */
import { expect, test, type Locator, type Page } from "../support/fixtures";
import { BILLING_E2E_PASSWORD, E2E_EXPECTED_REFUND_PAISE, billingE2eEmail, billingUndoEmail } from "../support/billing";
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
    await expect(main).toContainText(/You keep your plan until then, then move to the Free plan/); // access continues to the end of the used month
    await expect(main).toContainText("Nothing renews automatically");
    await expect(main).toContainText(`₹${rupees(E2E_EXPECTED_REFUND_PAISE)} including GST`); // pro-rated refund of the unused full months
    await expect(main).toContainText("10 unused months");
    await expect(main).toContainText("show its status on Billing");
    await expect(main).toContainText("Lead credits you keep");
    await expect(main).toContainText("60 credits");
    await expect(main).toContainText(/60 credits expire on/); // 90-day rollover: each lot shows its own expiry
    // The reason is optional, nothing is pre-selected, and there is no retention step.
    const reason = page.getByRole("combobox", { name: /Why are you cancelling\? \(optional\)/ });
    await expect(reason).toHaveValue("");
    await expect(reason).not.toHaveAttribute("required", /.*/);

    await tap(page.getByRole("button", { name: "Yes, cancel my plan" })); // tap 2

    // Done: back on Billing with the result. The plan stays active until the end date and the refund status is shown honestly.
    await expect(page).toHaveURL(/\/billing\?cancelled=1/);
    const done = page.getByRole("main");
    await expect(done).toContainText("Your plan is cancelled");
    await expect(done).toContainText(/It stays active until/);
    await expect(done).toContainText(/Ends on /);
    await expect(done).toContainText("lead credits stay usable until they expire");
    await expect(done).toContainText(`Refunded ₹${rupees(E2E_EXPECTED_REFUND_PAISE)}`); // mock provider confirms immediately
    expect(taps).toBeLessThanOrEqual(3);
    expect(taps).toBe(2);

    // Scheduled, not ended: no second cancel, and no undo because money already went back.
    await page.goto("/billing");
    await expect(page.getByRole("link", { name: "Cancel plan" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Undo cancellation" })).toHaveCount(0);
    await expect(page.getByText(/cannot be undone/)).toBeVisible();
    await page.goto("/billing/cancel");
    await expect(page).toHaveURL(/\/billing$/);
  });

  test("undo cancellation is one tap while no refund was started", async ({ page }, info) => {
    await signIn(page, billingUndoEmail(info.retry), BILLING_E2E_PASSWORD);
    await page.goto("/billing");
    await page.getByRole("link", { name: "Cancel plan" }).click();
    await expect(page.getByRole("main")).toContainText("No refund");
    await page.getByRole("button", { name: "Yes, cancel my plan" }).click();
    await expect(page).toHaveURL(/\/billing\?cancelled=1/);
    await expect(page.getByRole("main")).toContainText(/Ends on /);
    await expect(page.getByRole("link", { name: "Cancel plan" })).toHaveCount(0);
    let taps = 0;
    await page.getByRole("button", { name: "Undo cancellation" }).click();
    taps++;
    expect(taps).toBe(1);
    await expect(page).toHaveURL(/\/billing\?undone=1/);
    await expect(page.getByRole("link", { name: "Cancel plan" })).toBeVisible();
    await expect(page.getByText(/Ends on /)).toHaveCount(0);
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

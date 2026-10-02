/**
 * Buyer business account (/account/business): GSTIN verification through the mock GST provider (T1, ADR-003), saved
 * delivery addresses (CRUD, default, state derived from the pincode), the header "Deliver to" picker, the DPDP export,
 * plus axe WCAG 2.2 AA and keyboard operation. Each test signs up its own buyer, so specs stay independent.
 */
import { randomInt } from "node:crypto";
import { gstinCheckChar } from "../../packages/identity/src/gstin";
import { signUpBuyer } from "../support/auth";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { expect, test, type Page } from "../support/fixtures";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const pick = (n: number, chars: string) => Array.from({ length: n }, () => chars[randomInt(chars.length)]).join("");
/**
 * Valid, unique GSTIN. The 13th char "1" keeps the mock provider on its happy path. The default state is 27 (Maharashtra) because
 * signUpBuyer declares Maharashtra for the business: GST verification only passes when the GSTIN's state matches (ADR-003).
 */
function gstin(state = "27"): string {
  const body = `${state}${pick(5, LETTERS)}${pick(4, "0123456789")}${pick(1, LETTERS)}1Z`;
  return body + gstinCheckChar(body);
}

async function open(page: Page) {
  await signUpBuyer(page, "acct");
  await page.goto("/account/business");
  await expect(page.getByRole("heading", { level: 1, name: "Business profile" })).toBeVisible();
  await settle(page);
}

const addressForm = (page: Page) => page.getByRole("form", { name: /delivery address/i });
async function fillAddress(page: Page, a: { label: string; line1: string; city: string; pincode: string; makeDefault?: boolean }) {
  const form = addressForm(page);
  await form.getByLabel("Label").fill(a.label);
  await form.getByLabel("Address line 1").fill(a.line1);
  await form.getByLabel("City").fill(a.city);
  await form.getByLabel("Pincode").fill(a.pincode);
  if (a.makeDefault) await form.getByLabel("Make this my default address").check();
}

test.describe("buyer business profile", () => {
  test("page has no blocking WCAG 2.2 AA violations (empty, with add form open, with errors)", async ({ page }, info) => {
    await open(page);
    await expectNoBlockingViolations(page, info);
    await page.getByRole("button", { name: "Add address" }).click();
    await expect(addressForm(page)).toBeVisible();
    await expectNoBlockingViolations(page, info);
    await addressForm(page).getByRole("button", { name: "Save address" }).click();
    await expect(page.locator("[role=alert]").first()).toBeVisible();
    await expect(addressForm(page).locator("[aria-invalid='true']").first()).toBeVisible();
    await expectNoBlockingViolations(page, info);
  });

  test("GSTIN: rejects a bad number, verifies a good one with the mock provider and shows legal name, state and tier", async ({ page }, info) => {
    await open(page);
    const input = page.getByLabel("GSTIN", { exact: true });
    await input.fill("29ABCDE1234F1Z0");
    await page.getByRole("button", { name: "Verify GSTIN" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /invalid gstin/i })).toBeVisible();
    await expect(input).toHaveAttribute("aria-invalid", "true");

    await input.fill(gstin().toLowerCase());
    await page.getByRole("button", { name: "Verify GSTIN" }).click();
    await expect(page.getByText(/Verified\. .* is registered in Maharashtra\./)).toBeVisible();
    await page.reload();
    await settle(page);
    await expect(page.getByText("GSTIN verified")).toBeVisible();
    const details = page.getByRole("definition");
    await expect(details.filter({ hasText: "E2E Traders" })).toBeVisible();
    await expect(details.filter({ hasText: "Maharashtra" })).toBeVisible();
    await expect(details.filter({ hasText: "Active" })).toBeVisible();
    await expect(details.filter({ hasText: "Tier 1" })).toBeVisible();
    await expectNoBlockingViolations(page, info);
  });

  test("GSTIN: a number from another state than the business is held for staff review, never auto-verified", async ({ page }) => {
    await open(page);
    await page.getByLabel("GSTIN", { exact: true }).fill(gstin("29")); // the business declared Maharashtra
    await page.getByRole("button", { name: "Verify GSTIN" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /our team will review/i }).first()).toBeVisible();
    await page.reload();
    await settle(page);
    await expect(page.getByText("GSTIN verified")).toHaveCount(0);
  });

  test("GSTIN: keyboard only (type, Enter to verify)", async ({ page }) => {
    await open(page);
    await page.getByLabel("GSTIN", { exact: true }).focus();
    await page.keyboard.type(gstin("27"));
    await page.keyboard.press("Enter");
    await expect(page.getByText(/is registered in Maharashtra\./)).toBeVisible();
  });

  test("addresses: add (state derived), second becomes non-default, make default, edit, delete", async ({ page }, info) => {
    await open(page);
    await page.getByRole("button", { name: "Add address" }).click();
    await fillAddress(page, { label: "Warehouse", line1: "12 MG Road", city: "Bengaluru", pincode: "560001" });
    await addressForm(page).getByRole("button", { name: "Save address" }).click();
    await expect(page.getByRole("heading", { name: "Add a delivery address" })).toHaveCount(0);
    const items = page.getByRole("listitem").filter({ hasText: "Bengaluru" });
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText("Karnataka");
    await expect(items.first()).toContainText("560001");
    await expect(items.first().getByText("Default", { exact: true })).toBeVisible();

    // Pincode is validated and the state cannot be forged: an unknown PIN is refused on the pincode field.
    await page.getByRole("button", { name: "Add address" }).click();
    await fillAddress(page, { label: "Bad", line1: "1 Test Street", city: "Nowhere", pincode: "12345" });
    await addressForm(page).getByRole("button", { name: "Save address" }).click();
    await expect(addressForm(page).getByLabel("Pincode")).toHaveAttribute("aria-invalid", "true");
    await addressForm(page).getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Add address" }).click();
    await fillAddress(page, { label: "Office", line1: "4 Marine Drive", city: "Mumbai", pincode: "400001" });
    await addressForm(page).getByRole("button", { name: "Save address" }).click();
    const office = page.getByRole("listitem").filter({ hasText: "Office" });
    await expect(office).toContainText("Maharashtra");
    await expect(office.getByText("Default", { exact: true })).toHaveCount(0);

    await office.getByRole("button", { name: "Make Office the default address" }).click();
    await expect(office.getByText("Default", { exact: true })).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Warehouse" }).getByText("Default", { exact: true })).toHaveCount(0);
    await expectNoBlockingViolations(page, info);

    await office.getByRole("button", { name: "Edit address Office" }).click();
    const form = addressForm(page);
    await form.getByLabel("Label").fill("Head office");
    await form.getByLabel("Pincode").fill("110001");
    await form.getByRole("button", { name: "Save address" }).click();
    const head = page.getByRole("listitem").filter({ hasText: "Head office" });
    await expect(head).toContainText("Delhi");

    await head.getByRole("button", { name: "Delete address Head office" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: "Head office" })).toHaveCount(0);
    // The remaining address is promoted to default.
    await expect(page.getByRole("listitem").filter({ hasText: "Warehouse" }).getByText("Default", { exact: true })).toBeVisible();
  });

  test("addresses: the add form is keyboard operable and Escape-free (Cancel closes it)", async ({ page }) => {
    await open(page);
    const add = page.getByRole("button", { name: "Add address" });
    await add.focus();
    await page.keyboard.press("Enter");
    const form = addressForm(page);
    await expect(form).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(form.getByLabel("Label")).toBeFocused();
    await form.getByRole("button", { name: "Cancel" }).focus();
    await page.keyboard.press("Enter");
    await expect(form).toHaveCount(0);
  });

  test("header Deliver-to picker offers the saved addresses and the data export includes them", async ({ page }) => {
    test.skip(!!test.info().project.name.match(/mobile/), "the header picker is desktop-only");
    await open(page);
    await page.getByRole("button", { name: "Add address" }).click();
    await fillAddress(page, { label: "Plant", line1: "Plot 9, MIDC", city: "Pune", pincode: "411019" });
    await addressForm(page).getByRole("button", { name: "Save address" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: "Plant" })).toBeVisible();

    await page.goto("/");
    await settle(page);
    await page.getByRole("button", { name: /change delivery pincode/i }).click();
    const saved = page.getByRole("button", { name: "Deliver to Plant: Pune 411019" });
    await expect(saved).toBeVisible();
    await saved.click();
    await expect(page.getByRole("button", { name: /Deliver to 411019, change delivery pincode/ })).toBeVisible();

    const res = await page.request.get("/account/export");
    expect(res.status()).toBe(200);
    const data = (await res.json()) as { deliveryAddresses: { label: string; pincode: string }[] };
    expect(data.deliveryAddresses).toEqual([expect.objectContaining({ label: "Plant", pincode: "411019" })]);
  });

  test("the account page links to the business profile", async ({ page }) => {
    await signUpBuyer(page, "acct-link");
    await page.goto("/account");
    await page.getByRole("link", { name: "Manage business profile" }).click();
    await expect(page).toHaveURL(/\/account\/business$/);
  });
});

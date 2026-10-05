/**
 * Buyer team + approvals (docs/design/buyer-approvals.md): /account/team, /account/approvals, /buyer/approvals.
 * axe WCAG 2.2 AA in English and Hindi, keyboard operation of the invite form and rule builder. Each test signs up its own buyer
 * (the sole owner), so the screens render their empty and owner states without extra seed data.
 */
import { signUpBuyer } from "../support/auth";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { expect, test, type Page } from "../support/fixtures";

async function open(page: Page, path: string, heading: RegExp) {
  await signUpBuyer(page, "appr");
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  await settle(page);
}

test.describe("buyer team and approvals", () => {
  test("team page has no blocking violations and the invite form is operable by keyboard", async ({ page }, info) => {
    await open(page, "/account/team", /^Team$/);
    await expectNoBlockingViolations(page, info);
    const email = page.getByLabel("Email address");
    await email.focus();
    await page.keyboard.type("colleague@example.test");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Role", { exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Send invitation" })).toBeFocused();
  });

  test("an invalid email is announced on the field", async ({ page }, info) => {
    await open(page, "/account/team", /^Team$/);
    await page.getByLabel("Email address").fill("not-an-email");
    await page.getByRole("button", { name: "Send invitation" }).click();
    await expect(page.locator("[role=alert]").first()).toBeVisible();
    await expectNoBlockingViolations(page, info);
  });

  test("rules page: empty, with the rule builder open, and with a step added", async ({ page }, info) => {
    await open(page, "/account/approvals", /^Approval rules$/);
    await expectNoBlockingViolations(page, info);
    await page.getByRole("button", { name: "Add a rule" }).click();
    const form = page.getByRole("form", { name: "New rule" });
    await expect(form).toBeVisible();
    await form.getByRole("button", { name: "Add a step" }).click();
    await expect(form.getByLabel("Step 2: role")).toBeVisible();
    await expectNoBlockingViolations(page, info);
    await form.getByLabel("Rule name").fill("Quotes over 50k");
    await form.getByLabel("Needs approval from (₹)").fill("50000");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Quotes over 50k").first()).toBeVisible();
    await expectNoBlockingViolations(page, info);
  });

  test("approvals inbox: every tab renders without violations", async ({ page }, info) => {
    await open(page, "/buyer/approvals", /^Approvals$/);
    await expectNoBlockingViolations(page, info);
    await page.getByRole("link", { name: "My requests" }).click();
    await expect(page.getByText(/not asked for any approval/i).first()).toBeVisible();
    await expectNoBlockingViolations(page, info);
  });

  test("Hindi: team and inbox pages have no blocking violations", async ({ page, context }, info) => {
    await context.addCookies([{ name: "cnote_locale", value: "hi", url: "http://localhost:3000" }]);
    await signUpBuyer(page, "apprhi");
    for (const path of ["/account/team", "/account/approvals", "/buyer/approvals"]) {
      await page.goto(path);
      await settle(page);
      await expect(page.locator("html")).toHaveAttribute("lang", /hi/);
      await expectNoBlockingViolations(page, info);
    }
  });
});

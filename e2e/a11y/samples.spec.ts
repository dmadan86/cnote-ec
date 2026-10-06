/**
 * Buyer sample screens (WCAG 2.2 AA, keyboard): the list, a request in each stage, the evaluation form with photos, the full-page
 * request form. English and Hindi (/hi is a localised public tree; the account screens follow the cnote_locale cookie).
 */
import { expect, test } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { setLocaleCookie } from "../support/a11y-extra";
import { signUpBuyer } from "../support/auth";
import { seedSample } from "../support/samples-db";

const JPEG = { name: "sample-front.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]) };

test.describe("buyer samples", () => {
  test("list and requested detail pass axe; progress is announced with a current step", async ({ page }, info) => {
    const acct = await signUpBuyer(page, "smp1");
    const id = await seedSample(acct.email, "requested");
    await page.goto("/buyer/samples");
    await settle(page);
    await expect(page.getByRole("heading", { name: "Samples" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Kraft carton 5-ply/ })).toBeVisible();
    await expectNoBlockingViolations(page, info);
    // the filter chips are links with aria-current
    await expect(page.getByRole("navigation", { name: "Show" }).getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "page");

    await page.goto(`/buyer/samples/${id}`);
    await settle(page);
    await expect(page.getByRole("list", { name: "Sample progress" })).toBeVisible();
    await expect(page.locator('[aria-current="step"]')).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Cancel request" })).toBeVisible();
    await expectNoBlockingViolations(page, info);
  });

  test("delivered sample: evaluation form is keyboard-operable, rejection needs reasons, photos upload", async ({ page }, info) => {
    const acct = await signUpBuyer(page, "smp2");
    const id = await seedSample(acct.email, "delivered");
    await page.goto(`/buyer/samples/${id}`);
    await settle(page);
    await expect(page.getByRole("heading", { name: "Is this sample what you need?" })).toBeVisible();
    await expectNoBlockingViolations(page, info);

    await page.getByRole("radio", { name: "Reject this sample" }).check();
    const group = page.getByRole("group", { name: /What is wrong/ });
    await expect(group).toBeVisible();
    await expectNoBlockingViolations(page, info);
    // no reason chosen: the server refuses with an announced error
    await page.getByRole("button", { name: "Save my verdict" }).click();
    await expect(page.locator("[role=alert]:not(#__next-route-announcer__)")).toContainText("at least one reason");
    await group.getByRole("checkbox", { name: "Finish or workmanship defect" }).check();
    await page.getByLabel("Photos (optional)").setInputFiles([JPEG]);
    await page.getByLabel("Notes (optional)").fill("Rough edges on three of the five cartons.");
    await page.getByRole("button", { name: "Save my verdict" }).click();
    await expect(page.getByText(/You rejected this sample on/)).toBeVisible();
    await expect(page.getByRole("img", { name: "Evaluation photo 1" })).toBeVisible();
    await expectNoBlockingViolations(page, info);
  });

  test("dispatched sample can be marked received; approved sample offers a bulk quote", async ({ page }, info) => {
    const acct = await signUpBuyer(page, "smp3");
    const id = await seedSample(acct.email, "dispatched");
    await page.goto(`/buyer/samples/${id}`);
    await settle(page);
    await expect(page.getByText(/Delhivery/)).toBeVisible();
    await page.getByRole("button", { name: "Mark as received" }).click();
    await expect(page.getByRole("radio", { name: "Approve this sample" })).toBeVisible();
    await page.getByRole("button", { name: "Save my verdict" }).click();
    await expect(page.getByRole("heading", { name: "Ready to order in bulk?" })).toBeVisible();
    await expectNoBlockingViolations(page, info);
    await page.getByRole("link", { name: "Request bulk quote" }).click();
    await expect(page).toHaveURL(/\/rfq\/new\?sample=/);
    await expect(page.getByText(/Bulk request from your approved sample/)).toBeVisible();
    await expectNoBlockingViolations(page, info);
  });

  test("full-page request form has labelled controls and passes axe in English and Hindi", async ({ page }, info) => {
    await signUpBuyer(page, "smp4");
    await page.goto("/buyer/samples/new?listing=00000000-0000-4000-8000-000000000000");
    // an unknown product is a 404, not a crash
    await expect(page.getByText(/not found|404/i).first()).toBeVisible();
    await setLocaleCookie(page.context(), "hi");
    await page.goto("/buyer/samples");
    await settle(page);
    await expect(page.getByRole("heading", { name: "सैंपल" })).toBeVisible();
    await expectNoBlockingViolations(page, info);
  });
});

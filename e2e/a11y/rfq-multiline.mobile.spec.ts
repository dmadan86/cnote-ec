/** Multi-line RFQ on a phone (412x915): lines are stacked cards with 44px controls, the matrix becomes one card per line, no sideways page scroll. */
import { expect, test } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { signUpBuyer } from "../support/auth";
import { seedLineQuotes } from "../support/rfq-lines-db";

test("lines are stacked cards and the matrix is one card per line (axe, 44px targets)", async ({ page }, info) => {
  await signUpBuyer(page, "bommobile");
  await page.goto("/rfq/new");
  await settle(page);
  await page.getByRole("textbox", { name: "What do you need?" }).fill("Fasteners for assembly line four");
  await page.getByRole("textbox", { name: "Requirement details" }).fill("Monthly fasteners for line four, stainless, delivery in Pune.");
  await page.getByRole("radio", { name: "Several items (bill of materials)" }).check();
  await page.getByLabel("Item name *").first().fill("Bolt");
  await page.getByLabel("Quantity *").first().fill("500");
  await page.getByRole("button", { name: "Add another line" }).click();
  await page.getByLabel("Item name *").nth(1).fill("Nut");
  await page.getByLabel("Quantity *").nth(1).fill("500");
  await page.getByRole("button", { name: "Add another line" }).click();
  await page.getByLabel("Item name *").nth(2).fill("Washer");
  await page.getByLabel("Quantity *").nth(2).fill("1000");

  const cards = page.getByTestId("bom-editor").getByRole("group", { name: /^Line \d$/ });
  await expect(cards).toHaveCount(3);
  for (const name of ["Move line 2 up", "Move line 2 down", "Remove line 2"]) {
    expect((await page.getByRole("button", { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoBlockingViolations(page, info);

  await page.getByRole("button", { name: "Post requirement" }).click();
  const link = page.getByRole("link", { name: "View requirement" });
  await expect(link).toBeVisible();
  const id = (await link.getAttribute("href"))!.split("/").pop()!;
  await seedLineQuotes(id);

  await page.goto(`/buyer/enquiries/${id}`);
  await settle(page);
  const matrix = page.getByTestId("line-matrix");
  await expect(matrix.getByRole("table")).toBeHidden();
  await expect(matrix.getByRole("group", { name: /^\d\. / })).toHaveCount(3);
  const radio = matrix.getByRole("radio", { name: /^Award line 1 \(Bolt\)/ }).first();
  await radio.check();
  expect((await matrix.locator("label", { has: radio }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoBlockingViolations(page, info);
});

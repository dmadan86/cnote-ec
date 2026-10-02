/** Quote comparison on a phone (412x915): stacked, swipeable cards instead of the table; 44px targets; no sideways page scroll. */
import { expect, test } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { signUpBuyer } from "../support/auth";
import { seedQuotes } from "../support/rfq-db";

test("quotes show as swipeable cards, with 44px actions, and pass axe", async ({ page }, info) => {
  await signUpBuyer(page, "cmpmobile");
  await page.goto("/rfq/new");
  await page.getByRole("textbox", { name: "What do you need?" }).fill("Printed 3 ply corrugated boxes");
  await page.getByRole("textbox", { name: "Requirement details" }).fill("3 ply corrugated shipping boxes, 12x10x8 inch, printed logo, delivery in Pune.");
  await page.getByRole("combobox", { name: "Category" }).selectOption({ label: "Packaging & Printing" });
  await page.getByRole("spinbutton", { name: "Quantity" }).fill("500");
  await page.getByRole("button", { name: "Post requirement" }).click();
  const link = page.getByRole("link", { name: "View requirement" });
  await expect(link).toBeVisible();
  const id = (await link.getAttribute("href"))!.split("/").pop()!;
  const { a, b } = await seedQuotes(id);

  await page.goto(`/buyer/enquiries/${id}`);
  await settle(page);
  await expect(page.getByRole("table")).toBeHidden();
  const cards = page.getByTestId("quote-card");
  await expect(cards).toHaveCount(2);
  await expect(page.getByText("Swipe sideways to move between quotes")).toBeVisible();
  await expect(cards.first()).toContainText(/Quote 1 of 2/);

  // swipe strip: the second card is off screen until the Next button (or a swipe) brings it in
  const strip = page.getByRole("region", { name: /Quotes received for this requirement/ });
  await expect(strip).toHaveAttribute("tabindex", "0");
  await page.getByRole("button", { name: "Next quote" }).click();
  await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(50);

  for (const name of [`Accept quote from ${a.sellerName}`, `Shortlist quote from ${b.sellerName}`, `Message ${a.sellerName}`]) {
    const el = page.getByRole(name.startsWith("Message") ? "link" : "button", { name }).first();
    await el.scrollIntoViewIfNeeded();
    expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expectNoBlockingViolations(page, info);
});

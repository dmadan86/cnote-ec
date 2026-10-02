/** Product page on a phone (412x915): the sticky CTA bar, and its coexistence with the cookie banner. */
import { expect, test } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { firstProductHref } from "../support/pages";

test("sticky bar shows while the in-page buttons are off screen, reserves space and passes axe", async ({ page }, info) => {
  await page.goto(await firstProductHref(page, "en", "Custom Packaging Boxes"));
  await settle(page);
  const bar = page.getByRole("region", { name: "Quick actions" });
  await page.getByTestId("pdp-slabs").scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 900);
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button", { name: "Get best price" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Request quote" })).toBeVisible();
  const vp = page.viewportSize()!;
  const box = (await bar.boundingBox())!;
  expect(box.y + box.height).toBeCloseTo(vp.height, 0); // pinned to the bottom
  for (const name of ["Get best price", "Request quote"]) expect((await bar.getByRole("button", { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // The end of the page is not hidden behind it.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const bodyPad = await page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingBottom));
  expect(bodyPad).toBeGreaterThanOrEqual(box.height - 1);
  await expectNoBlockingViolations(page, info);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test.describe("with the cookie banner", () => {
  test.use({ consent: false });

  test("the bar sits above the banner and neither covers the other", async ({ page }) => {
    await page.goto(await firstProductHref(page, "en", "Custom Packaging Boxes"));
    await settle(page);
    await page.mouse.wheel(0, 900);
    const bar = page.getByRole("region", { name: "Quick actions" });
    const banner = page.getByRole("region", { name: "Cookie notice" });
    await expect(bar).toBeVisible();
    await expect(banner).toBeVisible();
    const b = (await bar.boundingBox())!;
    const c = (await banner.boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(c.y + 1);
  });
});

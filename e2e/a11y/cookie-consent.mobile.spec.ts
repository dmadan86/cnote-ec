/** Cookie consent on a phone (412x915): touch targets, the banner leaves the page usable, dialog fits the viewport. */
import { expect, test } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";

test.use({ consent: false });

test("banner buttons are 44px targets, the banner stays compact, and the dialog fits the screen", async ({ page }, info) => {
  await page.goto("/");
  await settle(page);
  const banner = page.getByRole("region", { name: "Cookie notice" });
  await expect(banner).toBeVisible();
  const vp = page.viewportSize()!;
  const box = (await banner.boundingBox())!;
  expect(box.height).toBeLessThan(vp.height * 0.4); // leaves most of the screen to the page
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  for (const name of ["Accept all", "Reject all", "Customise"]) {
    const b = (await banner.getByRole("button", { name }).boundingBox())!;
    expect(b.height, name).toBeGreaterThanOrEqual(44);
    expect(b.width, name).toBeGreaterThanOrEqual(44);
  }
  await expectNoBlockingViolations(page, info);

  await banner.getByRole("button", { name: "Customise" }).click();
  const d = page.getByRole("dialog", { name: "Cookie preferences" });
  await expect(d).toBeVisible();
  const db = (await d.boundingBox())!;
  expect(db.x).toBeGreaterThanOrEqual(0);
  expect(db.x + db.width).toBeLessThanOrEqual(vp.width);
  expect(db.height).toBeLessThanOrEqual(vp.height);
  for (const name of ["Analytics", "Marketing and attribution"]) {
    const s = (await d.getByRole("switch", { name }).boundingBox())!;
    expect(s.height, name).toBeGreaterThanOrEqual(44);
    expect(s.width, name).toBeGreaterThanOrEqual(44);
  }
  await d.getByRole("button", { name: "Analytics" }).click();
  await expectNoBlockingViolations(page, info);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); // no horizontal page scroll
});

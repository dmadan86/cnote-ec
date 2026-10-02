/**
 * Product detail page: lightbox (axe + keyboard), share copy-link, quantity slabs. The sticky mobile bar needs the mobile
 * project, so it lives in pdp.mobile.spec.ts. Seed: every other template has slabs and trade info (apps/worker/src/seed.ts),
 * "Custom Packaging Boxes" is one of them.
 */
import { expect, test } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { firstProductHref } from "../support/pages";

async function openTieredProduct(page: import("@playwright/test").Page) {
  await page.goto(await firstProductHref(page, "en", "Custom Packaging Boxes"));
  await settle(page);
  await expect(page.getByTestId("pdp-slabs")).toBeVisible();
}

test.describe("product page: slabs", () => {
  test("quantity defaults to the MOQ and the active slab follows the quantity", async ({ page }) => {
    await openTieredProduct(page);
    const qty = page.getByTestId("pdp-qty");
    const active = page.locator('[data-testid="pdp-slabs"] tr[data-active="true"]');
    await expect(active).toHaveCount(1);
    await expect(active).toContainText("Your tier");
    const firstRow = await active.innerText();
    const moq = Number(await qty.inputValue());
    expect(moq).toBeGreaterThan(0);
    // 5x MOQ is the second slab in the seed, 20x the third.
    await qty.fill(String(moq * 5));
    await expect(active).not.toHaveText(firstRow);
    const second = await active.innerText();
    await qty.fill(String(moq * 20));
    await expect(active).not.toHaveText(second);
    await expect(page.getByTestId("pdp-estimate")).toContainText("excl. GST");
    await qty.fill("abc");
    await expect(page.getByText("Enter a whole number of 1 or more.")).toBeVisible();
  });
});

test.describe("product page: lightbox", () => {
  test("opens a labelled modal dialog that passes axe, and the keyboard drives it", async ({ page }, info) => {
    await openTieredProduct(page);
    const thumbs = page.getByRole("list", { name: "Product images" }).getByRole("button");
    const total = await thumbs.count();
    await page.getByRole("button", { name: /^View image 1 of \d+ full screen$/ }).click();
    const dlg = page.getByRole("dialog", { name: /^Image viewer:/ });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole("button", { name: "Close image viewer" })).toBeFocused();
    await expectNoBlockingViolations(page, info);

    await expect(dlg.getByText(`Image 1 of ${total}`)).toBeVisible();
    if (total > 1) {
      await page.keyboard.press("ArrowRight");
      await expect(dlg.getByText(`Image 2 of ${total}`)).toBeVisible();
      await page.keyboard.press("ArrowLeft");
      await expect(dlg.getByText(`Image 1 of ${total}`)).toBeVisible();
      await page.keyboard.press("ArrowLeft"); // wraps
      await expect(dlg.getByText(`Image ${total} of ${total}`)).toBeVisible();
    }
    const zoom = dlg.getByTestId("lightbox-zoom");
    await expect(zoom).toHaveAttribute("data-scale", "1");
    await page.keyboard.press("+");
    await expect(zoom).toHaveAttribute("data-scale", "1.5");
    await dlg.getByRole("button", { name: "Zoom in" }).click();
    await expect(zoom).toHaveAttribute("data-scale", "2");
    await dlg.getByRole("button", { name: "Reset zoom" }).click();
    await expect(zoom).toHaveAttribute("data-scale", "1");

    // Focus stays inside the modal (native trap), Escape closes and returns focus to the opener.
    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("dialog"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    await expect(page.getByRole("button", { name: /^View image \d+ of \d+ full screen$/ })).toBeFocused();
  });
});

test.describe("product page: share and report", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("copy link puts the canonical url on the clipboard and announces it", async ({ page }) => {
    await openTieredProduct(page);
    await page.getByRole("button", { name: "Share" }).click();
    await expect(page.getByRole("link", { name: "WhatsApp" })).toHaveAttribute("href", /^https:\/\/wa\.me\/\?text=/);
    await expect(page.getByRole("link", { name: "Email" })).toHaveAttribute("href", /^mailto:\?subject=/);
    await page.getByRole("button", { name: "Copy link" }).click();
    await expect(page.getByTestId("share-status")).toHaveText("Link copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/p\/.+/);
  });

  test("report link carries the canonical url", async ({ page }) => {
    await openTieredProduct(page);
    const href = await page.getByRole("link", { name: "Report this listing" }).getAttribute("href");
    expect(href).toMatch(/\/report\?url=https?%3A%2F%2F.+%2Fp%2F/);
  });
});

/**
 * Mobile viewport (Pixel 7, touch): axe scans in the narrow layout (reflow, target size 2.5.8), 44px touch targets for
 * the header controls (CLAUDE.md: "targets of at least 24px (44px on mobile)"), and the menu dialog's focus handling.
 */
import { expect, test } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { CATEGORY_SLUG, firstProductHref } from "../support/pages";

const pages = [
  { name: "home", path: "/" },
  { name: "home (hi)", path: "/hi" },
  { name: "search", path: "/search?q=box" },
  { name: "category", path: `/c/${CATEGORY_SLUG}` },
  { name: "pricing", path: "/pricing" },
  { name: "sign in", path: "/signin" },
  { name: "sign up", path: "/signup" },
];

test.describe("axe on mobile", () => {
  for (const p of pages) {
    test(p.name, async ({ page }, info) => {
      await page.goto(p.path);
      await settle(page);
      await expectNoBlockingViolations(page, info);
    });
  }

  test("product page", async ({ page }, info) => {
    await page.goto(await firstProductHref(page));
    await settle(page);
    await expectNoBlockingViolations(page, info);
  });

  test("no horizontal scroll at 412px (WCAG 1.4.10 reflow)", async ({ page }) => {
    for (const path of ["/", "/search?q=box", "/pricing"]) {
      await page.goto(path);
      await settle(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} scrolls horizontally`).toBeLessThanOrEqual(1);
    }
  });
});

test.describe("touch targets", () => {
  test("header controls are at least 44x44 CSS px", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    const header = page.getByRole("banner");
    for (const name of [/open menu/i, /^search$/i]) {
      const box = await header.getByRole(/menu/i.test(String(name)) ? "button" : "link", { name }).boundingBox();
      expect(box, String(name)).not.toBeNull();
      expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(44);
      expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(44);
    }
  });

  test("every visible button/link in main is at least 24x24 unless it is an inline text link", async ({ page }) => {
    for (const path of ["/", "/search?q=box", "/pricing"]) {
      await page.goto(path);
      await settle(page);
      const small = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>("main a[href], main button, main input:not([type=hidden]), main select, main textarea, main [role=button]")) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          // Inline links inside a sentence are exempt from WCAG 2.5.8.
          const inline = el.tagName === "A" && getComputedStyle(el).display === "inline" && !!el.closest("p, li");
          if (!inline && (r.width < 24 || r.height < 24)) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
        return out;
      });
      expect(small, path).toEqual([]);
    }
  });
});

test.describe("mobile menu dialog", () => {
  test("opens as a modal, traps Tab inside, closes on Escape and returns focus to the opener", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    const opener = page.getByRole("button", { name: "Open menu" });
    // Keyboard activation also covers keyboard-only users.
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    // Focus starts inside the dialog and never escapes it, forwards or backwards.
    for (const key of [...Array(14).fill("Tab"), ...Array(5).fill("Shift+Tab")]) {
      await page.keyboard.press(key);
      expect(await dialog.evaluate((d) => d.contains(document.activeElement)), `after ${key}`).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("expanding a section with Enter reveals its links", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await page.getByRole("button", { name: "Open menu" }).focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    const summary = dialog.locator("summary", { hasText: "Products" });
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("link", { name: "All products" })).toBeVisible();
  });
});

/**
 * Keyboard operability (WCAG 2.1.1, 2.4.1, 2.4.3, 2.4.7, 2.1.2): skip link, visible focus, popover menus, no focus traps.
 * Desktop project only; the mobile dialog is covered in mobile.mobile.spec.ts.
 */
import { expect, test, type Locator, type Page } from "../support/fixtures";
import { settle } from "../support/a11y";

const SKIP_LABEL = { "/": "Skip to main content", "/hi": /मुख्य|सामग्री/ } as const;

async function activeSummary(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 60),
      outlineW: parseFloat(cs.outlineWidth) || 0,
      outlineStyle: cs.outlineStyle,
      shadow: cs.boxShadow,
      inViewport: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
    };
  });
}

for (const path of ["/", "/hi"] as const) {
  test.describe(`keyboard ${path === "/" ? "en" : "hi"}`, () => {
    test("skip link is the first stop, becomes visible, and moves focus to main", async ({ page }) => {
      await page.goto(path);
      await settle(page);
      await page.keyboard.press("Tab");
      const skip = page.getByRole("link", { name: SKIP_LABEL[path] }).first();
      await expect(skip).toBeFocused();
      await expect(skip).toBeInViewport({ ratio: 1 });
      const box = await skip.boundingBox();
      expect(box!.width).toBeGreaterThan(40);
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/#main$/);
      // The target must exist, and the next Tab must land inside it (not back in the header).
      await expect(page.locator("#main")).toHaveCount(1);
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("#main, main"))).toBe(true);
    });

    test("every stop of the first 15 Tab presses shows a visible focus indicator", async ({ page }) => {
      await page.goto(path);
      await settle(page);
      const problems: string[] = [];
      for (let i = 0; i < 15; i++) {
        await page.keyboard.press("Tab");
        const a = await activeSummary(page);
        if (!a) continue;
        const hasIndicator = (a.outlineStyle !== "none" && a.outlineW > 0) || (a.shadow !== "none" && a.shadow !== "");
        if (!hasIndicator) problems.push(`${a.tag} "${a.name}" has no focus indicator`);
        if (!a.inViewport && i > 0) problems.push(`${a.tag} "${a.name}" received focus but is not on screen (WCAG 2.4.11)`);
      }
      expect(problems).toEqual([]);
    });
  });
}

test.describe("header menus (desktop)", () => {
  test("navigation popover opens with Enter, is reachable by Tab, closes with Escape and restores focus", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    const nav = page.getByRole("navigation", { name: "Primary" });
    const trigger = nav.getByRole("button", { name: "Products" });
    await trigger.focus();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const panelId = await trigger.getAttribute("aria-controls");
    const panel = page.locator(`[id="${panelId}"]`);
    await expect(panel).toBeVisible();
    await page.keyboard.press("Tab");
    expect(await panel.evaluate((p) => p.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("tabbing out of an open menu closes it (no orphaned open panels)", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    const nav = page.getByRole("navigation", { name: "Primary" });
    const trigger = nav.getByRole("button", { name: "Products" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    // Walk forward past the panel's links to the next menu.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      if ((await trigger.getAttribute("aria-expanded")) === "false") break;
    }
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("delivery pincode popover is keyboard operable and validates with an announced error", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    const opener = page.getByRole("button", { name: /change delivery pincode/i });
    await opener.focus();
    await page.keyboard.press("Enter");
    const input = page.getByRole("textbox", { name: "Delivery pincode" });
    await expect(input).toBeVisible();
    await input.fill("12");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Enter a valid 6-digit pincode.")).toBeVisible();
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await page.keyboard.press("Escape");
    await expect(input).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("language switcher is a labelled native select with lang on options", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    const select = page.getByRole("combobox", { name: /language/i }).first();
    await select.focus();
    await expect(select).toBeFocused();
    await expect(select.locator("option[lang]")).not.toHaveCount(0);
  });

  test("no keyboard trap: 60 Tab presses leave the page and Shift+Tab walks back", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press("Tab");
      seen.add(await page.evaluate(() => { const e = document.activeElement as HTMLElement; return `${e.tagName}:${e.getAttribute("href") ?? e.getAttribute("aria-label") ?? e.textContent?.slice(0, 30)}`; }));
    }
    // A trap would keep re-visiting a small cycle.
    expect(seen.size).toBeGreaterThan(20);
    const before = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80));
    await page.keyboard.press("Shift+Tab");
    const after = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80));
    expect(after).not.toBe(before);
  });
});

/** Helper kept for specs that need to assert focus landed inside a container. */
export async function focusIsWithin(container: Locator): Promise<boolean> {
  return container.evaluate((c) => c.contains(document.activeElement));
}

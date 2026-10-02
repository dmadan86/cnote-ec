/**
 * Supplier trust evidence (ADR-003): axe scans of the rich supplier profile and every tab (reached by keyboard), the
 * "What's verified" disclosure on the product page, and the compare table with "Highlight differences".
 * Ids come from the UI (search -> product -> View profile) so the spec does not hard-code seed rows.
 */
import { expect, test, type Page } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { firstProductHref } from "../support/pages";

const TABS = ["About", "Products", "Reviews", "Verification"] as const;

async function supplierProfileHref(page: Page): Promise<string> {
  await page.goto(await firstProductHref(page));
  await settle(page);
  const link = page.getByRole("link", { name: "View profile" }).first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  if (!href) throw new Error("no View profile link on the product page");
  return href;
}

test.describe("product page seller card", () => {
  test("What's verified is a keyboard-operable disclosure and the page stays axe clean when open", async ({ page }, info) => {
    await page.goto(await firstProductHref(page));
    await settle(page);
    const button = page.getByRole("button", { name: /What's verified/ }).first();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("aria-expanded", "true");
    const panel = page.locator(`#${await button.getAttribute("aria-controls")}`);
    await expect(panel).toBeVisible();
    // Status is stated in text, not by colour or icon alone.
    await expect(panel.getByText(/Passed|Not completed/).first()).toBeVisible();
    await expectNoBlockingViolations(page, info);
    await page.keyboard.press("Space");
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(panel).toBeHidden();
  });

  test("shows response metrics or New supplier, never a bare number without a sample", async ({ page }) => {
    await page.goto(await firstProductHref(page));
    await settle(page);
    const card = page.locator("main").getByText("Response time").first().locator("xpath=ancestor::dl[1]");
    await expect(card).toContainText(/New supplier|minute|hour|day|No replies yet/);
  });
});

test.describe("supplier profile", () => {
  test("is axe clean and exposes the header actions", async ({ page }, info) => {
    await page.goto(await supplierProfileHref(page));
    await settle(page);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Scoped to the profile actions: the site header has its own (unprefilled) Request quote link.
    const actions = page.getByRole("group", { name: "Supplier actions" });
    await expect(actions.getByRole("link", { name: "Request quote" })).toHaveAttribute("href", /\/rfq\/new\?seller=[0-9a-f-]{36}$/);
    await expect(actions.getByRole("link", { name: "Report" })).toHaveAttribute("href", /\/report\?url=/);
    await expect(actions.getByRole("button", { name: "Share" })).toBeVisible();
    await expectNoBlockingViolations(page, info);
  });

  test("tabs follow the ARIA pattern: arrow keys move and activate, hash is kept, each tab is axe clean", async ({ page }, info) => {
    await page.goto(await supplierProfileHref(page));
    await settle(page);
    const list = page.getByRole("tablist");
    await expect(list.getByRole("tab")).toHaveCount(4);
    const first = list.getByRole("tab").first();
    await first.focus();
    await expect(first).toHaveAttribute("aria-selected", "true");

    for (let i = 0; i < TABS.length; i++) {
      const tab = list.getByRole("tab", { name: new RegExp(`^${TABS[i]}`) });
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(tab).toBeFocused();
      // The first tab is the default (no hash yet); every keyboard activation writes the hash.
      if (i > 0) await expect(page).toHaveURL(new RegExp(`#${TABS[i]!.toLowerCase()}$`));
      const panel = page.getByRole("tabpanel");
      await expect(panel).toBeVisible();
      await expectNoBlockingViolations(page, info);
      if (i < TABS.length - 1) await page.keyboard.press("ArrowRight");
    }
    // Verification evidence: dated checks in text and an explainer link.
    await expect(page.getByRole("link", { name: "How verification works" })).toHaveAttribute("href", /\/trust$/);
    await page.keyboard.press("Home");
    await expect(list.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await expect(list.getByRole("tab").last()).toHaveAttribute("aria-selected", "true");
  });

  test("a deep link to #verification opens that tab", async ({ page }) => {
    const href = await supplierProfileHref(page);
    await page.goto(`${href}#verification`);
    await settle(page);
    await expect(page.getByRole("tab", { name: "Verification" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toContainText(/Passed|Not completed/);
  });

  test("category filter chips are toggle buttons that announce the result count", async ({ page }) => {
    await page.goto(`${await supplierProfileHref(page)}#products`);
    await settle(page);
    const chips = page.getByRole("group", { name: "Filter products by category" }).getByRole("button");
    if ((await chips.count()) < 2) test.skip(true, "supplier has a single category: filter chips are not rendered");
    await chips.nth(1).click();
    await expect(chips.nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("status").filter({ hasText: /Showing/ })).toHaveText(/Showing \d+ product/);
  });
});

test.describe("compare", () => {
  async function compareHref(page: Page): Promise<string | null> {
    await page.goto("/search?q=box");
    const hrefs = await page.locator("main a[href*='/p/']").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""));
    const ids = [...new Set(hrefs.map((h) => h.slice(-36)))].filter((id) => /^[0-9a-f-]{36}$/.test(id)).slice(0, 3);
    return ids.length >= 2 ? `/compare?ids=${ids.join(",")}` : null;
  }

  test("shows supplier rows and a Highlight differences switch that toggles the highlight; axe clean both ways", async ({ page }, info) => {
    const href = await compareHref(page);
    test.skip(!href, "need two seeded products in one category");
    await page.goto(href!);
    await settle(page);
    const table = page.getByRole("table");
    for (const row of ["Verification", "Location", "Response time", "Lead accept rate", "Supplier rating", "Years on platform"]) {
      await expect(table.getByRole("rowheader", { name: new RegExp(row) })).toBeVisible();
    }
    const toggle = page.getByRole("switch", { name: "Highlight differences" });
    await expect(toggle).toBeChecked();
    await expect(page.locator("[data-highlight]").first()).toHaveAttribute("data-highlight", "true");
    await expectNoBlockingViolations(page, info);
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).not.toBeChecked();
    await expect(page.locator("[data-highlight]").first()).toHaveAttribute("data-highlight", "false");
    await expectNoBlockingViolations(page, info);
  });
});

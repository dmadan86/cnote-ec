/**
 * Search filters, facets and sort on /search and /c/[slug] (docs/design/search-filters.md): axe WCAG 2.2 AA with the mobile
 * sheet open, URL-driven state (apply, chips, clear all), sort order, keyboard operation and the opt-in delivery filter.
 * Runs in the desktop project; the mobile sheet is exercised by resizing the viewport.
 */
import { expect, test, type Page } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { CATEGORY_SLUG } from "../support/pages";

const PHONE = { width: 390, height: 844 };

/** Result cards: product links inside main (sponsored cards are labelled and excluded by the /p/ path of organic cards only). */
const cards = (page: Page) => page.locator("main ul > li:has(a[href*='/p/'])");

/** Navigations from GET forms resolve the URL before the new results render: wait for cards before reading them. */
async function ready(page: Page) {
  await expect(cards(page).first()).toBeVisible();
}

async function hrefs(page: Page): Promise<string[]> {
  return page.locator("main ul > li a[href*='/p/']").evaluateAll((as) => [...new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!))]);
}

/** First ₹ amount of each card, or null for "price on request". */
async function prices(page: Page): Promise<(number | null)[]> {
  const texts = await cards(page).evaluateAll((lis) => lis.map((li) => li.textContent ?? ""));
  return texts.map((t) => {
    const m = /₹\s?([\d,]+(?:\.\d+)?)/.exec(t);
    return m ? Number(m[1]!.replace(/,/g, "")) : null;
  });
}

for (const locale of ["en", "hi"] as const) {
  const prefix = locale === "hi" ? "/hi" : "";
  test.describe(`filters ${locale}`, () => {
    test("desktop sidebar has no blocking axe violations", async ({ page }, info) => {
      await page.goto(`${prefix}/search?q=box`);
      await settle(page);
      await expect(page.getByRole("complementary", { name: locale === "hi" ? "फ़िल्टर" : "Filters" })).toBeVisible();
      await expectNoBlockingViolations(page, info);
    });

    test("mobile: Filters opens an accessible dialog (axe with the sheet open), Esc closes it and focus returns", async ({ page }, info) => {
      await page.setViewportSize(PHONE);
      await page.goto(`${prefix}/search?q=box`);
      await settle(page);
      const open = page.getByRole("button", { name: locale === "hi" ? /^फ़िल्टर/ : /^Filters/ });
      await expect(open).toBeVisible();
      expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await open.click();
      const dialog = page.getByRole("dialog", { name: locale === "hi" ? "नतीजे फ़िल्टर करें" : "Filter results" });
      await expect(dialog).toBeVisible();
      await expectNoBlockingViolations(page, info);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(open).toBeFocused();
    });
  });
}

test("applying a minimum tier filter updates the URL and the results, shows a chip, and Clear all resets it", async ({ page }) => {
  await page.goto("/search?q=box");
  await settle(page);
  const before = (await hrefs(page)).length;
  expect(before).toBeGreaterThan(0);

  await page.getByRole("radio", { name: /^GST verified or higher/ }).check();
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/[?&]tier=1(&|$)/);
  await expect(page).toHaveURL(/[?&]q=box/);
  const chip = page.getByRole("link", { name: "Remove filter: GST verified or higher" });
  await expect(chip).toBeVisible();
  expect((await hrefs(page)).length).toBeLessThanOrEqual(before);
  // the sidebar reflects the URL
  await expect(page.getByRole("radio", { name: /^GST verified or higher/ })).toBeChecked();

  // back button restores the unfiltered view
  await page.goBack();
  await expect(page).not.toHaveURL(/tier=/);
  await page.goForward();
  await expect(page).toHaveURL(/tier=1/);

  await page.getByRole("link", { name: "Clear all" }).first().click();
  await expect(page).not.toHaveURL(/tier=/);
  await expect(page.getByRole("link", { name: /^Remove filter/ })).toHaveCount(0);
  expect((await hrefs(page)).length).toBe(before);
});

test("removing a chip removes only that filter", async ({ page }) => {
  await page.goto("/search?q=box&tier=1&moq=100000&priced=1");
  await settle(page);
  await page.getByRole("link", { name: /^Remove filter: Minimum order up to/ }).click();
  await expect(page).toHaveURL(/tier=1/);
  await expect(page).toHaveURL(/priced=1/);
  await expect(page).not.toHaveURL(/moq=/);
});

test("price, MOQ and 'price shown' filters are URL-driven and narrow results", async ({ page }) => {
  await page.goto("/search?q=box");
  await settle(page);
  const before = (await hrefs(page)).length;
  await page.getByLabel("Max price (₹)").first().fill("1");
  await page.getByLabel("Largest minimum order you can take (units)").first().fill("1");
  await page.getByRole("checkbox", { name: /Hide “price on request” listings/ }).check();
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/pmax=1(&|$)/);
  await expect(page).toHaveURL(/moq=1(&|$)/);
  await expect(page).toHaveURL(/priced=1/);
  expect((await hrefs(page)).length).toBeLessThanOrEqual(before);
  await expect(page.getByRole("link", { name: /^Remove filter: Up to ₹1$/ })).toBeVisible();
});

test("a filter that matches nothing explains itself and offers Clear all", async ({ page }) => {
  await page.goto("/search?q=box&pmax=1&pmin=1&moq=1&tier=3&state=nowhere");
  await settle(page);
  await expect(page.getByText("No listings match these filters.")).toBeVisible();
  await page.getByRole("main").getByRole("link", { name: "Clear all" }).last().click();
  await expect(page).not.toHaveURL(/state=/);
});

test.describe("sort", () => {
  test("price low to high and high to low order the cards by price (price on request last)", async ({ page }) => {
    await page.goto("/search?q=box");
    await settle(page);
    const relevance = await hrefs(page);

    await page.getByLabel("Sort by").selectOption("price_asc");
    await page.getByRole("button", { name: "Apply sort" }).click();
    await expect(page).toHaveURL(/sort=price_asc/);
    await ready(page);
    const asc = await prices(page);
    const priced = asc.filter((p): p is number => p !== null);
    expect(asc.slice(0, priced.length)).toEqual(priced); // no price-on-request card before a priced one
    expect(priced).toEqual([...priced].sort((a, b) => a - b));

    await page.getByLabel("Sort by").selectOption("price_desc");
    await page.getByRole("button", { name: "Apply sort" }).click();
    await expect(page).toHaveURL(/sort=price_desc/);
    await ready(page);
    const desc = (await prices(page)).filter((p): p is number => p !== null);
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
    // (the page may show different listings than relevance: a price sort orders a wider candidate pool, then cuts the page)

    // relevance is the default again
    await page.getByLabel("Sort by").selectOption("relevance");
    await page.getByRole("button", { name: "Apply sort" }).click();
    await expect(page).not.toHaveURL(/sort=/);
    await ready(page);
    expect(await hrefs(page)).toEqual(relevance);
  });

  test("the ranking promise is stated next to the control", async ({ page }) => {
    await page.goto("/search?q=box&sort=newest");
    await settle(page);
    await expect(page.getByLabel("Sort by")).toHaveValue("newest");
    await expect(page.getByText("Sponsored listings are always labelled and never change this order.")).toBeVisible();
  });
});

test("keyboard: radios, checkboxes and the apply button work without a mouse", async ({ page }) => {
  await page.goto("/search?q=box");
  await settle(page);
  const tier = page.getByRole("radio", { name: /^GST verified or higher/ });
  await tier.focus();
  await page.keyboard.press("Space");
  await expect(tier).toBeChecked();
  const priced = page.getByRole("checkbox", { name: /Hide “price on request” listings/ });
  await priced.focus();
  await page.keyboard.press("Space");
  await expect(priced).toBeChecked();
  const apply = page.getByRole("button", { name: "Apply filters" });
  await apply.focus();
  await expect(apply).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/tier=1/);
  await expect(page).toHaveURL(/priced=1/);
  // chips are links: reachable and operable by keyboard
  const chip = page.getByRole("link", { name: "Remove filter: Price shown" });
  await chip.focus();
  await page.keyboard.press("Enter");
  await expect(page).not.toHaveURL(/priced=1/);
});

test("keyboard: the mobile sheet traps focus while open, and Tab order reaches Apply", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto("/search?q=box");
  await settle(page);
  await page.getByRole("button", { name: /^Filters/ }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Filter results" });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    // never lands on the page behind (Chromium may park focus on <body>/browser UI when it wraps)
    expect(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement?.closest("dialog"))).toBe(true);
  }
  await dialog.getByRole("radio", { name: /^GST verified or higher/ }).check();
  await dialog.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/tier=1/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test.describe("deliver to my pincode is opt-in", () => {
  test("never applied silently: a saved pincode alone adds no filter", async ({ page, context }) => {
    await context.addCookies([{ name: "cnote_pincode", value: "560001", url: "http://localhost" }]);
    await page.goto("/search?q=box");
    await settle(page);
    const toggle = page.getByRole("checkbox", { name: "Only suppliers who deliver to 560001" });
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByRole("link", { name: /^Remove filter: Delivers to/ })).toHaveCount(0);
    await expect(page).not.toHaveURL(/deliver=/);
  });

  test("ticking it puts the pincode in the URL and shows a chip; unticking via the chip removes it", async ({ page, context }) => {
    await context.addCookies([{ name: "cnote_pincode", value: "560001", url: "http://localhost" }]);
    await page.goto("/search?q=box");
    await settle(page);
    await page.getByRole("checkbox", { name: "Only suppliers who deliver to 560001" }).check();
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(/deliver=560001/);
    await expect(page.getByRole("complementary").getByText("We match suppliers located in Karnataka.", { exact: false })).toBeVisible();
    await page.getByRole("link", { name: "Remove filter: Delivers to 560001" }).click();
    await expect(page).not.toHaveURL(/deliver=/);
  });

  test("without a saved pincode the toggle is disabled and explains how to enable it", async ({ page }) => {
    await page.goto("/search?q=box");
    await settle(page);
    await expect(page.getByRole("checkbox", { name: "Only suppliers who deliver to my pincode" })).toBeDisabled();
    await expect(page.getByRole("complementary").getByText("Set your “Deliver to” pincode in the header to use this filter.")).toBeVisible();
  });
});

test("manufacturers tab: tier / state filters and trust sort only (no price or MOQ)", async ({ page }, info) => {
  await page.goto("/search?q=&tab=manufacturers");
  await settle(page);
  await expect(page.getByRole("radio", { name: /^GST verified or higher/ })).toBeVisible();
  await expect(page.getByLabel("Max price (₹)")).toHaveCount(0);
  await expect(page.getByLabel("Sort by").locator("option")).toHaveCount(2);
  await page.getByRole("radio", { name: /^GST verified or higher/ }).check();
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/tab=manufacturers/);
  await expect(page).toHaveURL(/tier=1/);
  await expectNoBlockingViolations(page, info);
});

test("category page stays static: its filter form hands over to /search with the category kept", async ({ page }, info) => {
  await page.goto(`/c/${CATEGORY_SLUG}`);
  await settle(page);
  await expect(page.getByRole("complementary", { name: "Filters" })).toBeVisible();
  await expectNoBlockingViolations(page, info);
  await page.getByRole("radio", { name: /^GST verified or higher/ }).check();
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(new RegExp(`/search\\?.*category=${CATEGORY_SLUG}`));
  await expect(page).toHaveURL(/tier=1/);
});

/** Site-wide icon rail (docs/design/buyer-rail.md): public + account items, collapsed/expanded, tooltips, persistence, mobile strip, axe. */
import { expect, test, type Page } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { signUpBuyer } from "../support/auth";

const SHOTS = process.env.RAIL_SHOTS;
const rail = (page: Page) => page.locator("#buyer-rail");
const width = async (page: Page) => Math.round((await rail(page).boundingBox())!.width);
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

test.describe("desktop rail", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("collapsed by default, tooltip on hover and focus, Escape dismisses", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop");
    await signUpBuyer(page, "rail");
    await page.goto("/buyer/enquiries");
    await settle(page);
    await expect(rail(page)).toBeVisible();
    expect(await width(page)).toBe(64);
    const nav = page.getByRole("navigation", { name: "Site navigation" });
    const current = nav.locator("[aria-current=page]");
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAccessibleName("My requirements");
    await shot(page, "rail-collapsed");

    const item = nav.getByRole("link", { name: "Orders" });
    const tip = rail(page).locator("span[aria-hidden]", { hasText: "Orders" });
    await expect(tip).toBeHidden();
    await item.hover();
    await expect(tip).toBeVisible();
    await tip.hover(); // hoverable: moving onto the tooltip keeps it open
    await expect(tip).toBeVisible();
    const [ib, tb] = [await item.boundingBox(), await tip.boundingBox()];
    expect(tb!.x).toBeGreaterThanOrEqual(ib!.x + ib!.width); // never covers the item
    await page.keyboard.press("Escape");
    await expect(tip).toBeHidden();
    await page.mouse.move(700, 400);

    await item.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(item).toBeFocused();
    await expect(tip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tip).toBeHidden();
    await expectNoBlockingViolations(page, info);
  });

  test("toggle expands, survives reload, collapses again; axe clean in both states", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop");
    await signUpBuyer(page, "rail2");
    await page.goto("/buyer/enquiries");
    await settle(page);
    const toggle = page.getByRole("button", { name: "Expand sidebar" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveAttribute("aria-controls", "buyer-rail");
    await toggle.click();
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => width(page)).toBe(240);
    await expect(rail(page).getByRole("link", { name: "Post requirement" }).getByText("Post requirement", { exact: true })).toBeVisible();
    await shot(page, "rail-expanded");
    await expectNoBlockingViolations(page, info);

    await page.reload();
    await settle(page);
    await expect(page.locator("html")).toHaveAttribute("data-rail", "expanded"); // pre-paint script from the cookie
    expect(await width(page)).toBe(240);
    expect((await page.context().cookies()).find((c) => c.name === "cnote_rail")?.value).toBe("expanded");

    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect.poll(() => width(page)).toBe(64);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-rail", "collapsed");
  });

  test("rail is on every page kind, with public items when signed out", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop");
    test.setTimeout(120_000); // seven full page loads, each settled
    const pages = [
      { path: "/", current: "Home", lang: "en" },
      { path: "/hi", current: "होम", lang: "hi" },
      { path: "/search", current: "Search", lang: "en" },
      { path: "/signin", current: null, lang: "en" },
      { path: "/compare", current: "Compare", lang: "en" },
      { path: "/pricing", current: "Pricing", lang: "en" },
      { path: "/no-such-page-xyz", current: null, lang: "en" },
    ];
    for (const p of pages) {
      await page.context().clearCookies(); // visiting /hi remembers Hindi for the unprefixed pages (cnote_locale)
      await page.goto(p.path);
      await settle(page);
      await expect(rail(page), p.path).toBeVisible();
      expect(await width(page), p.path).toBe(64);
      const nav = page.getByRole("navigation", { name: p.lang === "hi" ? "साइट नेविगेशन" : "Site navigation" });
      await expect(nav, p.path).toHaveCount(1);
      if (p.current) await expect(nav.locator("[aria-current=page]")).toHaveAccessibleName(p.current);
      const names = p.lang === "hi" ? ["होम", "खोजें", "श्रेणियाँ", "निर्माता", "मूल्य"] : ["Home", "Search", "Categories", "Manufacturers", "Pricing", "Request quote", "Compare"];
      for (const n of names) await expect(nav.getByRole("link", { name: n, exact: true }), `${p.path} ${n}`).toBeVisible();
      await expect(nav.getByRole("link", { name: "My requirements" })).toHaveCount(0);
      await expect(nav.getByRole("link", { name: p.lang === "hi" ? "साइन इन करें" : "Sign in", exact: true })).toBeVisible();
    }
  });

  test("/hi links keep the locale prefix on localised pages", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop");
    await page.goto("/hi");
    await settle(page);
    const nav = page.getByRole("navigation", { name: "साइट नेविगेशन" });
    await expect(nav.getByRole("link", { name: "होम", exact: true })).toHaveAttribute("href", "/hi");
    await expect(nav.getByRole("link", { name: "खोजें", exact: true })).toHaveAttribute("href", "/hi/search");
    await expect(nav.getByRole("link", { name: "साइन इन करें", exact: true })).toHaveAttribute("href", "/signin");
    await expect(page.getByRole("button", { name: "साइडबार खोलें" })).toBeVisible();
  });

  test("public page: toggle persists across reload and navigation; axe clean expanded", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop");
    await page.goto("/");
    await settle(page);
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect.poll(() => width(page)).toBe(240);
    await expect(rail(page).getByRole("link", { name: "Manufacturers" }).getByText("Manufacturers", { exact: true })).toBeVisible();
    await shot(page, "site-rail-home-expanded");
    await expectNoBlockingViolations(page, info);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-rail", "expanded");
    expect(await width(page)).toBe(240);
    await page.getByRole("navigation", { name: "Site navigation" }).getByRole("link", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/\/search/);
    expect(await width(page)).toBe(240);
    await page.goto("/hi");
    expect(await width(page)).toBe(240); // one cookie across locales
    await page.getByRole("button", { name: "साइडबार समेटें" }).click();
    await expect.poll(() => width(page)).toBe(64);
  });

  test("signed in: account items are added, sign in entry becomes the account link", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop");
    await signUpBuyer(page, "railpub");
    await page.goto("/");
    await settle(page);
    const nav = page.getByRole("navigation", { name: "Site navigation" });
    await expect(nav.getByRole("link", { name: "My requirements" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Your account" })).toHaveAttribute("href", "/account");
    await expect(nav.getByRole("link", { name: "Sign in", exact: true })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Request quote" })).toHaveCount(0);
    await expectNoBlockingViolations(page, info);
  });
});

test.describe("below lg", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("section strip replaces the rail, no horizontal overflow", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop");
    await signUpBuyer(page, "strip");
    await page.goto("/buyer/enquiries");
    await settle(page);
    await expect(rail(page)).toBeHidden();
    const strip = page.getByRole("navigation", { name: "Account sections" });
    await expect(strip).toBeVisible();
    await expect(strip.locator("[aria-current=page]")).toHaveAccessibleName("My requirements");
    const box = await strip.getByRole("link", { name: "Orders" }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, "strip-390");
    await expectNoBlockingViolations(page, info);
  });
});

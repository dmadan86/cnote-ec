/**
 * Responsive layout across the breakpoints the buyer web designs for. WCAG 1.4.10 (Reflow) is the a11y core: no
 * horizontal scrolling down to 320 CSS px. On top of that, the layout contracts that broke before:
 *   - header labels never wrap and nothing spills past the viewport; nav moves inline (2xl) → second row (lg) → menu;
 *   - the content container uses the wide screen (up to 1600px) and keeps a 16px gutter on phones;
 *   - the hero search stays usable (not crushed by the value cards) and the cards never cover it;
 *   - promo panel artwork never sits on top of the panel's text.
 */
import { expect, test, type Page } from "../support/fixtures";
import { settle } from "../support/a11y";
import { CATEGORY_SLUG } from "../support/pages";

const WIDTHS = [320, 390, 768, 1024, 1280, 1440, 1920] as const;

const PAGES = [
  { name: "home", path: "/" },
  { name: "home (hi)", path: "/hi" },
  { name: "search", path: "/search?q=box" },
  { name: "category", path: `/c/${CATEGORY_SLUG}` },
  { name: "categories", path: "/categories" },
  { name: "manufacturers", path: "/manufacturers" },
  { name: "pricing", path: "/pricing" },
];

async function open(page: Page, width: number, path: string) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await settle(page);
}

type Box = { x: number; y: number; width: number; height: number };
const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.describe("reflow (WCAG 1.4.10): no horizontal scrolling", () => {
  for (const p of PAGES) {
    for (const w of WIDTHS) {
      test(`${p.name} @ ${w}px`, async ({ page }) => {
        await open(page, w, p.path);
        const { scrollWidth, innerWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        expect(scrollWidth, `page is ${scrollWidth - innerWidth}px wider than the viewport`).toBeLessThanOrEqual(innerWidth);
      });
    }
  }
});

test.describe("header", () => {
  for (const w of WIDTHS) {
    test(`fits on its rows without wrapping @ ${w}px`, async ({ page }) => {
      await open(page, w, "/");
      const problems = await page.locator("header").evaluate((header, vw) => {
        const out: string[] = [];
        for (const el of header.querySelectorAll<HTMLElement>("a, button, select")) {
          const r = el.getBoundingClientRect();
          if (!el.offsetParent || r.width === 0) continue; // not displayed at this breakpoint
          const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
          // A single-line control is at most ~48px tall (44px target + border); taller means its label wrapped.
          if (r.height > 52) out.push(`"${label}" wraps (${Math.round(r.height)}px tall)`);
          if (r.right > vw + 0.5 || r.left < -0.5) out.push(`"${label}" is outside the viewport`);
        }
        return out;
      }, w);
      expect(problems).toEqual([]);
    });
  }

  test("primary nav is inline at 2xl, a second row from lg, and behind the menu button below lg", async ({ page }) => {
    const nav = page.getByRole("navigation", { name: "Primary" });
    const menuButton = page.getByRole("button", { name: "Open menu" });
    const logo = page.locator('header a[href="/"]').first(); // the logo (home) link

    await open(page, 1920, "/");
    await expect(nav).toHaveCount(1); // only one of the two variants is ever rendered visibly
    const navBox = (await nav.boundingBox())!;
    const logoBox = (await logo.boundingBox())!;
    expect(Math.abs(navBox.y + navBox.height / 2 - (logoBox.y + logoBox.height / 2))).toBeLessThan(8); // same row
    await expect(menuButton).toBeHidden();

    for (const w of [1024, 1280, 1440]) {
      await page.setViewportSize({ width: w, height: 900 });
      await expect(nav).toBeVisible();
      const n = (await nav.boundingBox())!;
      const l = (await logo.boundingBox())!;
      expect(n.y, `nav should sit below the logo row at ${w}px`).toBeGreaterThanOrEqual(l.y + l.height);
      await expect(menuButton).toBeHidden();
    }

    for (const w of [390, 768]) {
      await page.setViewportSize({ width: w, height: 900 });
      await expect(nav).toBeHidden();
      await expect(menuButton).toBeVisible();
    }
  });
});

test.describe("content container", () => {
  test("uses the wide screen at 1920px", async ({ page }) => {
    await open(page, 1920, "/");
    const box = (await page.locator("section[aria-labelledby=cat-title]").boundingBox())!;
    // Capped at 1600px minus gutters, and centred; the old 1280px cap left ~40% of the screen empty.
    expect(box.width).toBeGreaterThan(1450);
    expect(box.width).toBeLessThanOrEqual(1600);
    // The site rail (64px collapsed, the default) sits left of the content column, so the container centres within the
    // column, not the viewport: measure the space either side of the box relative to the column's own edges.
    const railWidth = (await page.locator("#buyer-rail").boundingBox())!.width;
    expect(railWidth).toBe(64);
    expect(Math.abs(box.x - railWidth - (1920 - (box.x + box.width)))).toBeLessThan(2);
  });

  for (const w of [320, 390]) {
    test(`keeps a 16px gutter on phones @ ${w}px`, async ({ page }) => {
      await open(page, w, "/");
      const box = (await page.locator("section[aria-labelledby=cat-title]").boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(16);
      expect(box.x + box.width).toBeLessThanOrEqual(w - 16 + 0.5);
    });
  }
});

test.describe("home hero", () => {
  for (const w of WIDTHS) {
    test(`search stays usable and uncovered @ ${w}px`, async ({ page }) => {
      await open(page, w, "/");
      const hero = page.locator("section[aria-labelledby=hero-title]");
      const form = hero.getByRole("search");
      const input = form.locator('input[type="search"]');
      const inputBox = (await input.boundingBox())!;
      // Room to read a typical query; at 1024-1280px the old 3-column grid squeezed this to ~180px. From lg the 64px site
      // rail takes its share of the row, so the floor is 220px there (still far from the squeezed layout).
      expect(inputBox.width).toBeGreaterThanOrEqual(Math.min(w >= 1024 ? 220 : 240, w - 140));

      const formBox = (await form.boundingBox())!;
      const cards = hero.locator("[aria-label^='Why '] a"); // the value cards ("Why BizKart")
      for (const card of await cards.all()) {
        const b = await card.boundingBox();
        if (b) expect(intersects(b, formBox), "a value card overlaps the search form").toBe(false);
      }
    });
  }
});

test.describe("home promo panels", () => {
  for (const w of WIDTHS) {
    test(`artwork never covers the text @ ${w}px`, async ({ page }) => {
      await open(page, w, "/");
      const overlaps = await page.evaluate(() => {
        const out: string[] = [];
        for (const id of ["promo-ai", "promo-quotes", "promo-mfg"]) {
          const section = document.querySelector(`section[aria-labelledby=${id}]`);
          if (!section) continue;
          const art = [...section.querySelectorAll(":scope > svg")].map((s) => s.getBoundingClientRect());
          // Rects of the rendered text itself (not block boxes, which span the full column width).
          const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent?.trim() || n.parentElement?.closest("svg")) continue;
            const range = document.createRange();
            range.selectNodeContents(n);
            for (const r of range.getClientRects()) {
              for (const a of art) {
                if (r.left < a.right && a.left < r.right && r.top < a.bottom && a.top < r.bottom) {
                  out.push(`${id}: "${n.textContent.trim().slice(0, 30)}"`);
                }
              }
            }
          }
        }
        return [...new Set(out)];
      });
      expect(overlaps).toEqual([]);
    });
  }
});

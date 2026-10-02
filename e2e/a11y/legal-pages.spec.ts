/**
 * Legal and information pages (apps/web/src/features/legal): axe WCAG 2.2 AA in English and Hindi, the footer link
 * structure, the report form (labels, validation announcements, `?url=` prefill) and security.txt.
 * Copy on these pages is a draft for counsel review; these tests only check structure and accessibility.
 */
import { expect, test } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";

type Locale = "en" | "hi";
const prefix = (l: Locale) => (l === "hi" ? "/hi" : "");

const PAGES = ["/terms", "/privacy", "/refund-policy", "/prohibited-items", "/report", "/about", "/contact", "/trust", "/accessibility", "/security", "/sitemap"];

for (const locale of ["en", "hi"] as const) {
  test.describe(`legal pages axe (${locale})`, () => {
    for (const path of PAGES) {
      test(path, async ({ page }, info) => {
        await page.goto(`${prefix(locale)}${path}`);
        await settle(page);
        await expect(page.locator("html")).toHaveAttribute("lang", locale === "hi" ? /^hi/ : /^en/);
        await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
        await expectNoBlockingViolations(page, info);
      });
    }
  });
}

test.describe("footer", () => {
  test("has Buy, Sell, Company and Legal columns and no coming-soon links", async ({ page }) => {
    await page.goto("/");
    const footer = page.getByRole("contentinfo");
    const nav = footer.getByRole("navigation");
    await expect(nav.getByRole("heading", { level: 2 })).toHaveCount(4);
    await expect(footer.locator('a[href*="/coming-soon"]')).toHaveCount(0);
    for (const name of ["About us", "Contact us", "Trust and Safety", "Sitemap", "Terms of Use", "Privacy Policy", "Cookie policy", "Refund policy", "Prohibited items", "Dispute policy", "Grievance redressal", "Report abuse", "Accessibility", "Security"]) {
      await expect(nav.getByRole("link", { name }), name).toBeVisible();
    }
    await expect(nav.getByRole("button", { name: "Cookie settings" })).toBeVisible();
    await expect(footer.getByRole("link", { name: "llms.txt" })).toBeVisible();
  });

  test("shows the company details in the bottom bar", async ({ page }) => {
    await page.goto("/");
    const footer = page.getByRole("contentinfo");
    await expect(footer).toContainText("CIN");
    await expect(footer).toContainText("GSTIN");
  });

  test("every footer link resolves with 200", async ({ page, request }) => {
    await page.goto("/");
    const hrefs = await page.getByRole("contentinfo").locator("a[href]").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
    const origin = new URL(page.url()).origin;
    const local = [...new Set(hrefs.filter((h) => h.startsWith(origin)))];
    expect(local.length).toBeGreaterThan(10);
    for (const href of local) {
      const res = await request.get(href, { maxRedirects: 5 });
      expect(res.status(), href).toBe(200);
    }
  });

  test("footer links keep the Hindi locale", async ({ page }) => {
    await page.goto("/hi");
    await expect(page.getByRole("contentinfo").locator('a[href="/hi/terms"]')).toHaveCount(1);
  });
});

test.describe("report form", () => {
  test("prefills the link from ?url=", async ({ page }) => {
    await page.goto("/report?url=https%3A%2F%2Fexample.in%2Fp%2Fabc");
    await expect(page.getByLabel("Link to the listing or supplier")).toHaveValue("https://example.in/p/abc");
  });

  test("ignores an unsafe ?url= value", async ({ page }) => {
    await page.goto("/report?url=javascript%3Aalert(1)");
    await expect(page.getByLabel("Link to the listing or supplier")).toHaveValue("");
  });

  test("announces validation errors and keeps what was typed", async ({ page }, info) => {
    await page.goto("/report");
    await page.getByLabel("Your name or the rights holder").fill("Asha Rao");
    await page.getByRole("button", { name: "Send report" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Enter the link" })).toBeVisible();
    await expect(page.getByLabel("Your name or the rights holder")).toHaveValue("Asha Rao");
    await expect(page.getByLabel(/I declare in good faith/)).toHaveAttribute("aria-invalid", "true");
    await expectNoBlockingViolations(page, info);
  });
});

test("security.txt is served (RFC 9116)", async ({ request }) => {
  const res = await request.get("/.well-known/security.txt");
  expect(res.status()).toBe(200);
  const body = await res.text();
  for (const field of ["Contact:", "Expires:", "Policy:", "Preferred-Languages:"]) expect(body).toContain(field);
});

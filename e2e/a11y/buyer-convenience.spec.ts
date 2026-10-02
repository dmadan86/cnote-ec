/**
 * Buyer convenience features (docs/design/buyer-convenience.md):
 *  - supplier contact options (Call, WhatsApp, Email, Send enquiry) appear ONLY after a legitimate unlock, never in static HTML;
 *  - "Recently viewed" is remembered on the device only with marketing consent (cnote_recent_v1);
 *  - wishlist: bulk "Request quotes for selected" and a revocable read-only share link.
 * Every state is scanned with axe (WCAG 2.2 AA).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { CONSENT_COOKIE, CONSENT_POLICY_VERSION, newConsentId, serializeConsent } from "../../apps/web/src/features/consent/state";
import { expect, test, type Page } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { signUpBuyer } from "../support/auth";
import { e2eEnv, WEB_URL } from "../support/env";
import { firstProductHref } from "../support/pages";

test.setTimeout(120_000);

const root = path.resolve(__dirname, "../..");
const seed = (cmd: "unlock" | "save", email: string, listingId: string): Record<string, string> => {
  const out = execFileSync("pnpm", ["exec", "tsx", "e2e/support/convenience-seed.ts", cmd, email, listingId], { cwd: root, env: { ...process.env, ...e2eEnv }, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop()!);
};
const listingIdOf = (href: string) => href.slice(-36);

const marketingConsent = () =>
  serializeConsent({ version: CONSENT_POLICY_VERSION, id: newConsentId(), analytics: false, marketing: true, gpc: false, at: Math.floor(Date.now() / 1000) - 60 });

async function productHrefs(page: Page, n: number): Promise<string[]> {
  await page.goto("/search?q=box");
  const links = page.locator("main a[href*='/p/']");
  await links.first().waitFor();
  const all = await links.evaluateAll((as) => [...new Set(as.map((a) => new URL((a as HTMLAnchorElement).href).pathname))]);
  expect(all.length).toBeGreaterThanOrEqual(n);
  return all.slice(0, n);
}

test.describe("supplier contact after unlock", () => {
  test("buttons appear only after the supplier accepted, with no number in static HTML, and pass axe", async ({ page, request }, info) => {
    const acct = await signUpBuyer(page, "contact");
    const href = await firstProductHref(page);
    const id = listingIdOf(href);

    // Locked: the existing unlock button, and no way to reach a number.
    await page.goto(href);
    await settle(page);
    await expect(page.getByRole("button", { name: "Contact seller" })).toBeVisible();
    await expect(page.getByTestId("supplier-contact")).toHaveCount(0);
    expect(await page.locator('a[href^="tel:"], a[href*="wa.me"], a[href^="mailto:"]').count()).toBe(0);
    const locked = await page.request.get(`/api/contact/${id}`);
    expect(await locked.json()).toEqual({ unlocked: false });
    expect(locked.headers()["cache-control"]).toContain("no-store");

    // The supplier accepts the lead and shares its contact.
    const { phone } = seed("unlock", acct.email, id);

    await page.goto(href);
    const group = page.getByTestId("supplier-contact");
    await expect(group).toBeVisible();
    await expect(group.getByRole("link", { name: /^Call/ })).toHaveAttribute("href", `tel:${phone}`);
    const wa = await group.getByRole("link", { name: /^WhatsApp/ }).getAttribute("href");
    expect(wa).toContain(`https://wa.me/${phone.slice(1)}?text=`);
    expect(decodeURIComponent(wa!.split("text=")[1]!)).toContain((await page.getByRole("heading", { level: 1 }).innerText()).trim());
    await expect(group.getByRole("link", { name: /^Email/ })).toHaveAttribute("href", /^mailto:/);
    await expect(group.getByRole("link", { name: "Send enquiry" })).toHaveAttribute("href", /\/(buyer\/enquiries|conversations)\//);
    await expectNoBlockingViolations(page, info);

    // The page HTML itself never carries the number: an anonymous request for it, and the cached shell, are clean.
    const html = await (await request.get(href)).text();
    expect(html).not.toContain(phone);
    expect(html).not.toContain(phone.slice(1));

    // Logging a channel works for the unlocked buyer (SupplierContacted) and is refused for anybody else.
    const logged = await page.request.post(`/api/contact/${id}`, { data: { channel: "whatsapp" }, headers: { origin: new URL(WEB_URL).origin } });
    expect(logged.status()).toBe(200);
    const anon = await request.post(`${WEB_URL}/api/contact/${id}`, { data: { channel: "call" }, headers: { origin: new URL(WEB_URL).origin } });
    expect(anon.status()).toBe(401);
  });
});

test.describe("recently viewed", () => {
  test("stores nothing without marketing consent and shows no rail", async ({ page }) => {
    const [a, b] = await productHrefs(page, 2);
    await page.goto(a!);
    await settle(page);
    await page.goto(b!);
    await settle(page);
    await page.goto("/");
    await settle(page);
    await expect(page.getByTestId("recently-viewed")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("cnote_recent_v1"))).toBeNull();
  });

  test("with marketing consent it remembers on this device, shows the rail on home and the product page, and can be cleared", async ({ page, context }, info) => {
    await context.addCookies([{ name: CONSENT_COOKIE, value: marketingConsent(), url: WEB_URL }]);
    const [a, b] = await productHrefs(page, 2);
    await page.goto(a!);
    await settle(page);
    await page.goto(b!);
    await settle(page);

    // On the second product page the rail lists the first one, not itself.
    const pdpRail = page.getByTestId("recently-viewed");
    await expect(pdpRail).toBeVisible();
    await expect(pdpRail.getByRole("heading", { name: "Recently viewed" })).toBeVisible();
    await expect(pdpRail.locator(`a[href$="${a!.slice(-36)}"]`).first()).toBeVisible();
    await expect(pdpRail.locator(`a[href$="${b!.slice(-36)}"]`)).toHaveCount(0);

    await page.goto("/");
    await settle(page);
    const home = page.getByTestId("recently-viewed");
    await expect(home).toBeVisible();
    await expect(home.locator("a[href*='/p/']")).toHaveCount(2);
    await expectNoBlockingViolations(page, info);
    expect(await page.evaluate(() => localStorage.getItem("cnote_recent_v1"))).toContain(b!.slice(-36));

    await home.getByRole("button", { name: "Clear history" }).click();
    await expect(page.getByTestId("recently-viewed")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("cnote_recent_v1"))).toBeNull();
  });
});

test.describe("wishlist: bulk quote request and share link", () => {
  test("requests quotes for the selected products and shares a read-only link that can be revoked", async ({ page, browser }, info) => {
    const acct = await signUpBuyer(page, "wish");
    const [a, b] = await productHrefs(page, 2);
    seed("save", acct.email, listingIdOf(a!));
    seed("save", acct.email, listingIdOf(b!));

    await page.goto("/wishlist");
    await settle(page);
    const submit = page.getByRole("button", { name: /^Request quotes for selected/ });
    await expect(submit).toBeDisabled();
    await page.getByRole("checkbox", { name: "Select all products" }).check();
    await expect(submit).toBeEnabled();
    await expect(submit).toContainText("(2)");
    await expectNoBlockingViolations(page, info);
    await submit.click();
    await expect(page.getByRole("status").filter({ hasText: /Sent \d+ requests?/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "View your requests" })).toBeVisible();

    // Share: create the link, open it as a stranger, then revoke it.
    await page.locator("summary", { hasText: "Share this list" }).click();
    await page.getByRole("button", { name: "Create share link" }).click();
    const link = page.getByLabel("Share link");
    await expect(link).toHaveValue(/\/shared\/[A-Za-z0-9_-]{43}$/);
    const url = await link.inputValue();
    await expectNoBlockingViolations(page, info);

    const stranger = await browser.newContext({ baseURL: WEB_URL });
    try {
      const sp = await stranger.newPage();
      await sp.goto(url);
      await expect(sp.getByRole("heading", { level: 1, name: /Shared list: Saved items/ })).toBeVisible();
      await expect(sp.locator("main a[href*='/p/']").first()).toBeVisible();
      const html = await sp.content();
      expect(html).not.toContain(acct.email);
      expect(html).not.toContain(acct.name);
      await expectNoBlockingViolations(sp, info);

      page.once("dialog", (d) => void d.accept());
      await page.getByRole("button", { name: "Stop sharing" }).click();
      await expect(page.getByRole("button", { name: "Create share link" })).toBeVisible();

      await sp.goto(url);
      await expect(sp.getByRole("heading", { name: "This link is not active" })).toBeVisible();
      await expectNoBlockingViolations(sp, info);
    } finally {
      await stranger.close();
    }
  });
});

/**
 * Third-party embeds in seller storefronts and the consent gate (apps/web/src/features/consent/consent-gate.tsx,
 * docs/design/cookie-consent.md "Consent gate"). A live storefront has a YouTube video block (marketing) and a map block
 * (functional). Standards: DPDP Act 2023 s.6, ePrivacy Art 5(3) (nothing from the provider is requested before consent), WCAG 2.2 AA.
 *
 * The provider hosts are stubbed at the network layer (no internet needed); what is asserted is WHEN the browser asks for them, and
 * that the CSP `frame-src` lets exactly those two hosts load.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { e2eEnv } from "../support/env";
import { expect, test, type BrowserContext, type Page } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";

test.use({ consent: false });

const root = path.resolve(__dirname, "../..");
const PROVIDERS = /(^|\.)youtube-nocookie\.com$|(^|\.)openstreetmap\.org$/;
let slug = "";

test.beforeAll(() => {
  slug = `e2e-embed-${randomUUID().slice(0, 8)}`;
  execFileSync("pnpm", ["exec", "tsx", "e2e/support/storefront-seed.ts", slug], { cwd: root, env: { ...process.env, ...e2eEnv }, encoding: "utf8" });
});

const banner = (page: Page) => page.getByRole("region", { name: "Cookie notice" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Cookie preferences" });
const videoGate = (page: Page) => page.getByRole("group", { name: /This content is from YouTube/ });
const mapGate = (page: Page) => page.getByRole("group", { name: /This content is from OpenStreetMap/ });
const videoFrame = (page: Page) => page.locator('iframe[title="Factory tour"]');
const mapFrame = (page: Page) => page.locator('iframe[title="Find our workshop"]');

/** Stubs the two provider hosts and records every request the page makes to them, plus any CSP refusal. */
async function watch(context: BrowserContext, page: Page) {
  const providerRequests: string[] = [];
  const violations: string[] = [];
  await context.route((url) => PROVIDERS.test(url.hostname), (route) => {
    providerRequests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>stub</title><p>stub</p>" });
  });
  page.on("console", (m) => /Content Security Policy|Refused to frame/i.test(m.text()) && violations.push(m.text()));
  return { providerRequests, violations };
}

async function open(page: Page) {
  await page.goto(`/store/${slug}`);
  await settle(page);
  await expect(page.getByRole("heading", { level: 2, name: "Factory tour" })).toBeVisible();
}

test.describe("before any consent", () => {
  test("shows the cookie banner and two accessible placeholders; nothing is requested from YouTube or OpenStreetMap; axe clean", async ({ context, page }, info) => {
    const w = await watch(context, page);
    await open(page);
    await expect(banner(page)).toBeVisible();
    await expect(videoGate(page)).toBeVisible();
    await expect(mapGate(page)).toBeVisible();
    await expect(videoGate(page)).toContainText("This content is from YouTube, which may set cookies.");
    await expect(mapGate(page)).toContainText("This content is from OpenStreetMap, which may set cookies.");
    for (const g of [videoGate(page), mapGate(page)]) {
      await expect(g.getByRole("button", { name: "Load it" })).toBeVisible();
      await expect(g.getByRole("button", { name: "Change cookie settings" })).toBeVisible();
    }
    await expect(page.locator("iframe")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(w.providerRequests).toEqual([]);
    const c = await page.context().cookies();
    expect(c.filter((x) => /youtube|google|openstreetmap/i.test(x.domain))).toEqual([]);
    await expectNoBlockingViolations(page, info);
  });

  test("Load it shows only that item, through the privacy-enhanced host, and leaves the cookie choice alone", async ({ context, page }) => {
    const w = await watch(context, page);
    await open(page);
    await videoGate(page).getByRole("button", { name: "Load it" }).click();
    const frame = videoFrame(page);
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute("src", /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
    await expect(videoGate(page)).toHaveCount(0);
    await expect(mapGate(page)).toBeVisible(); // the other embed stays gated
    await expect(mapFrame(page)).toHaveCount(0);
    expect((await page.context().cookies()).find((x) => x.name === "cnote_consent")).toBeUndefined(); // not a recorded choice
    await expect(banner(page)).toBeVisible(); // the visitor is still asked
    expect(w.providerRequests.length).toBeGreaterThan(0);
    expect(w.providerRequests.every((u) => new URL(u).hostname === "www.youtube-nocookie.com")).toBe(true);
    expect(w.violations).toEqual([]); // the CSP frame-src lets exactly this host through
  });

  test("Change cookie settings opens the preferences dialog; saving marketing loads the video live, without a reload", async ({ context, page }) => {
    const w = await watch(context, page);
    await open(page);
    const marker = await page.evaluate(() => { (window as unknown as { __m: number }).__m = 7; return 7; });
    await videoGate(page).getByRole("button", { name: "Change cookie settings" }).click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    await expect(d).toContainText("Videos and maps from other companies");
    await d.getByRole("switch", { name: "Marketing and attribution" }).click();
    await d.getByRole("button", { name: "Save choices" }).click();
    await expect(d).toBeHidden();
    await expect(videoFrame(page)).toBeVisible();
    await expect(mapGate(page)).toBeVisible(); // functional was not granted
    expect(await page.evaluate(() => (window as unknown as { __m?: number }).__m)).toBe(marker); // no reload
    expect(w.violations).toEqual([]);
  });
});

test.describe("with a recorded choice", () => {
  test("Accept all loads both embeds; withdrawing marketing removes the video again, live", async ({ context, page }) => {
    const w = await watch(context, page);
    await open(page);
    await banner(page).getByRole("button", { name: "Accept all" }).click();
    await expect(videoFrame(page)).toBeVisible();
    await expect(mapFrame(page)).toBeVisible();
    await expect(mapFrame(page)).toHaveAttribute("src", /^https:\/\/www\.openstreetmap\.org\/export\/embed\.html\?bbox=/);
    expect(w.violations).toEqual([]);
    // reload: the stored choice opens the gate again after hydration
    await page.reload();
    await settle(page);
    await expect(videoFrame(page)).toBeVisible();
    // withdraw marketing from the footer
    await page.getByRole("button", { name: "Cookie settings" }).click();
    const d = dialog(page);
    await d.getByRole("switch", { name: "Marketing and attribution" }).click();
    await d.getByRole("button", { name: "Save choices" }).click();
    await expect(videoFrame(page)).toHaveCount(0);
    await expect(videoGate(page)).toBeVisible();
    await expect(mapFrame(page)).toBeVisible(); // functional is still granted
  });

  test("Reject all keeps both gated, also after a reload", async ({ context, page }) => {
    const w = await watch(context, page);
    await open(page);
    await banner(page).getByRole("button", { name: "Reject all" }).click();
    await page.reload();
    await settle(page);
    await expect(videoGate(page)).toBeVisible();
    await expect(mapGate(page)).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(w.providerRequests).toEqual([]);
  });

  test("preferences-only consent loads the map (functional) but not the video (marketing)", async ({ context, page }) => {
    const w = await watch(context, page);
    await open(page);
    await banner(page).getByRole("button", { name: "Customise" }).click();
    const d = dialog(page);
    await d.getByRole("switch", { name: "Preferences and personalisation" }).click();
    await d.getByRole("button", { name: "Save choices" }).click();
    await expect(mapFrame(page)).toBeVisible();
    await expect(videoGate(page)).toBeVisible();
    await expect(videoFrame(page)).toHaveCount(0);
    expect(w.providerRequests.every((u) => new URL(u).hostname === "www.openstreetmap.org")).toBe(true);
  });

  test("Global Privacy Control: Accept all loads the map but keeps the video (marketing) gated", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, locale: "en-IN", extraHTTPHeaders: { "sec-gpc": "1" } });
    await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true, configurable: true }));
    const page = await context.newPage();
    const w = await watch(context, page);
    await open(page);
    await banner(page).getByRole("button", { name: "Accept all" }).click();
    await expect(mapFrame(page)).toBeVisible();
    await expect(videoGate(page)).toBeVisible();
    expect(w.providerRequests.every((u) => new URL(u).hostname === "www.openstreetmap.org")).toBe(true);
    await context.close();
  });
});

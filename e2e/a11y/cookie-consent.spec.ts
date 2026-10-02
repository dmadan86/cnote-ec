/**
 * Cookie consent manager (apps/web/src/features/consent, docs/design/cookie-consent.md): first-layer banner, second-layer
 * preferences dialog, withdrawal, and the "no non-essential storage before opt-in" guarantee. Standards: DPDP Act 2023 s.6,
 * ePrivacy Art 5(3), EDPB Cookie Banner Taskforce (equal Accept/Reject), WCAG 2.2 AA.
 *
 * Every other spec starts with a pre-seeded reject-all consent cookie (support/fixtures.ts); this one opts out with
 * `consent: false` to behave like a brand-new visitor.
 */
import { CONSENT_POLICY_VERSION } from "../../apps/web/src/features/consent/state";
import { expect, test, type Page } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { firstProductHref } from "../support/pages";

test.use({ consent: false });

const banner = (page: Page) => page.getByRole("region", { name: "Cookie notice" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Cookie preferences" });
const cookies = async (page: Page) => Object.fromEntries((await page.context().cookies()).map((c) => [c.name, c.value]));
const consentOf = async (page: Page) => {
  const raw = (await cookies(page)).cnote_consent;
  return raw ? new URLSearchParams(decodeURIComponent(raw)) : null;
};

/** The visitor id is created the moment a lead CTA is used (features/leadgen/visitor.ts). */
async function useLeadCta(page: Page) {
  await page.goto(await firstProductHref(page));
  await settle(page);
  await page.getByRole("button", { name: /get best price|contact seller/i }).first().click();
}

test.describe("first visit", () => {
  test("shows the banner to a new visitor: non-modal, equal Accept all / Reject all / Customise, cookie policy link, nothing stored", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    const b = banner(page);
    await expect(b).toBeVisible();
    await expect(b).toContainText("data fiduciary");
    await expect(b.getByRole("link", { name: "Cookie policy" })).toHaveAttribute("href", "/cookies");
    const buttons = ["Accept all", "Reject all", "Customise"].map((n) => b.getByRole("button", { name: n }));
    for (const btn of buttons) await expect(btn).toBeVisible();
    // equal prominence: same size and same computed look
    const looks = await Promise.all(buttons.map((btn) => btn.evaluate((el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return { h: Math.round(r.height), bg: s.backgroundColor, color: s.color, border: s.borderColor, weight: s.fontWeight, size: s.fontSize }; })));
    expect(new Set(looks.map((l) => JSON.stringify({ ...l }))).size).toBe(1);
    // not a modal and not a wall: the page is still operable
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.locator("main")).toBeVisible();
    await page.getByRole("link", { name: /Categories/i }).first().click();
    await expect(page).toHaveURL(/categories/);
    // prior consent: no consent cookie, no visitor id, no analytics/marketing storage yet
    const c = await cookies(page);
    expect(c.cnote_consent).toBeUndefined();
    expect(c.cnote_vid).toBeUndefined();
    expect(c.cnote_ad_click).toBeUndefined();
    expect(await page.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage)).filter((k) => /^(cnote_attr|cnote_lg_)/.test(k)))).toEqual([]);
    expect(Object.keys(c).filter((k) => /^_cl/.test(k))).toEqual([]);
  });

  test("is localised on the Hindi pages", async ({ page }) => {
    await page.goto("/hi");
    await settle(page);
    const b = page.getByRole("region", { name: "कुकी सूचना" });
    await expect(b).toBeVisible();
    await expect(b.getByRole("button", { name: "सभी स्वीकार करें" })).toBeVisible();
    await expect(b.getByRole("button", { name: "सभी अस्वीकार करें" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", /^hi/);
  });

  test("axe: no serious/critical violations with the banner showing", async ({ page }, info) => {
    await page.goto("/");
    await settle(page);
    await expect(banner(page)).toBeVisible();
    await expectNoBlockingViolations(page, info);
  });

  test("keyboard: the banner comes right after the skip link in Tab order, with a visible focus ring", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused(); // skip link stays first (WCAG 2.4.1)
    for (const name of ["Cookie policy", "Accept all", "Reject all", "Customise"]) {
      await page.keyboard.press("Tab");
      const active = banner(page).getByRole(name === "Cookie policy" ? "link" : "button", { name });
      await expect(active).toBeFocused();
      expect(await active.evaluate((el) => parseFloat(getComputedStyle(el).outlineWidth) > 0)).toBe(true);
    }
  });

  test("a focused control is never hidden behind the banner (page reserves its height)", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await expect(page.locator("html")).toHaveAttribute("data-consent-banner", "");
    const pad = await page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingBottom));
    const h = await banner(page).evaluate((el) => el.getBoundingClientRect().height);
    expect(pad).toBeGreaterThanOrEqual(Math.floor(h));
  });
});

test.describe("preferences dialog", () => {
  test("Customise opens a modal dialog: axe clean (incl. an expanded table), focus trapped, Esc closes and returns focus", async ({ page }, info) => {
    await page.goto("/");
    await settle(page);
    const customise = banner(page).getByRole("button", { name: "Customise" });
    await customise.click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    await expect(banner(page)).toBeHidden(); // one consent surface at a time
    // categories, locked necessary, both optional switches off
    await expect(d.getByText("Always active")).toBeVisible();
    const analytics = d.getByRole("switch", { name: "Analytics" });
    const marketing = d.getByRole("switch", { name: "Marketing and attribution" });
    await expect(analytics).toHaveAttribute("aria-checked", "false");
    await expect(marketing).toHaveAttribute("aria-checked", "false");
    // accordion: expand the marketing table
    await d.getByRole("button", { name: "Marketing and attribution" }).click();
    await expect(d.getByRole("table")).toBeVisible();
    await expect(d.getByRole("cell", { name: "Microsoft Clarity" })).toHaveCount(0);
    await expect(d.getByRole("rowheader", { name: /cnote_vid/ })).toBeVisible();
    await expectNoBlockingViolations(page, info);
    // focus trap: the page behind a native modal <dialog> is inert, so 40 Tabs only ever land inside the dialog (or on the
    // browser's own UI, where activeElement is <body>), never on the page, and the cycle comes back to the first control.
    let wrapped = false;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const where = await page.evaluate(() => {
        const a = document.activeElement;
        return { inDialog: !!a?.closest("dialog[open]"), isBody: a === document.body, name: a?.getAttribute("aria-label") ?? "" };
      });
      expect(where.inDialog || where.isBody, `tab ${i}`).toBe(true);
      if (where.name === "Close" && i > 0) wrapped = true;
    }
    expect(wrapped).toBe(true);
    await page.keyboard.press("Escape");
    await expect(d).toBeHidden();
    await expect(banner(page)).toBeVisible();
    await expect(customise).toBeFocused();
    expect(await consentOf(page)).toBeNull(); // dismissing is not a choice
  });

  test("switches toggle with the keyboard and Save choices stores exactly that choice, then the banner is gone", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await banner(page).getByRole("button", { name: "Customise" }).click();
    const d = dialog(page);
    const analytics = d.getByRole("switch", { name: "Analytics" });
    await analytics.focus();
    await page.keyboard.press("Space");
    await expect(analytics).toHaveAttribute("aria-checked", "true");
    await expect(analytics).toContainText("On");
    const receipt = page.waitForResponse((r) => r.url().endsWith("/api/consent") && r.request().method() === "POST");
    await d.getByRole("button", { name: "Save choices" }).click();
    expect((await receipt).status()).toBe(200);
    await expect(d).toBeHidden();
    await expect(banner(page)).toHaveCount(0);
    const c = await consentOf(page);
    expect([c?.get("a"), c?.get("m")]).toEqual(["1", "0"]);
  });

  test("the dialog is usable in Hindi", async ({ page }) => {
    await page.goto("/hi");
    await settle(page);
    await page.getByRole("region", { name: "कुकी सूचना" }).getByRole("button", { name: "अपनी पसंद चुनें" }).click();
    await expect(page.getByRole("dialog", { name: "कुकी की पसंद" })).toBeVisible();
    await page.keyboard.press("Escape");
  });
});

test.describe("choices", () => {
  test("Reject all: stored as denied, receipt posted, survives reload with no banner, and no visitor id is ever created", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    const receipt = page.waitForResponse((r) => r.url().endsWith("/api/consent") && r.request().method() === "POST");
    await banner(page).getByRole("button", { name: "Reject all" }).click();
    expect((await receipt).status()).toBe(200);
    await expect(banner(page)).toHaveCount(0);
    const c = await consentOf(page);
    expect([c?.get("a"), c?.get("m"), c?.get("v")]).toEqual(["0", "0", String(CONSENT_POLICY_VERSION)]);
    await page.reload();
    await settle(page);
    await expect(banner(page)).toHaveCount(0);
    await useLeadCta(page);
    const after = await cookies(page);
    expect(after.cnote_vid).toBeUndefined();
    expect(after.cnote_ad_click).toBeUndefined();
    expect(await page.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage)).filter((k) => /^(cnote_attr|cnote_lg_)/.test(k)))).toEqual([]);
  });

  test("Accept all: stored as granted and the visitor id is created only after that", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    expect((await cookies(page)).cnote_vid).toBeUndefined();
    await banner(page).getByRole("button", { name: "Accept all" }).click();
    await expect(banner(page)).toHaveCount(0);
    const c = await consentOf(page);
    expect([c?.get("a"), c?.get("m")]).toEqual(["1", "1"]);
    await useLeadCta(page);
    await expect.poll(async () => (await cookies(page)).cnote_vid).toBeTruthy();
    await page.reload();
    await expect(banner(page)).toHaveCount(0);
  });

  test("footer Cookie settings reopens the dialog without a reload, and withdrawing marketing deletes the visitor id", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await banner(page).getByRole("button", { name: "Accept all" }).click();
    await useLeadCta(page);
    await expect.poll(async () => (await cookies(page)).cnote_vid).toBeTruthy();
    await page.goto("/");
    await settle(page);
    const marker = await page.evaluate(() => { (window as unknown as { __m: number }).__m = 1; return 1; });
    const settings = page.getByRole("button", { name: "Cookie settings" });
    await settings.click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __m?: number }).__m)).toBe(marker); // no reload
    const marketing = d.getByRole("switch", { name: "Marketing and attribution" });
    await expect(marketing).toHaveAttribute("aria-checked", "true");
    await marketing.click();
    const receipt = page.waitForResponse((r) => r.url().endsWith("/api/consent") && r.request().method() === "POST");
    await d.getByRole("button", { name: "Save choices" }).click();
    const res = await receipt;
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toMatchObject({ action: "withdraw", analytics: true, marketing: false });
    await expect(d).toBeHidden();
    await expect(settings).toBeFocused(); // focus returns to the trigger
    const c = await cookies(page);
    expect(c.cnote_vid).toBeUndefined();
    const consent = await consentOf(page);
    expect([consent?.get("a"), consent?.get("m")]).toEqual(["1", "0"]);
  });

  test("Global Privacy Control: Accept all leaves marketing off, and the dialog says so", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, locale: "en-IN", extraHTTPHeaders: { "sec-gpc": "1" } });
    await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true, configurable: true }));
    const page = await context.newPage();
    await page.goto("/");
    await settle(page);
    await banner(page).getByRole("button", { name: "Customise" }).click();
    const d = dialog(page);
    await expect(d.getByText(/Global Privacy Control signal is on/)).toBeVisible();
    await d.getByRole("button", { name: "Accept all" }).click();
    const c = await consentOf(page);
    expect([c?.get("a"), c?.get("m"), c?.get("gpc")]).toEqual(["1", "0", "1"]);
    await context.close();
  });

  test("legacy 'granted' cookies are ignored and the visitor is asked again", async ({ context, page, baseURL }) => {
    await context.addCookies([{ name: "cnote_consent", value: "granted", url: baseURL! }]);
    await page.goto("/");
    await settle(page);
    await expect(banner(page)).toBeVisible();
  });
});

test.describe("cookie policy page", () => {
  test("lists cookies from the registry, opens the preferences, links the grievance page; axe clean", async ({ page }, info) => {
    await page.goto("/cookies");
    await settle(page);
    await expect(page.getByRole("heading", { level: 1, name: "Cookie policy" })).toBeVisible();
    await expect(page.getByRole("rowheader", { name: /cnote_consent(?!_)/ })).toBeVisible();
    await expect(page.getByRole("rowheader", { name: /_clck/ })).toBeVisible();
    await expect(page.getByRole("rowheader", { name: /cnote_ad_click/ })).toBeVisible();
    await expect(page.getByText(/Policy version \d+, last updated/)).toBeVisible();
    await expect(page.locator("main").getByRole("link", { name: "Grievance redressal" })).toHaveAttribute("href", "/grievance");
    await expectNoBlockingViolations(page, info);
    await page.getByRole("button", { name: "Open cookie settings" }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(banner(page)).toBeHidden(); // never two consent surfaces at once
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Open cookie settings" })).toBeFocused();
  });

  test("is served in Hindi", async ({ page }) => {
    await page.goto("/hi/cookies");
    await settle(page);
    await expect(page.getByRole("heading", { level: 1, name: "कुकी नीति" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", /^hi/);
  });
});

test.describe("consent ID and record download", () => {
  test("shows the visitor's own consent ID with Copy (announced politely) and downloads the JSON history", async ({ page, context }, info) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined); // chromium only; the live region is asserted either way
    await page.goto("/cookies");
    await settle(page);
    // no choice yet: no ID, just a hint
    await expect(page.getByText("You have not made a choice yet, so there is no consent ID.")).toBeVisible();
    await banner(page).getByRole("button", { name: "Reject all" }).click();
    const id = (await consentOf(page))!.get("id")!;
    await expect(page.getByTestId("consent-id")).toHaveText(id);
    await expect(page.getByText("Your consent ID:")).toBeVisible();
    const status = page.getByTestId("consent-record").getByRole("status");
    await expect(status).toHaveAttribute("aria-live", "polite");
    await page.getByRole("button", { name: "Copy ID" }).click();
    await expect(status).toHaveText(/Consent ID copied\.|Could not copy/);
    await expectNoBlockingViolations(page, info);

    // the receipt reaches the server (retried from localStorage until it does), then the download lists it
    await expect
      .poll(async () => ((await (await page.request.get("/api/consent/receipt")).json()) as { receipts?: unknown[] }).receipts?.length ?? 0, { message: "receipt not stored" })
      .toBeGreaterThanOrEqual(1);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download my consent record" }).click()]);
    expect(download.suggestedFilename()).toBe(`consent-record-${id.slice(0, 8)}.json`);
    const res = await page.request.get("/api/consent/receipt");
    expect(res.headers()["cache-control"]).toBe("private, no-store");
    const body = (await res.json()) as { consentId: string; receipts: { action: string; analytics: boolean; registryHash: string | null }[] };
    expect(body.consentId).toBe(id);
    expect(body.receipts.at(-1)).toMatchObject({ action: "reject_all", analytics: false });
    expect(body.receipts.at(-1)!.registryHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("the preferences dialog shows the ID too, and the grievance form is prefilled with it", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await banner(page).getByRole("button", { name: "Accept all" }).click();
    const id = (await consentOf(page))!.get("id")!;
    await page.goto("/cookies");
    await settle(page);
    await page.getByRole("button", { name: "Open cookie settings" }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByTestId("consent-id")).toHaveText(id);
    await expect(dialog(page).getByRole("link", { name: "Download my consent record" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goto("/grievance");
    await settle(page);
    await expect(page.getByLabel("Cookie consent ID (optional)")).toHaveValue(id);
  });

  test("a receipt the server did not acknowledge stays pending and is resent on the next load", async ({ page }) => {
    await page.route("**/api/consent", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
    await page.goto("/");
    await settle(page);
    await banner(page).getByRole("button", { name: "Reject all" }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("cnote_consent_pending") !== null)).toBe(true);
    await page.unroute("**/api/consent");
    await page.reload();
    await settle(page);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("cnote_consent_pending")), { message: "pending receipt was not resent" }).toBeNull();
  });
});

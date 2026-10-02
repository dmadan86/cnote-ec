/**
 * Cookie consent in the SELLER app (apps/seller/src/features/consent, docs/design/cookie-consent.md "Other apps"): the first-layer
 * banner, the preferences dialog with only the categories this app has storage for, the optional cookies (`seller_ref` = marketing,
 * `seller_onb_t0` = analytics) that are written only after opt-in, and the receipt stored with app = "seller".
 * Standards: DPDP Act 2023 s.6, ePrivacy Art 5(3), EDPB Cookie Banner Taskforce (equal buttons).
 *
 * The seller app is not held to the WCAG gate, but the dialog and banner are the same shared components, so the basics are checked.
 */
import { optionalEntries, stripCookiePrefix } from "../../packages/consent/src/registry";
import { SELLER_CONSENT_COOKIE, SELLER_POLICY_VERSION, SELLER_STORAGE_REGISTRY } from "../../apps/seller/src/features/consent/registry";
import { SELLER_URL } from "../support/env";
import { expect, test, type Page } from "../support/fixtures";
import { receiptsOf } from "../support/consent-db";

test.use({ baseURL: SELLER_URL, consent: false });

const banner = (page: Page) => page.getByRole("region", { name: "Cookie notice" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Cookie preferences" });
const cookies = async (page: Page) => Object.fromEntries((await page.context().cookies()).map((c) => [c.name, c.value]));
const consentOf = async (page: Page) => {
  const raw = (await cookies(page))[SELLER_CONSENT_COOKIE];
  return raw ? new URLSearchParams(decodeURIComponent(raw)) : null;
};
const receipt = (page: Page) => page.waitForResponse((r) => r.url().endsWith("/api/consent") && r.request().method() === "POST");

test.describe("first visit", () => {
  test("asks a new visitor with equal Accept all / Reject all / Customise, stores nothing optional, and the page stays usable", async ({ page }) => {
    await page.goto("/");
    const b = banner(page);
    await expect(b).toBeVisible();
    await expect(b).toContainText("data fiduciary");
    const buttons = ["Accept all", "Reject all", "Customise"].map((n) => b.getByRole("button", { name: n }));
    for (const btn of buttons) await expect(btn).toBeVisible();
    const looks = await Promise.all(buttons.map((btn) => btn.evaluate((el) => { const s = getComputedStyle(el); return JSON.stringify({ h: Math.round(el.getBoundingClientRect().height), bg: s.backgroundColor, color: s.color, border: s.borderColor, weight: s.fontWeight }); })));
    expect(new Set(looks).size).toBe(1); // equal prominence (EDPB)
    await expect(page.locator("dialog[open]")).toHaveCount(0); // not a wall
    await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();
    const c = await cookies(page);
    expect(c[SELLER_CONSENT_COOKIE]).toBeUndefined();
    expect(Object.keys(c).filter((k) => /^seller_(ref|onb_t0)/.test(k))).toEqual([]);
  });

  test("a referral link is NOT remembered before the visitor consents", async ({ page }) => {
    await page.goto("/?ref=FRIEND2026");
    await expect(banner(page)).toBeVisible();
    expect((await cookies(page)).seller_ref).toBeUndefined();
  });

  test("the buyer web's consent is not the seller's: a cnote_consent cookie never hides the seller banner", async ({ context, page, baseURL }) => {
    await context.addCookies([{ name: "cnote_consent", value: "v%3D4%26id%3D" + "a".repeat(32) + "%26a%3D1%26m%3D1%26f%3D1%26t%3D" + (Math.floor(Date.now() / 1000) - 60) + "%26gpc%3D0", url: baseURL! }]);
    await page.goto("/");
    await expect(banner(page)).toBeVisible();
  });
});

test.describe("runtime storage audit", () => {
  // The browser's real storage after a choice must be inside the registry, and nothing optional may exist unless it was granted
  // (the source-level test cannot see what the browser actually stores).
  const known = new Set(SELLER_STORAGE_REGISTRY.map((e) => e.name));
  const optional = new Set(optionalEntries(SELLER_STORAGE_REGISTRY).map((e) => e.name));
  const audit = async (page: Page) => {
    const cookieNames = (await page.context().cookies()).map((c) => stripCookiePrefix(c.name));
    const local = await page.evaluate(() => Object.keys(localStorage));
    const session = await page.evaluate(() => Object.keys(sessionStorage));
    return { cookieNames, storage: [...local, ...session] };
  };

  test("after Reject all, on the public pages: every key is registered and nothing optional exists", async ({ page }) => {
    await page.goto("/?ref=AUDIT2026");
    const posted = receipt(page);
    await banner(page).getByRole("button", { name: "Reject all" }).click();
    await posted;
    for (const path of ["/", "/signin", "/signup", "/forgot-password"]) {
      await page.goto(path);
      const { cookieNames, storage } = await audit(page);
      expect(cookieNames.filter((k) => !known.has(k)), `${path}: unregistered cookies`).toEqual([]);
      expect(storage.filter((k) => !known.has(k)), `${path}: unregistered storage`).toEqual([]);
      expect([...cookieNames, ...storage].filter((k) => optional.has(k)), `${path}: optional storage without consent`).toEqual([]);
    }
  });
});

test.describe("choices", () => {
  test("Reject all: stored as denied, receipt recorded for app=seller, banner gone after reload, a later referral link is not stored", async ({ page }) => {
    await page.goto("/");
    const posted = receipt(page);
    await banner(page).getByRole("button", { name: "Reject all" }).click();
    const res = await posted;
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toMatchObject({ action: "reject_all", analytics: false, marketing: false, policyVersion: SELLER_POLICY_VERSION });
    await expect(banner(page)).toHaveCount(0);
    const c = await consentOf(page);
    expect([c?.get("v"), c?.get("a"), c?.get("m")]).toEqual([String(SELLER_POLICY_VERSION), "0", "0"]);
    const id = c!.get("id")!;
    await expect.poll(async () => (await receiptsOf(id)).length, { message: "receipt not stored" }).toBe(1);
    const row = (await receiptsOf(id))[0]!;
    expect(row).toMatchObject({ app: "seller", policy_version: SELLER_POLICY_VERSION, analytics: false, marketing: false, functional: false, action: "reject_all" });
    expect(row.registry_hash).toMatch(/^[a-f0-9]{64}$/); // what the seller was shown, provable later
    await page.goto("/?ref=FRIEND2026");
    await expect(banner(page)).toHaveCount(0);
    expect((await cookies(page)).seller_ref).toBeUndefined();
    // the buyer web's cookie was never touched
    expect((await cookies(page)).cnote_consent).toBeUndefined();
  });

  test("Accept all on a referral landing page still credits the referrer: the code is stored right after the grant", async ({ page }) => {
    await page.goto("/?ref=FRIEND2026");
    expect((await cookies(page)).seller_ref).toBeUndefined();
    const stored = page.waitForResponse((r) => r.url().endsWith("/api/consent/ref") && r.request().method() === "POST");
    await banner(page).getByRole("button", { name: "Accept all" }).click();
    expect((await stored).status()).toBe(200);
    await expect.poll(async () => (await cookies(page)).seller_ref).toBe("FRIEND2026");
    const c = await consentOf(page);
    expect([c?.get("a"), c?.get("m")]).toEqual(["1", "1"]);
  });

  test("with marketing already granted, the proxy stores the referral code on landing", async ({ page }) => {
    await page.goto("/");
    await banner(page).getByRole("button", { name: "Accept all" }).click();
    await expect(banner(page)).toHaveCount(0);
    await page.goto("/signin?ref=SECOND2026");
    await expect.poll(async () => (await cookies(page)).seller_ref).toBe("SECOND2026");
  });

  test("Customise lists only the categories this app has (necessary, analytics, marketing), nothing pre-ticked, with the real cookie names", async ({ page }) => {
    await page.goto("/");
    await banner(page).getByRole("button", { name: "Customise" }).click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    await expect(banner(page)).toBeHidden();
    await expect(d.getByText("Always active")).toBeVisible();
    await expect(d.getByRole("switch", { name: "Analytics" })).toHaveAttribute("aria-checked", "false");
    await expect(d.getByRole("switch", { name: "Marketing and attribution" })).toHaveAttribute("aria-checked", "false");
    await expect(d.getByRole("switch", { name: "Preferences and personalisation" })).toHaveCount(0); // no storage for it, so no switch
    await d.getByRole("button", { name: "Marketing and attribution" }).click();
    await expect(d.getByRole("rowheader", { name: /seller_ref/ })).toBeVisible();
    await d.getByRole("button", { name: "Analytics" }).click();
    await expect(d.getByRole("rowheader", { name: /seller_onb_t0/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(d).toBeHidden();
    await expect(banner(page)).toBeVisible();
    expect(await consentOf(page)).toBeNull(); // dismissing is not a choice
  });

  test("Cookie settings reopens the dialog without a reload; withdrawing marketing deletes seller_ref and is recorded as a withdrawal", async ({ page }) => {
    await page.goto("/signin?ref=THIRD2026");
    await banner(page).getByRole("button", { name: "Accept all" }).click();
    await expect.poll(async () => (await cookies(page)).seller_ref).toBe("THIRD2026");
    await page.reload();
    await page.evaluate(() => { (window as unknown as { __m: number }).__m = 1; });
    await page.getByRole("button", { name: "Cookie settings" }).click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __m?: number }).__m)).toBe(1); // no reload
    const marketing = d.getByRole("switch", { name: "Marketing and attribution" });
    await expect(marketing).toHaveAttribute("aria-checked", "true");
    await marketing.click();
    const posted = receipt(page);
    await d.getByRole("button", { name: "Save choices" }).click();
    const res = await posted;
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toMatchObject({ action: "withdraw", analytics: true, marketing: false });
    // the httpOnly cookie is expired by the server's response
    await expect.poll(async () => (await cookies(page)).seller_ref).toBeUndefined();
    const id = (await consentOf(page))!.get("id")!;
    await expect.poll(async () => (await receiptsOf(id)).map((r) => r.action)).toEqual(["accept_all", "withdraw"]);
    expect((await receiptsOf(id)).every((r) => r.app === "seller")).toBe(true);
  });

  test("Global Privacy Control: Accept all leaves marketing off", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, locale: "en-IN", extraHTTPHeaders: { "sec-gpc": "1" } });
    await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true, configurable: true }));
    const page = await context.newPage();
    await page.goto("/");
    await banner(page).getByRole("button", { name: "Accept all" }).click();
    const c = await consentOf(page);
    expect([c?.get("a"), c?.get("m"), c?.get("gpc")]).toEqual(["1", "0", "1"]);
    await context.close();
  });

  test("is localised: Hindi when the seller chose Hindi", async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "seller_locale", value: "hi", url: baseURL! }]);
    await page.goto("/");
    const b = page.getByRole("region", { name: "कुकी सूचना" });
    await expect(b).toBeVisible();
    await expect(b.getByRole("button", { name: "सभी स्वीकार करें" })).toBeVisible();
  });
});

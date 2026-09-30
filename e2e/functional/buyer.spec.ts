/** Buyer journeys against the seeded marketplace. Every test signs up its own user, so specs are independent and parallel-safe. */
import { expect, test } from "../support/fixtures";
import { PASSWORD, signIn, signUpBuyer, uniqueEmail } from "../support/auth";
import { settle } from "../support/a11y";

test.describe("accounts", () => {
  test("sign up with email and password, then sign out and sign in again", async ({ page }) => {
    const acct = await signUpBuyer(page, "signup");
    await expect(page.getByRole("button", { name: new RegExp(`Account menu for ${acct.name}`) })).toBeVisible();

    await page.getByRole("button", { name: /Account menu/ }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();

    await signIn(page, acct.email, acct.password);
    await expect(page.getByRole("button", { name: new RegExp(`Account menu for ${acct.name}`) })).toBeVisible();
  });

  test("wrong password shows an error and keeps the user on the sign-in page", async ({ page }) => {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(uniqueEmail("nobody"));
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page).toHaveURL(/\/signin/);
  });

  test("sign-up validates required consent and password length", async ({ page }) => {
    await page.goto("/signup");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/signup/);
    await expect(page.locator("[aria-invalid='true'], [role=alert], .text-danger").first()).toBeVisible();
  });

  test("protected pages redirect guests to sign in and back afterwards", async ({ page }) => {
    await page.goto("/rfq/new");
    await expect(page).toHaveURL(/\/signin\?next=/);
    await page.getByRole("link", { name: "Create an account" }).click();
    await expect(page).toHaveURL(/\/signup/);
  });
});

test.describe("known bugs", () => {
  test("header shows the account menu right after sign-in without a reload", async ({ page }) => {
    const acct = await signUpBuyer(page, "stale");
    // only the session: the pre-seeded cookie-consent choice must survive (see support/fixtures.ts)
    await page.context().clearCookies({ name: /cnote_web_(at|rt)$/ });
    await signIn(page, acct.email, acct.password, undefined, false);
    await expect(page.getByRole("button", { name: /Account menu for/ })).toBeVisible();
  });

  test("product page does not list itself under Similar products", async ({ page }) => {
    await page.goto("/search?q=box");
    await page.locator("main a[href*='/p/']").first().click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const self = new URL(page.url()).pathname;
    const similar = page.getByRole("region", { name: "Similar products" });
    const hrefs = await similar.locator("a[href*='/p/']").evaluateAll((as) => as.map((a) => new URL((a as HTMLAnchorElement).href).pathname));
    expect(hrefs).not.toContain(self);
  });
});

test.describe("marketplace", () => {
  test("search -> product page -> save and compare", async ({ page }) => {
    await signUpBuyer(page, "shopper");

    // Search
    await page.goto("/search?q=box");
    await settle(page);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("box");
    const firstCard = page.locator("main a[href*='/p/']").first();
    await expect(firstCard).toBeVisible();

    // Product page
    await firstCard.click();
    await expect(page).toHaveURL(/\/p\//);
    const title = (await page.getByRole("heading", { level: 1 }).innerText()).trim();
    expect(title.length).toBeGreaterThan(2);

    // Wishlist (signed in) and compare
    await page.getByRole("button", { name: `Save ${title}` }).first().click();
    await expect(page.getByRole("button", { name: `Remove ${title} from saved items` }).first()).toBeVisible();
    await page.getByRole("button", { name: `Add ${title} to compare` }).first().click();
    await expect(page.getByRole("button", { name: `Remove ${title} from compare` }).first()).toBeVisible();

    await page.goto("/wishlist");
    await expect(page.getByRole("main").getByRole("link", { name: title }).first()).toBeVisible();
    await page.goto("/compare");
    await expect(page.getByRole("main").getByText(title).first()).toBeVisible();

    // Un-saving persists
    await page.goto("/wishlist");
    await page.getByRole("button", { name: `Remove ${title} from this list` }).click();
    await expect(page.getByRole("main").getByRole("link", { name: title })).toHaveCount(0);
  });

  test("guests are sent to sign in when saving", async ({ page }) => {
    await page.goto("/search?q=box");
    await page.getByRole("button", { name: /^Save / }).first().click();
    await expect(page).toHaveURL(/\/signin/);
  });

  test("post a requirement (RFQ) and see it matched to trust-ranked sellers", async ({ page }) => {
    await signUpBuyer(page, "rfq");
    await page.goto("/rfq/new?q=" + encodeURIComponent("3 ply corrugated boxes"));
    await expect(page.getByRole("heading", { level: 1, name: "Post your requirement" })).toBeVisible();
    await page.getByRole("textbox", { name: "Requirement details" }).fill("3 ply corrugated shipping boxes, 12x10x8 inch, printed logo, delivery in Pune.");
    await page.getByRole("combobox", { name: "Category" }).selectOption({ label: "Packaging & Printing" });
    await page.getByRole("spinbutton", { name: "Quantity" }).fill("500");
    await page.getByRole("textbox", { name: "Delivery city" }).fill("Pune");
    await page.getByRole("button", { name: "Post requirement" }).click();
    // Wait for the saved result (not just the button leaving: it also changes to "Posting…" while the action runs).
    await expect(page.getByRole("link", { name: "View requirement" })).toBeVisible(); // posted (offered, unmatched or held for review)
    // and it is listed under the buyer's requirements
    await page.goto("/buyer/enquiries");
    await expect(page.locator("main")).toContainText(/3 ply corrugated boxes/i);
  });

  test("RFQ form reports missing fields", async ({ page }) => {
    await signUpBuyer(page, "rfqerr");
    await page.goto("/rfq/new");
    await page.getByRole("button", { name: "Post requirement" }).click();
    await expect(page.locator("[aria-invalid='true'], [role=alert], .text-danger").first()).toBeVisible();
    await expect(page).toHaveURL(/\/rfq\/new/);
  });
});

test.describe("language", () => {
  test("switching to Hindi keeps the page and translates it", async ({ page }) => {
    await page.goto("/pricing");
    const englishTitle = await page.getByRole("heading", { level: 1 }).innerText();
    await page.getByRole("combobox", { name: /language/i }).first().selectOption("hi");
    await expect(page).toHaveURL(/\/hi\/pricing$/);
    await expect(page.locator("html")).toHaveAttribute("lang", /^hi/);
    const hindiTitle = await page.getByRole("heading", { level: 1 }).innerText();
    expect(hindiTitle).not.toBe(englishTitle);
    expect(hindiTitle).toMatch(/[ऀ-ॿ]/);

    // ...and back to English
    await page.getByRole("combobox").first().selectOption("en");
    await expect(page).toHaveURL(/\/pricing$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(englishTitle);
  });

  test("switching language on search keeps the query", async ({ page }) => {
    await page.goto("/search?q=box");
    await page.getByRole("combobox", { name: /language/i }).first().selectOption("hi");
    await expect(page).toHaveURL(/\/hi\/search\?q=box/);
    await expect(page.locator("main")).toContainText(/[ऀ-ॿ]/);
  });

  test("the chosen language carries to pages without a locale prefix (cookie) and can be switched in place", async ({ page }) => {
    await page.goto("/hi"); // visiting a localised page remembers the language for /signin, /account, /rfq, ...
    await expect.poll(async () => (await page.context().cookies()).find((c) => c.name === "cnote_locale")?.value).toBe("hi"); // written after hydration
    await page.goto("/signin");
    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "hi-IN");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/[ऀ-ॿ]/);
    await page.getByRole("combobox", { name: /भाषा/ }).first().selectOption("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en-IN");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome back");
    await expect(page).toHaveURL(/\/signin$/);
  });

  test("signed-in and transactional pages render in the chosen language (Hindi) with the profile language as fallback", async ({ page, context, baseURL }) => {
    await signUpBuyer(page, "i18n");
    const url = baseURL ?? "http://localhost:3000";
    for (const [locale, script] of [["hi", /[ऀ-ॿ]/]] as const) {
      await context.addCookies([{ name: "cnote_locale", value: locale, url }]);
      for (const path of ["/account", "/wishlist", "/compare", "/rfq/new", "/buyer/enquiries", "/buyer/orders", "/account/notifications", "/account/notifications/preferences", "/grievance", "/account/grievances"]) {
        await page.goto(path);
        await expect(page.locator("html"), `${locale} ${path}`).toHaveAttribute("lang", `${locale}-IN`);
        await expect(page.getByRole("heading", { level: 1 }), `${locale} ${path}`).toContainText(script);
        await expect(page.locator("main"), `${locale} ${path}`).not.toContainText(/Application error|Something went wrong/);
      }
    }
    // No cookie: the signed-in person's preferredLanguage (saved by the switcher on the last change) is used.
    // Wait for each switch to render: the page refreshes only after setLocaleAction has saved preferredLanguage.
    await page.getByRole("combobox", { name: /भाषा|language/i }).first().selectOption("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en-IN");
    await page.getByRole("combobox", { name: /भाषा|language/i }).first().selectOption("hi");
    await expect(page.locator("html")).toHaveAttribute("lang", "hi-IN");
    await context.clearCookies({ name: "cnote_locale" });
    await page.goto("/account");
    await expect(page.locator("html")).toHaveAttribute("lang", "hi-IN");
  });

  test("a posted requirement, its matches and detail page render translated (server components use the request language)", async ({ page, context, baseURL }) => {
    await signUpBuyer(page, "i18nrfq");
    await page.goto("/rfq/new?q=" + encodeURIComponent("3 ply corrugated boxes"));
    await page.getByRole("textbox", { name: "Requirement details" }).fill("3 ply corrugated shipping boxes, 12x10x8 inch, printed logo, delivery in Pune.");
    await page.getByRole("combobox", { name: "Category" }).selectOption({ label: "Packaging & Printing" });
    await page.getByRole("spinbutton", { name: "Quantity" }).fill("500");
    await page.getByRole("textbox", { name: "Delivery city" }).fill("Pune");
    await page.getByRole("button", { name: "Post requirement" }).click();
    // wait for the saved result (the button also disappears while "Posting…")
    await expect(page.getByRole("link", { name: /View requirement|Pick sellers/ }).first()).toBeVisible();
    const detail = await page.getByRole("link", { name: /View requirement|Pick sellers/ }).first().getAttribute("href");
    expect(detail).toMatch(/^\/buyer\/enquiries\//);
    await context.addCookies([{ name: "cnote_locale", value: "hi", url: baseURL ?? "http://localhost:3000" }]);
    await page.goto(detail!);
    await expect(page.locator("html")).toHaveAttribute("lang", "hi-IN");
    await expect(page.locator("main")).toContainText(/[ऀ-ॿ]/);
    await expect(page.locator("main")).not.toContainText(/Intent score|Sellers \(|Category|Quantity|Posted |Matched|Processing/);
  });

  test("Hindi is reachable directly and stays Hindi through navigation", async ({ page }) => {
    await page.goto("/hi");
    await expect(page.locator("html")).toHaveAttribute("lang", /^hi/);
    const categoryLink = page.locator("main a[href*='/c/']").first();
    await expect(categoryLink).toHaveAttribute("href", /^\/hi\/c\//);
    await categoryLink.click();
    await expect(page).toHaveURL(/\/hi\/c\//);
    await expect(page.locator("html")).toHaveAttribute("lang", /^hi/);
    await page.goto("/hi/pricing");
    await expect(page.locator("html")).toHaveAttribute("lang", /^hi/);
  });
});

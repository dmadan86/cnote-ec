/** Seller app (port 3002): sign-up, onboarding, first listing submitted for review, language switch. */
import { expect, test, type Page } from "../support/fixtures";
import { DEMO, SELLER_URL } from "../support/env";
import { PASSWORD, uniqueEmail } from "../support/auth";

test.use({ baseURL: SELLER_URL });

async function signUpSeller(page: Page, tag = "seller") {
  const acct = { name: `E2E ${tag}`, email: uniqueEmail(tag), password: PASSWORD };
  await page.goto("/signup");
  await page.getByRole("textbox", { name: "Your name" }).fill(acct.name);
  await page.getByRole("textbox", { name: "Email" }).fill(acct.email);
  await page.getByLabel("Password").fill(acct.password);
  await page.getByRole("checkbox", { name: /matched buyer leads/i }).check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  return acct;
}

test.describe("seller onboarding", () => {
  test("sign up -> business -> phone -> skip GST -> first listing from the form -> submitted for review", async ({ page }) => {
    await signUpSeller(page, "onboard");

    // Step 1: business
    await expect(page.getByRole("heading", { level: 1, name: "Tell us about your business" })).toBeVisible();
    await page.getByRole("textbox", { name: "Business name" }).fill("E2E Packaging Co");
    await page.getByRole("textbox", { name: "City" }).fill("Surat");
    await page.getByRole("combobox", { name: "State" }).selectOption("Gujarat");
    await page.getByRole("textbox", { name: "Pincode" }).fill("395003");
    // Business languages default to Hindi + English and the app then switches to the seller's language;
    // keep this journey English (Hindi is covered by the language test below).
    await page.getByRole("checkbox", { name: "हिन्दी" }).uncheck();
    await page.getByRole("button", { name: "Save and continue" }).click();

    // Step 2: phone OTP (dev mode echoes the code on screen; OTP_DEV_ECHO=true)
    await expect(page.getByRole("heading", { level: 1, name: "Verify your phone" })).toBeVisible();
    const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
    await page.getByRole("textbox", { name: "Mobile number" }).fill(phone);
    await page.getByRole("button", { name: "Send code" }).click();
    const code = await page.locator("code, strong.font-mono").first().innerText();
    expect(code).toMatch(/^\d{4,8}$/);
    await page.getByRole("textbox", { name: /Enter the code/ }).fill(code);
    await page.getByRole("button", { name: "Verify and continue" }).click();

    // Step 3: GST is optional
    await expect(page.getByRole("heading", { level: 1, name: "Verify your GST" })).toBeVisible();
    await page.getByRole("button", { name: /skip for now/i }).click();

    // Step 4: first listing, filled in by hand
    await expect(page.getByRole("heading", { level: 1, name: "Add your first listing" })).toBeVisible();
    await page.getByRole("link", { name: "I prefer to fill in a form" }).click();
    await page.getByRole("combobox", { name: "Category" }).selectOption({ label: "Packaging & Printing" });
    await page.getByRole("textbox", { name: "Title" }).fill("E2E Corrugated Shipping Boxes");
    await page.getByRole("textbox", { name: "Description" }).fill("Five-ply corrugated shipping boxes in custom sizes with one-colour print. Made in Surat, ships across India.");
    await page.getByRole("textbox", { name: /Price/ }).first().fill("18");
    // Category specs are data-driven; "Material" is required to publish for this category.
    await page.getByRole("combobox", { name: /^Material/ }).selectOption("Corrugated");
    await page.getByRole("button", { name: "Save and submit for review" }).click();
    // Signing up already granted the matching consent, so once a listing exists onboarding is complete and the app moves
    // on to the dashboard (or shows the plan step first when consent is missing).
    // The outcome is shown before moving on (previously the redirect hid it).
    await expect(page.getByText("Submitted for review")).toBeVisible();
    const planStep = page.getByRole("heading", { level: 1, name: "Plan and permissions" });
    const dashboard = page.getByRole("heading", { level: 1, name: /^Welcome,/ });
    if (await planStep.isVisible()) {
      await page.getByRole("button", { name: /Finish|Start/ }).click();
    } else {
      await page.getByRole("link", { name: "Go to dashboard" }).click();
    }
    await expect(dashboard).toBeVisible();

    // The listing is in the portal, awaiting review or approved
    await page.goto("/listings");
    await expect(page.getByText("E2E Corrugated Shipping Boxes")).toBeVisible();
    // Version status badge: waiting for review, or already cleared by the automatic checks.
    await expect(page.getByText(/Pending: v1|Live: v1/).first()).toBeVisible();
  });

  test("guests are redirected to sign in and sign-up validates", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/signin/);
    await page.goto("/signup");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/signup/);
  });
});

async function signInDemoSeller(page: Page) {
  await page.goto("/signin");
  await page.getByRole("textbox", { name: "Email" }).fill(DEMO.seller.email);
  await page.getByLabel("Password").fill(DEMO.seller.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/signin/);
}


test.describe("seller portal", () => {
  test("demo seller signs in and sees the dashboard and listings", async ({ page }) => {
    await signInDemoSeller(page);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Welcome");
    await page.goto("/listings");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your listings");
    await expect(page.getByText("Min. order").first()).toBeVisible();
  });

  test("create a listing from the form in the portal and submit it for review", async ({ page }) => {
    await signInDemoSeller(page);
    const title = `E2E Portal Listing ${Date.now()}`;
    await page.goto("/listings/new?mode=manual");
    await page.getByRole("combobox", { name: "Category" }).selectOption({ label: "Packaging & Printing" });
    await page.getByRole("textbox", { name: "Title" }).fill(title);
    await page.getByRole("textbox", { name: "Description" }).fill("Kraft paper mailer bags, three sizes, plain or one-colour print, packed in bundles of one hundred.");
    await page.getByRole("combobox", { name: /^Material/ }).selectOption("Kraft paper");
    await page.getByRole("button", { name: "Save and submit for review" }).click();
    await expect(page.getByRole("heading", { level: 2, name: /Submitted for review|Approved: going live shortly/ })).toBeVisible();
    await page.getByRole("link", { name: /Back to listings|listings/i }).first().click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  });

  test("language switch translates the portal and is remembered across pages", async ({ page }) => {
    await signInDemoSeller(page);
    await page.goto("/listings");
    await page.getByRole("combobox", { name: "Language" }).selectOption("hi");
    await expect(page.locator("html")).toHaveAttribute("lang", /^hi/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/[\u0900-\u097F]/);
    await page.goto("/dashboard");
    await expect(page.locator("html")).toHaveAttribute("lang", /^hi/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/[\u0900-\u097F]/);
    await page.getByRole("combobox").first().selectOption("en");
    await expect(page.locator("html")).toHaveAttribute("lang", /^en/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Welcome");
  });
});

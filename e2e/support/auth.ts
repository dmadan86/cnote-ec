import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

export const PASSWORD = "E2e-Passw0rd!2026";

/** Unique per call so specs stay independent and parallel-safe (`e2e-<hex>@example.com`). */
export const uniqueEmail = (tag = "u") => `e2e-${tag}-${randomUUID().slice(0, 8)}@example.com`;

/** `reload` forces a full page load after signing in (off by default; the header refreshes itself after auth pages). */
export async function signIn(page: Page, email: string, password: string, next?: string, reload = false): Promise<void> {
  await page.goto(next ? `/signin?next=${encodeURIComponent(next)}` : "/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/signin/);
  if (reload) await page.reload();
}

export interface Account {
  name: string;
  email: string;
  password: string;
}

/**
 * Buyer sign-up through the real UI (email + password, consent checkbox), then the business step that follows.
 * Bot protection is off in e2e (HUMAN_VERIFIER=off), so there is no Turnstile to solve. Ends signed in on "/".
 */
export async function signUpBuyer(page: Page, tag = "buyer"): Promise<Account> {
  const acct = { name: `E2E ${tag}`, email: uniqueEmail(tag), password: PASSWORD };
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(acct.name);
  await page.getByLabel("Email").fill(acct.email);
  await page.getByLabel("Password").fill(acct.password);
  await page.getByRole("checkbox", { name: /shared with matching sellers/i }).check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("textbox", { name: "Business name" }).fill(`E2E Traders ${acct.email.slice(-20, -12)}`);
  await page.getByRole("textbox", { name: "City" }).fill("Pune");
  await page.getByRole("textbox", { name: "Pincode" }).fill("411001");
  await page.getByRole("combobox", { name: "State" }).selectOption("Maharashtra");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).not.toHaveURL(/\/onboarding/);
  return acct;
}

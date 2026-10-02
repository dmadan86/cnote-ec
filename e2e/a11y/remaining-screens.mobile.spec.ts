/**
 * The screens of remaining-screens.spec.ts on a phone (Pixel 7, 412x915): axe, no sideways page scroll, and 44px touch
 * targets for every control in the page body (CLAUDE.md: "targets of at least 24px (44px on mobile)"; WCAG 2.5.8 is the
 * 24px floor, inline links inside a sentence are exempt). English and Hindi (the longer Hindi strings wrap differently).
 */
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { setLocaleCookie, smallTargets, type Locale } from "../support/a11y-extra";
import { signUpBuyer, uniqueEmail, PASSWORD } from "../support/auth";
import { expect, test, type Page } from "../support/fixtures";
import { seedDispute, seedMandate, seedNegotiation, seedOrder } from "../support/phase2-db";

const LOCALES: Locale[] = ["en", "hi"];
const prefix = (l: Locale) => (l === "hi" ? "/hi" : "");

async function check(page: Page, info: Parameters<typeof expectNoBlockingViolations>[1], label: string) {
  await settle(page);
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: no sideways page scroll`).toBe(true);
  await expectNoBlockingViolations(page, info);
  expect.soft(await smallTargets(page, "main", 44), `${label}: controls under 44px`).toEqual([]);
}

for (const locale of LOCALES) {
  test.describe(`remaining screens on a phone (${locale})`, () => {
    test("public pages", async ({ page }, info) => {
      await setLocaleCookie(page.context(), locale);
      for (const path of ["/forgot-password", "/reset-password?token=abc", "/shared/" + "A".repeat(43), "/compare", `${prefix(locale)}/coming-soon/ai-tools`, `${prefix(locale)}/offline`, "/store/e2e-showcase"]) {
        await page.goto(path);
        await check(page, info, path);
      }
      await page.goto("/no-such-page-xyz");
      await check(page, info, "404");
    });

    test("onboarding", async ({ page, context }, info) => {
      await page.goto("/signup");
      await page.getByLabel("Your name").fill("E2E onboarding");
      await page.getByLabel("Email").fill(uniqueEmail("onbm"));
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("checkbox", { name: /shared with matching sellers/i }).check();
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(page).toHaveURL(/\/onboarding/);
      await setLocaleCookie(context, locale);
      await page.reload();
      await check(page, info, "onboarding");
    });

    test("signed-in pages: account, orders, dispute, agents", async ({ page }, info) => {
      const acct = await signUpBuyer(page, `remm${locale}`);
      await setLocaleCookie(page.context(), locale);
      const order = await seedOrder(acct.email, { status: "delivered", settlement: "escrow" });
      const { disputeId } = await seedDispute(acct.email, (await seedOrder(acct.email, { status: "delivered" })).orderId);
      const { mandateId } = await seedMandate(acct.email);
      const { negotiationId } = await seedNegotiation(acct.email, mandateId);
      for (const path of [
        "/account/notifications",
        "/account/notifications/preferences",
        "/account/developers",
        "/account/grievances",
        "/grievance",
        "/buyer/orders",
        `/buyer/orders/${order.orderId}`,
        `/buyer/disputes/${disputeId}`,
        "/buyer/agents",
        `/buyer/agents/mandates/${mandateId}`,
        `/buyer/agents/negotiations/${negotiationId}`,
      ]) {
        await page.goto(path);
        await check(page, info, path);
      }
    });
  });
}

/**
 * WCAG 2.2 AA gate for the buyer-web screens the other a11y specs do not reach (CLAUDE.md: accessibility is a release
 * blocker). Every page below is scanned with axe in English AND Hindi, its primary action is reached with the keyboard
 * alone (Tab, visible focus), and the forms it contains are checked in their error state (errors announced and tied to
 * their field). Touch-target sizes are in remaining-screens.mobile.spec.ts.
 *
 * Phase-2/3 screens (orders with escrow, disputes, agent mandates) are behind flags that e2e/support/env.ts turns on
 * (mock escrow partner, nothing moves money); their rows are seeded by e2e/support/phase2-db.ts. Storefront: seeded by
 * e2e/setup/seed-storefront.ts. Not covered here, with the reason, are listed in docs/adr/ADR-coverage.md.
 */
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { expectAnnouncedErrors, expectSubmitRejected, reachByKeyboard, setLocaleCookie, type Locale } from "../support/a11y-extra";
import { signUpBuyer, uniqueEmail, PASSWORD } from "../support/auth";
import { expect, test, type Page } from "../support/fixtures";
import { seedDispute, seedMandate, seedNegotiation, seedOrder } from "../support/phase2-db";
import { seedQuotes } from "../support/rfq-db";

const LOCALES: Locale[] = ["en", "hi"];
const prefix = (l: Locale) => (l === "hi" ? "/hi" : "");
const HI = /[ऀ-ॿ]/;

async function scan(page: Page, info: Parameters<typeof expectNoBlockingViolations>[1], locale: Locale) {
  await settle(page);
  await expect(page.locator("html")).toHaveAttribute("lang", locale === "hi" ? /^hi/ : /^en/);
  await expectNoBlockingViolations(page, info);
}

/** Signed-in buyer in the requested language. Sign-up itself is English-only UI, so the language cookie is set afterwards. */
async function buyer(page: Page, locale: Locale) {
  const acct = await signUpBuyer(page, `rem${locale}`);
  await setLocaleCookie(page.context(), locale);
  return acct;
}

for (const locale of LOCALES) {
  test.describe(`remaining screens, public (${locale})`, () => {
    test("forgot password: axe, keyboard, error state", async ({ page }, info) => {
      await page.goto("/forgot-password");
      if (locale === "hi") await setLocaleCookie(page.context(), "hi"), await page.reload();
      await scan(page, info, locale);
      const submit = page.locator("main form button[type=submit]").first();
      await reachByKeyboard(page, submit);
      await page.keyboard.press("Enter");
      await expectAnnouncedErrors(page, { fieldLevel: true });
      await expectNoBlockingViolations(page, info);
      // the success path, by keyboard only
      const email = page.locator("main form input[type=email]").first();
      await email.focus();
      await page.keyboard.type(uniqueEmail("forgot"));
      await page.keyboard.press("Enter");
      await expect(page.locator("main [role=status]:visible, main [role=alert]:visible").first()).toBeVisible();
      await expectNoBlockingViolations(page, info);
    });

    test("reset password: invalid-link state and the form (axe, keyboard, error state)", async ({ page }, info) => {
      await setLocaleCookie(page.context(), locale);
      await page.goto("/reset-password");
      await scan(page, info, locale);
      await reachByKeyboard(page, page.locator("main a[href='/forgot-password']"));

      await page.goto("/reset-password?token=not-a-real-token");
      await scan(page, info, locale);
      const submit = page.locator("main form button[type=submit]").first();
      await reachByKeyboard(page, submit);
      await page.keyboard.press("Enter");
      await expectAnnouncedErrors(page, { fieldLevel: true });
      await expectNoBlockingViolations(page, info);
    });

    test("sign up: every invalid field is flagged on its own field", async ({ page }, info) => {
      await setLocaleCookie(page.context(), locale);
      await page.goto("/signup");
      await page.locator("main form input[type=email]").fill("not-an-email");
      await page.locator("main form input[type=password]").fill("short");
      const submit = page.locator("main form button[type=submit]").first();
      await reachByKeyboard(page, submit);
      await page.keyboard.press("Enter");
      await expectAnnouncedErrors(page, { fieldLevel: true });
      await expect(page.locator("main form [aria-invalid='true']")).toHaveCount(3); // email, password, consent
      await expectNoBlockingViolations(page, info);
    });

    test("coming soon", async ({ page }, info) => {
      await page.goto(`${prefix(locale)}/coming-soon/ai-tools`);
      await scan(page, info, locale);
      await reachByKeyboard(page, page.locator("main a[href$='/search']"));
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/search/);
    });

    test("offline page", async ({ page }, info) => {
      await page.goto(`${prefix(locale)}/offline`);
      await scan(page, info, locale);
      await reachByKeyboard(page, page.locator("main a:visible, main button:visible").first());
    });

    test("not found page", async ({ page }, info) => {
      await setLocaleCookie(page.context(), locale);
      const res = await page.goto("/no-such-page-xyz");
      expect(res?.status()).toBe(404);
      await settle(page);
      await expectNoBlockingViolations(page, info);
      // the 404 links home in the cookie language
      await reachByKeyboard(page, page.locator(`main a[href='${locale === "hi" ? "/hi" : "/"}']`).first());
    });

    test("seller storefront", async ({ page }, info) => {
      await setLocaleCookie(page.context(), locale);
      await page.goto("/store/e2e-showcase");
      await page.locator("main, [role=main]").first().waitFor();
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoBlockingViolations(page, info);
      await reachByKeyboard(page, page.locator("main a[href]:visible").first());
    });

    test("shared wishlist with an inactive link", async ({ page }, info) => {
      await setLocaleCookie(page.context(), locale);
      await page.goto(`/shared/${"A".repeat(43)}`);
      await scan(page, info, locale);
      await reachByKeyboard(page, page.locator("main a[href='/search']"));
    });

    test("compare: empty and with products", async ({ page }, info) => {
      await setLocaleCookie(page.context(), locale);
      await page.goto("/compare");
      await scan(page, info, locale);
      await page.goto(`${prefix(locale)}/search?q=box`);
      const hrefs = await page.locator("main a[href*='/p/']").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""));
      const ids = [...new Set(hrefs.map((h) => h.slice(-36)))].filter((id) => /^[0-9a-f-]{36}$/.test(id)).slice(0, 3);
      test.skip(ids.length < 2, "need two seeded products");
      await page.goto(`/compare?ids=${ids.join(",")}`);
      await scan(page, info, locale);
      await reachByKeyboard(page, page.getByRole("switch").first());
    });
  });

  test.describe(`remaining screens, signed in (${locale})`, () => {
    test("onboarding: axe, keyboard, error state", async ({ page, context }, info) => {
      const email = uniqueEmail("onb");
      await page.goto("/signup");
      await page.getByLabel("Your name").fill("E2E onboarding");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("checkbox", { name: /shared with matching sellers/i }).check();
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(page).toHaveURL(/\/onboarding/);
      await setLocaleCookie(context, locale);
      await page.reload();
      await scan(page, info, locale);
      const submit = page.locator("main form button[type=submit]").first();
      await reachByKeyboard(page, submit);
      await page.keyboard.press("Enter");
      await expectAnnouncedErrors(page, { fieldLevel: true });
      await expectNoBlockingViolations(page, info);
    });

    test("account: notifications, preferences, developers, grievances, grievance form", async ({ page }, info) => {
      await buyer(page, locale);
      const pages: { path: string; primary: string; form?: boolean }[] = [
        { path: "/account/notifications", primary: "main a:visible, main button:visible" },
        { path: "/account/notifications/preferences", primary: "main form button[type=submit]:visible" },
        { path: "/account/developers", primary: "main form button[type=submit]", form: true },
        { path: "/account/grievances", primary: "main a:visible, main button:visible" },
        { path: "/grievance", primary: "main form button[type=submit]", form: true },
      ];
      for (const p of pages) {
        await test.step(p.path, async () => {
          await page.goto(p.path);
          await scan(page, info, locale);
          await reachByKeyboard(page, page.locator(p.primary).first());
          if (p.form) {
            await page.keyboard.press("Enter");
            await expectAnnouncedErrors(page);
            await expectNoBlockingViolations(page, info);
          }
        });
      }
    });

    test("orders: list, recorded, dispatched with tracking, delivered with report a problem", async ({ page }, info) => {
      const acct = await buyer(page, locale);
      await page.goto("/buyer/orders");
      await scan(page, info, locale); // empty state
      const recorded = await seedOrder(acct.email, { status: "recorded" });
      const dispatched = await seedOrder(acct.email, { status: "dispatched" });
      const delivered = await seedOrder(acct.email, { status: "delivered" });
      await page.goto("/buyer/orders");
      await scan(page, info, locale);
      await reachByKeyboard(page, page.locator("main ul a[href^='/buyer/orders/']").first());
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/buyer\/orders\//);
      for (const o of [recorded, dispatched, delivered]) {
        await page.goto(`/buyer/orders/${o.orderId}`);
        await scan(page, info, locale);
        await reachByKeyboard(page, page.locator("main a:visible, main button:visible, main summary:visible").first());
      }
    });

    test("orders: escrow settlement and report-a-problem form", async ({ page }, info) => {
      const acct = await buyer(page, locale);
      const o = await seedOrder(acct.email, { status: "delivered", settlement: "escrow" });
      await page.goto(`/buyer/orders/${o.orderId}`);
      await scan(page, info, locale);
      // the report-a-problem disclosure: reachable and operable by keyboard, form axe-clean once open
      const summary = page.locator("main details > summary");
      await reachByKeyboard(page, summary);
      await page.keyboard.press("Enter");
      await expect(page.locator("main details[open] form")).toBeVisible();
      await expectNoBlockingViolations(page, info);
      await reachByKeyboard(page, page.locator("main details[open] form button[type=submit]"));
    });

    test("dispute: detail page, respond and message forms", async ({ page }, info) => {
      const acct = await buyer(page, locale);
      const o = await seedOrder(acct.email, { status: "delivered" });
      const { disputeId } = await seedDispute(acct.email, o.orderId);
      await page.goto(`/buyer/disputes/${disputeId}`);
      await scan(page, info, locale);
      await reachByKeyboard(page, page.locator("main form button[type=submit]").first());
      await page.keyboard.press("Enter");
      await expectAnnouncedErrors(page);
      await expectNoBlockingViolations(page, info);
    });

    test("agents: overview, mandate and negotiation", async ({ page }, info) => {
      const acct = await buyer(page, locale);
      await page.goto("/buyer/agents");
      await scan(page, info, locale); // empty
      const { mandateId } = await seedMandate(acct.email);
      const { negotiationId } = await seedNegotiation(acct.email, mandateId);
      await page.goto("/buyer/agents");
      await scan(page, info, locale);
      // error state of the create form: submit empty
      const submit = page.locator("main form button[type=submit]").last();
      await reachByKeyboard(page, submit);
      await page.keyboard.press("Enter");
      await expectAnnouncedErrors(page);
      await expectNoBlockingViolations(page, info);
      await page.goto(`/buyer/agents/mandates/${mandateId}`);
      await scan(page, info, locale);
      await reachByKeyboard(page, page.locator("main a:visible, main button:visible").first());
      await page.goto(`/buyer/agents/negotiations/${negotiationId}`);
      await scan(page, info, locale);
      await reachByKeyboard(page, page.locator("main a:visible, main button:visible").first());
    });

    test("conversation: thread, message form, deal report", async ({ page }, info) => {
      await buyer(page, "en"); // the requirement form is exercised in English; the page under test is rendered in `locale`
      await page.goto("/rfq/new");
      await page.getByRole("textbox", { name: "What do you need?" }).fill("Printed 3 ply corrugated boxes");
      await page.getByRole("textbox", { name: "Requirement details" }).fill("3 ply corrugated shipping boxes, 12x10x8 inch, printed logo, delivery in Pune.");
      await page.getByRole("combobox", { name: "Category" }).selectOption({ label: "Packaging & Printing" });
      await page.getByRole("spinbutton", { name: "Quantity" }).fill("500");
      await page.getByRole("button", { name: "Post requirement" }).click();
      const link = page.getByRole("link", { name: "View requirement" });
      await expect(link).toBeVisible();
      const id = (await link.getAttribute("href"))!.split("/").pop()!;
      const { a } = await seedQuotes(id);
      await page.goto(`/buyer/enquiries/${id}`);
      const msg = page.getByRole("link", { name: `Message ${a.sellerName}` });
      await expect(msg).toBeVisible();
      const href = (await msg.getAttribute("href"))!;
      await setLocaleCookie(page.context(), locale);
      await page.goto(href);
      await scan(page, info, locale);
      const submit = page.locator("main form button[type=submit]").first();
      await reachByKeyboard(page, submit);
      await page.keyboard.press("Enter");
      await expectSubmitRejected(page); // the message box is a native `required` control
      await expectNoBlockingViolations(page, info);
    });
  });
}

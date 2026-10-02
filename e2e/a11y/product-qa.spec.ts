/**
 * Product questions & answers on the PDP: axe scans of the section in its empty, ask and answered states, validation
 * errors announced to assistive tech, contact-detail stripping, the keyboard path, and the seller side answering.
 *
 * Journey (serial, one product): a buyer asks (with a phone number + email that must be removed), the seller-demo
 * account answers from the seller portal, the buyer sees the answer and finds it through the search box.
 * The PDP HTML is ISR-cached and purged by the worker, which e2e does not run, so the assertions on the public list go
 * through the live search endpoint (uncached) rather than the static first page.
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { signUpBuyer } from "../support/auth";
import { DEMO, SELLER_URL, e2eEnv } from "../support/env";

test.describe.configure({ mode: "serial" });

const word = `zorblax${randomUUID().slice(0, 6)}`;
const QUESTION = `Is the ${word} finish certified for food contact? Call me on 98765 43210 or mail buyer@example.com`;
const ANSWER = `Yes, the ${word} finish is food-grade certified. Reach us on 9123456789 if needed.`;
let listingId = "";
let title = "";

/** The seller-demo listing's public page, found the way a buyer would (search by its title). */
async function openProduct(page: import("@playwright/test").Page) {
  await page.goto(`/search?q=${encodeURIComponent(title)}`);
  const link = page.locator(`main a[href$='${listingId}']`).first();
  await link.waitFor();
  await page.goto((await link.getAttribute("href"))!);
  await settle(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
}

test("seller-demo's listing id and answer inbox are reachable", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: SELLER_URL, extraHTTPHeaders: { "cf-connecting-ip": "198.18.77.10" } });
  const page = await ctx.newPage();
  await page.goto("/signin");
  await page.getByLabel("Email").fill(DEMO.seller.email);
  await page.getByLabel("Password").fill(DEMO.seller.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/signin/);
  await page.goto("/listings");
  const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Edit" }) }).first();
  title = (await row.getByRole("heading", { level: 2 }).first().innerText()).trim();
  const link = row.getByRole("link", { name: "Edit" });
  const href = await link.getAttribute("href");
  listingId = /\/listings\/([0-9a-f-]{36})\/edit/.exec(href ?? "")?.[1] ?? "";
  expect(listingId).toMatch(/^[0-9a-f-]{36}$/);
  await page.goto("/questions");
  await expect(page.getByRole("heading", { level: 1, name: "Questions from buyers" })).toBeVisible();
  await ctx.close();
});

test.describe("buyer", () => {
  test("empty section passes axe; validation errors are announced; contact details are stripped; keyboard path works", async ({ page }, info) => {
    await signUpBuyer(page, "qa");
    await openProduct(page);
    const section = page.getByRole("region", { name: "Questions about this product" });
    await expect(section).toBeVisible();
    await expect(section.getByRole("heading", { level: 2 })).toBeVisible();
    await expect(section.getByText("No answered questions yet")).toBeVisible();
    await expect(section.getByRole("searchbox")).toHaveCount(0); // nothing to search yet
    await expect(section.getByRole("button", { name: "Send question" })).toBeVisible();
    await expectNoBlockingViolations(page, info);

    // Validation: an empty submit shows an error that is announced (role=alert) and wired to the field.
    const box = section.getByRole("textbox", { name: "Your question" });
    await section.getByRole("button", { name: "Send question" }).click();
    const alert = section.getByRole("alert");
    await expect(alert).toContainText("at least 10 characters");
    await expect(box).toHaveAttribute("aria-invalid", "true");
    const describedBy = (await box.getAttribute("aria-describedby")) ?? "";
    expect(describedBy.split(" ")).toContain((await alert.getAttribute("id")) ?? "missing");
    await expectNoBlockingViolations(page, info);

    // Keyboard only: focus the field, type, Tab to the button, Enter.
    await box.focus();
    await page.keyboard.insertText(QUESTION);
    await page.keyboard.press("Tab");
    await expect(section.getByRole("button", { name: "Send question" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(section.getByText(/Question sent to the seller/)).toBeVisible();
    await expect(section.getByText("We removed contact details from your question.")).toBeVisible();

    // The asker sees their own pending question, without the contact details; it is not public yet.
    const mine = section.getByRole("list").filter({ hasText: word });
    await expect(mine).toContainText(word);
    await expect(mine).not.toContainText("98765");
    await expect(mine).not.toContainText("buyer@example.com");
    await expect(section.getByText("Waiting for the seller")).toBeVisible();
    await expect(section.getByRole("searchbox")).toHaveCount(0);
    await expectNoBlockingViolations(page, info);
  });
});

test("the seller answers from the portal (contact details removed from the answer too)", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: SELLER_URL, extraHTTPHeaders: { "cf-connecting-ip": "198.18.77.11" } });
  const page = await ctx.newPage();
  await page.goto("/signin");
  await page.getByLabel("Email").fill(DEMO.seller.email);
  await page.getByLabel("Password").fill(DEMO.seller.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/signin/);
  await page.goto("/questions"); // the "all" view keeps the card (and its confirmation) on screen after the answer is saved
  const card = page.getByRole("listitem").filter({ hasText: word });
  await expect(card).toBeVisible();
  await expect(card).not.toContainText("98765");
  await card.getByRole("textbox", { name: "Your answer" }).fill(ANSWER);
  await card.getByRole("button", { name: "Send answer" }).click();
  await expect(card.getByText(/Answer saved/)).toBeVisible();
  await expect(card.getByText("We removed contact details from your answer.")).toBeVisible();
  await ctx.close();
});

test.describe("buyer after the answer", () => {
  test("sees the answer, finds it with the search box (keyboard), and the populated section passes axe", async ({ page }, info) => {
    // The worker (absent in e2e) would purge the ISR page on ProductQuestionAnswered; do the same through the same endpoint.
    const purge = await page.request.post("/api/revalidate", {
      headers: { authorization: `Bearer ${e2eEnv.REVALIDATE_SECRET}` },
      data: { tags: [{ tag: `qa:${listingId}`, hard: true }] },
    });
    expect(purge.ok()).toBe(true);

    await signUpBuyer(page, "qa2");
    await openProduct(page);
    const section = page.getByRole("region", { name: "Questions about this product" });
    const search = section.getByRole("searchbox", { name: "Search questions and answers" });
    await expect(search).toBeVisible();
    await expect(section.getByText(/answered questions?$/).first()).toBeVisible();
    const item = section.getByRole("listitem").filter({ hasText: word });
    await expect(item).toContainText("food-grade certified");
    await expect(item).not.toContainText("9123456789"); // the seller's number was removed
    await expect(item).not.toContainText("98765"); // and so was the buyer's
    await expectNoBlockingViolations(page, info);

    // Search by keyboard: type, Enter, results are announced in the polite status region.
    await search.focus();
    await page.keyboard.insertText(word);
    await page.keyboard.press("Enter");
    await expect(section.getByRole("status").filter({ hasText: /1 result for/ })).toBeVisible();
    await expect(item).toHaveCount(1);
    await search.fill("no-such-term-xyz");
    await page.keyboard.press("Enter");
    await expect(section.getByText(/No questions match/)).toBeVisible();
    await expectNoBlockingViolations(page, info);
    await section.getByRole("button", { name: "Clear search" }).click();
    await expect(item).toBeVisible();

    // Reporting is reachable from the keyboard: <details> opens on Enter and the reason field is labelled.
    await item.getByText("Report", { exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(item.getByRole("textbox", { name: "Why are you reporting this?" })).toBeVisible();
    await expect(item.getByRole("button", { name: /^Helpful/ })).toBeVisible();

    // The first page is in the HTML for crawlers: FAQ JSON-LD carries only this approved, answered pair (stripped text).
    const ld = await page.locator('script[type="application/ld+json"]').allInnerTexts();
    const faq = ld.map((t) => JSON.parse(t) as unknown).flat().find((n) => (n as { "@type"?: string })["@type"] === "FAQPage") as { mainEntity: { name: string }[] } | undefined;
    expect(faq?.mainEntity.some((q) => q.name.includes(word) && !q.name.includes("98765"))).toBe(true);
  });
});

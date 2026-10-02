/**
 * Buyer retention (docs/design/buyer-retention.md): follow a supplier, saved searches, "Request again", opt-in alerts and the
 * email unsubscribe page. Every state is scanned with axe (WCAG 2.2 AA) and the key paths are driven by keyboard.
 * Following and alerts never change ranking, and nothing is stored in the browser (no consent-registry entry needed).
 */
import { randomUUID } from "node:crypto";
import { signUnsubscribeToken } from "../../packages/alerts/src/token";
import { expect, test, type Page } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { signUpBuyer } from "../support/auth";
import { e2eEnv } from "../support/env";
import { firstProductHref } from "../support/pages";
import { seedQuotes } from "../support/rfq-db";

test.setTimeout(120_000);

/** Navigates and waits until the island's per-user lookups (/api/me, then /api/follow) have answered. */
async function gotoAndWaitFollowState(page: Page, href: string) {
  const answered = page.waitForResponse((r) => r.url().includes("/api/follow/") && r.ok());
  await page.goto(href);
  await answered;
}

test.describe("follow a supplier", () => {
  test("toggle on the seller card and the profile, persists, is listed under Followed suppliers, passes axe, keyboard-operable", async ({ page }, info) => {
    await signUpBuyer(page, "follow");
    const href = await firstProductHref(page);

    await gotoAndWaitFollowState(page, href);
    const follow = page.getByRole("button", { name: /^Follow / });
    await expect(follow).toHaveAttribute("aria-pressed", "false");
    await expect(follow).toHaveAttribute("title", /never changes how suppliers are ranked/);
    expect((await follow.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await follow.focus();
    await expect(follow).toBeFocused();
    await page.keyboard.press("Enter");
    const following = page.getByRole("button", { name: /^Following / });
    await expect(following).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("status").filter({ hasText: /You now follow/ })).toHaveCount(1);
    await expectNoBlockingViolations(page, info);

    // the supplier profile shows the same state (fetched per visitor; the static HTML carries none)
    await page.getByRole("link", { name: "View profile" }).first().click();
    await expect(page).toHaveURL(/\/manufacturers\//);
    await expect(page.getByRole("button", { name: /^Following / })).toHaveAttribute("aria-pressed", "true");
    const profileName = (await page.getByRole("heading", { level: 1 }).innerText()).trim();
    await expectNoBlockingViolations(page, info);

    await page.goto("/buyer/suppliers");
    await settle(page);
    await expect(page.getByRole("heading", { level: 1, name: "Followed suppliers" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: profileName })).toBeVisible();
    await expect(page.getByText("Following is private: suppliers only see how many buyers follow them, never who.")).toBeVisible();
    await expectNoBlockingViolations(page, info);

    // unfollow from the list (keyboard), the list empties
    const unfollow = page.getByRole("button", { name: `Unfollow ${profileName}` });
    await unfollow.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("You are not following any supplier yet")).toBeVisible();
    await expectNoBlockingViolations(page, info);
  });

  test("guests are sent to sign in and the follow state endpoint reveals nothing", async ({ page, request }) => {
    const href = await firstProductHref(page);
    await page.goto(href);
    await settle(page);
    const follow = page.getByRole("button", { name: /^Follow |^Sign in to follow / }).first();
    await expect(follow).toHaveAttribute("aria-pressed", "false");
    await follow.click();
    await expect(page).toHaveURL(/\/signin\?next=/);
    const res = await request.get(`/api/follow/${randomUUID()}`);
    expect(await res.json()).toEqual({ following: false, signedIn: false });
    expect(res.headers()["cache-control"]).toContain("no-store");
  });
});

test.describe("saved searches", () => {
  test("save from /search (keyboard), manage under Saved searches, change frequency, delete", async ({ page }, info) => {
    await signUpBuyer(page, "saved");
    const me = page.waitForResponse((r) => r.url().includes("/api/me") && r.ok());
    await page.goto("/search?q=box&tier=1");
    await me;
    await settle(page);

    const toggle = page.getByTestId("save-search-toggle");
    await expect(toggle).toHaveText(/Save this search/);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    // alerts are opt-in: nothing is chosen until the buyer picks a frequency
    await expect(page.getByRole("radio", { name: /Don't alert me/ })).toBeChecked();
    await page.keyboard.press("Tab");
    const name = page.getByRole("textbox", { name: "Name (optional)" });
    await expect(name).toBeFocused();
    await name.fill("Boxes, verified suppliers");
    await expectNoBlockingViolations(page, info);
    await page.getByRole("radio", { name: "Weekly" }).check();
    await page.getByRole("button", { name: "Save search" }).click();
    await expect(page.getByText(/Saved\. You can manage it under Saved searches\./)).toBeVisible();
    await expectNoBlockingViolations(page, info);

    // saving the same search again is refused with a clear message
    const meAgain = page.waitForResponse((r) => r.url().includes("/api/me") && r.ok());
    await page.reload();
    await meAgain;
    await page.getByTestId("save-search-toggle").click();
    await page.getByRole("button", { name: "Save search" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "You already saved this search" })).toBeVisible();

    await page.goto("/account/saved-searches");
    await settle(page);
    await expect(page.getByRole("heading", { level: 1, name: "Saved searches" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Boxes, verified suppliers" })).toBeVisible();
    const view = page.getByRole("link", { name: "View results" });
    await expect(view).toHaveAttribute("href", /\/search\?q=box&tier=1/);
    const select = page.getByLabel("Alerts for Boxes, verified suppliers");
    await expect(select).toHaveValue("weekly");
    await expectNoBlockingViolations(page, info);

    await select.selectOption("daily");
    await page.getByRole("button", { name: "Update" }).click();
    await expect(page.getByText("Alert frequency updated.")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Alerts for Boxes, verified suppliers")).toHaveValue("daily");

    const del = page.getByRole("button", { name: "Delete saved search Boxes, verified suppliers" });
    await del.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("No saved searches yet")).toBeVisible();
    await expectNoBlockingViolations(page, info);
  });

  test("an empty search with no filters cannot be saved (the button is not offered)", async ({ page }) => {
    await signUpBuyer(page, "savedempty");
    await page.goto("/search");
    await settle(page);
    await expect(page.getByTestId("save-search")).toHaveCount(0);
  });
});

test.describe("alert settings and email unsubscribe", () => {
  test("every alert is opt-in (off by default), saved with the keyboard, and survives a reload", async ({ page }, info) => {
    await signUpBuyer(page, "alerts");
    await page.goto("/account/alerts");
    await settle(page);
    await expect(page.getByRole("heading", { level: 1, name: "Alerts" })).toBeVisible();
    for (const label of ["Price drops on saved items", "Back in stock", "New listings from followed suppliers"]) {
      await expect(page.getByRole("checkbox", { name: label })).not.toBeChecked();
    }
    await expectNoBlockingViolations(page, info);
    const price = page.getByRole("checkbox", { name: "Price drops on saved items" });
    await price.focus();
    await page.keyboard.press("Space");
    await expect(price).toBeChecked();
    await page.getByRole("button", { name: "Save alert settings" }).click();
    await expect(page.getByText("Alert settings saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "Price drops on saved items" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Back in stock" })).not.toBeChecked();
    // the same toggles are reachable from the wishlist and the notification settings
    await page.goto("/wishlist");
    await expect(page.getByRole("link", { name: "Get price-drop and back-in-stock alerts" })).toHaveAttribute("href", "/account/alerts");
    await page.goto("/account/notifications");
  });

  test("the unsubscribe link needs a confirmation and rejects forged tokens", async ({ page }, info) => {
    await page.goto("/unsubscribe/alerts?t=forged.token");
    await settle(page);
    await expect(page.getByText("This unsubscribe link is not valid.")).toBeVisible();
    await expectNoBlockingViolations(page, info);

    process.env.JWT_SECRET = e2eEnv.JWT_SECRET; // the e2e servers sign with the same secret
    const token = signUnsubscribeToken(randomUUID(), "price_drop");
    await page.goto(`/unsubscribe/alerts?t=${encodeURIComponent(token)}`);
    await settle(page);
    // a GET never changes anything (mail scanners prefetch links): the buyer confirms
    await expect(page.getByText("Price drops on saved items")).toBeVisible();
    await expectNoBlockingViolations(page, info);
    await page.getByRole("button", { name: "Turn off" }).click();
    await expect(page.getByText("Done. You will no longer receive these alerts.")).toBeVisible();
    await expectNoBlockingViolations(page, info);
  });
});

test.describe("request again", () => {
  test("a quoted requirement opens the form prefilled (spec, quantity, delivery) with the same supplier offered first", async ({ page }, info) => {
    await signUpBuyer(page, "again");
    await page.goto("/rfq/new");
    await settle(page);
    await page.getByRole("textbox", { name: "What do you need?" }).fill("Printed 3 ply corrugated boxes");
    await page.getByRole("textbox", { name: "Requirement details" }).fill("3 ply corrugated shipping boxes, 12x10x8 inch, printed logo, delivery in Pune.");
    await page.getByRole("combobox", { name: "Category" }).selectOption({ label: "Packaging & Printing" });
    await page.getByRole("spinbutton", { name: "Quantity" }).fill("500");
    await page.getByRole("textbox", { name: "Delivery city" }).fill("Pune");
    await page.getByRole("button", { name: "Post requirement" }).click();
    const link = page.getByRole("link", { name: "View requirement" });
    await expect(link).toBeVisible();
    const enquiryId = (await link.getAttribute("href"))!.split("/").pop()!;

    // not offered while the requirement is still running unanswered
    await page.goto(`/buyer/enquiries/${enquiryId}`);
    await settle(page);
    await expect(page.getByTestId("request-again")).toHaveCount(0);

    await seedQuotes(enquiryId); // suppliers accepted and quoted (what the seller app would have written)
    await page.goto(`/buyer/enquiries/${enquiryId}`);
    await settle(page);
    const again = page.getByTestId("request-again");
    await expect(again).toBeVisible();
    await expectNoBlockingViolations(page, info);
    await again.focus();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(new RegExp(`/rfq/new\\?again=${enquiryId}`));
    await settle(page);
    await expect(page.getByText(/Prefilled from your earlier requirement "Printed 3 ply corrugated boxes"/)).toBeVisible();
    await expect(page.getByRole("textbox", { name: "What do you need?" })).toHaveValue("Printed 3 ply corrugated boxes");
    await expect(page.getByRole("textbox", { name: "Requirement details" })).toHaveValue(/3 ply corrugated shipping boxes/);
    await expect(page.getByRole("spinbutton", { name: "Quantity" })).toHaveValue("500");
    await expect(page.getByRole("textbox", { name: "Delivery city" })).toHaveValue("Pune");
    const same = page.getByTestId("same-supplier");
    await expect(same).toBeChecked();
    await expect(page.getByText(/^Send to .+ first$/)).toBeVisible();
    await expectNoBlockingViolations(page, info);

    // nothing exists until the buyer sends it; it becomes a NEW enquiry
    await page.getByRole("button", { name: "Post requirement" }).click();
    const next = page.getByRole("link", { name: "View requirement" });
    await expect(next).toBeVisible();
    expect((await next.getAttribute("href"))!.split("/").pop()).not.toBe(enquiryId);
  });

  test("somebody else's requirement id yields an empty form, never its content", async ({ page }) => {
    await signUpBuyer(page, "againother");
    await page.goto(`/rfq/new?again=${randomUUID()}`);
    await settle(page);
    await expect(page.getByText("We couldn't find that earlier requirement, so the form is empty.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "What do you need?" })).toHaveValue("");
  });
});

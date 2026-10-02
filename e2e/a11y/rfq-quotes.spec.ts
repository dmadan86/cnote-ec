/**
 * RFQ depth + buyer quote comparison (WCAG 2.2 AA, keyboard, accept flow). Per ADR-002 the comparison always states
 * how many suppliers the requirement was sent to and how many of them quoted.
 */
import { expect, test, type Page } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { signUpBuyer } from "../support/auth";
import { dealReports, seedQuotes } from "../support/rfq-db";

const PDF = { name: "bracket-drawing.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n") };
const PNG = { name: "sketch.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]) };

async function fillBasics(page: Page) {
  await page.getByRole("textbox", { name: "What do you need?" }).fill("Printed 3 ply corrugated boxes");
  await page.getByRole("textbox", { name: "Requirement details" }).fill("3 ply corrugated shipping boxes, 12x10x8 inch, printed logo, delivery in Pune.");
  await page.getByRole("combobox", { name: "Category" }).selectOption({ label: "Packaging & Printing" });
  await page.getByRole("spinbutton", { name: "Quantity" }).fill("500");
  await page.getByRole("textbox", { name: "Delivery city" }).fill("Pune");
}

/** Posts a requirement with a drawing through the real form and returns its id. */
async function postRfq(page: Page): Promise<string> {
  await page.goto("/rfq/new");
  await settle(page);
  await fillBasics(page);
  await page.getByLabel("Budget from (₹ per unit)").fill("500");
  await page.getByLabel("Budget up to (₹ per unit)").fill("700");
  await page.getByLabel("Drawings or specs").setInputFiles([PDF, PNG]);
  await page.getByRole("button", { name: "Post requirement" }).click();
  const link = page.getByRole("link", { name: "View requirement" });
  await expect(link).toBeVisible();
  const href = (await link.getAttribute("href"))!;
  return href.split("/").pop()!;
}

test.describe("RFQ form: optional details and attachments", () => {
  test("passes axe, is keyboard-operable, and validates files before upload", async ({ page }, info) => {
    await signUpBuyer(page, "rfqform");
    await page.goto("/rfq/new");
    await settle(page);
    await expect(page.getByRole("group", { name: "Optional details" })).toBeVisible();
    await expectNoBlockingViolations(page, info);

    // keyboard: reach the file input, choose a drawing, Tab to its remove button, activate it with Enter
    const files = page.getByLabel("Drawings or specs");
    await files.focus();
    await expect(files).toBeFocused();
    await expect(files).toHaveAttribute("aria-describedby", /attachments-hint/);
    await files.setInputFiles([PDF]);
    await expect(page.getByText("1 file selected")).toBeVisible();
    await expectNoBlockingViolations(page, info);
    await page.keyboard.press("Tab");
    const remove = page.getByRole("button", { name: "Remove bracket-drawing.pdf" });
    await expect(remove).toBeFocused();
    expect((await remove.boundingBox())!.height).toBeGreaterThanOrEqual(24);
    await page.keyboard.press("Enter");
    await expect(remove).toHaveCount(0);

    // a wrong type is rejected in the page with an announced error (and still passes axe)
    await files.setInputFiles([{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") }]);
    await expect(page.getByRole("alert").filter({ hasText: "notes.txt is not a PDF, JPG or PNG file." })).toBeVisible();
    await expect(files).toHaveAttribute("aria-invalid", "true");
    await expectNoBlockingViolations(page, info);
    // more than five files
    await files.setInputFiles(Array.from({ length: 6 }, (_, i) => ({ ...PDF, name: `d${i}.pdf` })));
    await expect(page.getByRole("alert").filter({ hasText: "Choose at most 5 files." })).toBeVisible();
  });

  test("expiry defaults to 7 days and the tier floor offers real verification tiers", async ({ page }) => {
    await signUpBuyer(page, "rfqdefaults");
    await page.goto("/rfq/new");
    await expect(page.getByLabel("Accept quotes for")).toHaveValue("7");
    const tiers = await page.getByLabel("Preferred supplier verification").locator("option").allInnerTexts();
    expect(tiers).toEqual(["Any verified supplier", "GST verified or higher", "KYC verified or higher", "Audited or higher"]);
  });

  test("the pincode is prefilled from the Deliver to cookie, and typing still wins", async ({ page, context, baseURL }) => {
    await signUpBuyer(page, "rfqpin");
    await context.addCookies([{ name: "cnote_pincode", value: "560001", url: baseURL! }]);
    await page.goto("/rfq/new");
    const pin = page.getByRole("textbox", { name: "Pincode" });
    await expect(pin).toHaveValue("560001");
    await pin.fill("411001");
    await expect(pin).toHaveValue("411001");
  });
});

test.describe("My requirements board and quote comparison", () => {
  test("board filters, counts, deadline, honest 'N of max N' and quotes received", async ({ page }, info) => {
    await signUpBuyer(page, "board");
    const id = await postRfq(page);
    await page.goto("/buyer/enquiries");
    await settle(page);
    const nav = page.getByRole("navigation", { name: "Filter requirements by status" });
    await expect(nav.getByRole("link", { name: "All (1)" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: /^Open \(/ })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Expired (0)" })).toBeVisible();
    const card = page.getByRole("link", { name: /Printed 3 ply corrugated boxes/ });
    await expect(card).toContainText("No quotes yet");
    await expect(card).toContainText(/\d+ of max \d+ suppliers matched/);
    await expect(card).toContainText(/Expires in 6d \d+h|Expires in 7d/);
    await expectNoBlockingViolations(page, info);

    await seedQuotes(id);
    await page.reload();
    await expect(page.getByRole("link", { name: /Printed 3 ply corrugated boxes/ })).toContainText("2 quotes received");
    await nav.getByRole("link", { name: /^Quoted \(1\)/ }).click();
    await expect(page).toHaveURL(/status=quoted/);
    await expect(nav.getByRole("link", { name: /^Quoted/ })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("link", { name: /Printed 3 ply corrugated boxes/ })).toBeVisible();
    await nav.getByRole("link", { name: /^Expired/ }).click();
    await expect(page.getByRole("status")).toContainText("No expired requirements right now.");
    await page.mouse.move(0, 0); // let the hover colour transition on the chip finish before measuring contrast
    await page.waitForTimeout(500);
    await expectNoBlockingViolations(page, info);
  });

  test("compare table: transparency line, axe, sort, best marks, shortlist, attachments, accept", async ({ page }, info) => {
    await signUpBuyer(page, "compare");
    const id = await postRfq(page);
    const { a, b, sentTo } = await seedQuotes(id);

    await page.goto(`/buyer/enquiries/${id}`);
    await settle(page);
    await expect(page.getByTestId("quote-transparency")).toHaveText(`Sent to ${sentTo} ${sentTo === 1 ? "supplier" : "suppliers"}; you are seeing quotes from 2.`);
    // requirement details incl. the new fields and a downloadable drawing
    await expect(page.getByText("Budget range")).toBeVisible();
    await expect(page.getByText("Quotes accepted until")).toBeVisible();
    const drawing = page.getByRole("link", { name: "Download bracket-drawing.pdf" });
    const res = await page.request.get((await drawing.getAttribute("href"))!);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/pdf");
    expect(res.headers()["cache-control"]).toContain("no-store");

    const table = page.getByRole("table", { name: /Quotes received for this requirement/ });
    await expect(table).toBeVisible();
    await expect(table.getByRole("row")).toHaveCount(3); // header + 2 suppliers
    for (const h of ["Supplier", "Verification", "Rank", "Unit price", "Total for 500 pcs", "Lead time", "Valid until", "Payment terms", "Attachments", "Notes", "Actions"]) {
      await expect(table.getByRole("columnheader", { name: h })).toBeVisible();
    }
    await expectNoBlockingViolations(page, info);

    // totals are unit price x requested quantity
    await expect(table.getByRole("row", { name: new RegExp(a.sellerName) })).toContainText("₹3,10,000");
    await expect(table.getByRole("row", { name: new RegExp(b.sellerName) })).toContainText("₹2,70,000");

    // "best" is text, not colour: cheaper supplier gets Best on price and total, faster one on lead time
    const rowB = table.getByRole("row", { name: new RegExp(b.sellerName) });
    const rowA = table.getByRole("row", { name: new RegExp(a.sellerName) });
    await expect(rowB.getByText("(Best Unit price)")).toBeAttached();
    await expect(rowA.getByText("(Best Lead time)")).toBeAttached();
    await expect(rowA.getByText("(Best Unit price)")).toHaveCount(0);

    // sorting by price puts the cheaper supplier first and announces it
    await page.getByLabel("Sort quotes by").selectOption("price");
    await expect(page.getByRole("status").filter({ hasText: "Sorted by Lowest unit price" })).toBeAttached();
    await expect(table.getByRole("row").nth(1)).toContainText(b.sellerName);
    await page.getByLabel("Sort quotes by").selectOption("leadTime");
    await expect(table.getByRole("row").nth(1)).toContainText(a.sellerName);

    // keyboard: the scrollable table region is focusable
    const region = page.getByRole("region", { name: /Quotes received for this requirement/ });
    await region.focus();
    await expect(region).toBeFocused();

    // shortlist toggle (pressed state, not just colour) and the shortlisted-only filter
    const shortlist = page.getByRole("button", { name: `Shortlist quote from ${b.sellerName}` });
    await expect(shortlist).toHaveAttribute("aria-pressed", "false");
    await shortlist.click();
    await expect(page.getByRole("button", { name: `Shortlist quote from ${b.sellerName}` })).toHaveAttribute("aria-pressed", "true");
    await page.getByLabel("Show shortlisted only").check();
    await expect(table.getByRole("row")).toHaveCount(2);
    await expect(table.getByRole("row").nth(1)).toContainText(b.sellerName);
    await page.getByLabel("Show shortlisted only").uncheck();

    // Message goes to the conversation
    await expect(page.getByRole("link", { name: `Message ${a.sellerName}` })).toHaveAttribute("href", /\/conversations\//);

    // accept: records the deal at the table total; the row then says Accepted
    await page.getByRole("button", { name: `Accept quote from ${b.sellerName}` }).click();
    await expect(table.getByRole("row", { name: new RegExp(b.sellerName) }).getByText("Accepted", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `Accept quote from ${b.sellerName}` })).toHaveCount(0);
    expect(await dealReports(id)).toEqual([{ outcome: "won", valuePaise: b.pricePaise * 500 }]);
    await expectNoBlockingViolations(page, info);

    // decline the other quote
    await page.getByRole("button", { name: `Decline quote from ${a.sellerName}` }).click();
    await expect(table.getByRole("row", { name: new RegExp(a.sellerName) }).getByText("Declined", { exact: true })).toBeVisible();
  });

  test("an empty comparison is honest about who was asked", async ({ page }, info) => {
    await signUpBuyer(page, "cmpempty");
    const id = await postRfq(page);
    await page.goto(`/buyer/enquiries/${id}`);
    await settle(page);
    await expect(page.getByTestId("quote-transparency")).toContainText(/Sent to \d+ suppliers?; you are seeing quotes from 0\./);
    await expect(page.getByText(/No quotes yet\. Suppliers can respond until/)).toBeVisible();
    await expectNoBlockingViolations(page, info);
  });
});

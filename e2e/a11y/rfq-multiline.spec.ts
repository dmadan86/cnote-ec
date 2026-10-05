/**
 * Multi-line RFQ (bill of materials): WCAG 2.2 AA on the form and the line matrix, keyboard add/reorder/remove, CSV upload with column
 * mapping, per-line award. Written for the lead to run (ports collide between parallel agents); see docs/design/rfq-multiline.md.
 */
import { expect, test, type Page } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";
import { signUpBuyer } from "../support/auth";
import { lineAwards, seedLineQuotes } from "../support/rfq-lines-db";

const CSV = {
  name: "bom.csv",
  mimeType: "text/csv",
  buffer: Buffer.from("Item name,Qty,UOM,Rate\nM8 hex bolt,500,pcs,12.5\nM8 nut,500,pcs,\n=HYPERLINK(\"http://x\"),20,kg,\n,5,pcs,\nWasher,abc,pcs,\n"),
};

async function openBom(page: Page) {
  await page.goto("/rfq/new");
  await settle(page);
  await page.getByRole("textbox", { name: "What do you need?" }).fill("Fasteners for assembly line four");
  await page.getByRole("textbox", { name: "Requirement details" }).fill("Monthly fasteners for line four, stainless, delivery in Pune.");
  await page.getByRole("radio", { name: "Several items (bill of materials)" }).check();
  await expect(page.getByTestId("bom-editor")).toBeVisible();
}

test.describe("multi-line RFQ form", () => {
  test("passes axe, uploads a CSV through the column-mapping step, and is keyboard operable", async ({ page }, info) => {
    await signUpBuyer(page, "bomform");
    await openBom(page);
    await expectNoBlockingViolations(page, info);

    // upload -> mapping step (auto-detected columns) -> import
    await page.getByLabel("Choose CSV or Excel file").setInputFiles(CSV);
    const map = page.getByRole("group", { name: /Check the columns in bom\.csv/ });
    await expect(map).toBeVisible();
    await expect(map.getByLabel("Item name *")).not.toHaveValue("");
    await expectNoBlockingViolations(page, info);
    await map.getByRole("button", { name: "Replace my items" }).click();
    await expect(page.getByText("Lines imported: 3")).toBeVisible();
    await expect(page.getByTestId("bom-count")).toHaveText("3 of 50 lines");
    // the formula-looking cell is imported as plain text, never as a formula
    await expect(page.getByLabel("Item name *").nth(2)).toHaveValue('HYPERLINK("http://x")');
    await page.getByText(/Rows skipped: 2/).click();

    // keyboard: move line 2 up with Enter on the button; focus stays on the moved line's button; the move is announced
    await page.getByRole("button", { name: "Move line 2 up" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Item name *").first()).toHaveValue("M8 nut");
    await expect(page.getByRole("button", { name: "Move line 1 down" })).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "Line moved from position 2 to 1." })).toBeAttached();
    // remove line 3, add a line (focus lands in the new line's item field)
    await page.getByRole("button", { name: "Remove line 3" }).click();
    await expect(page.getByTestId("bom-count")).toHaveText("2 of 50 lines");
    await page.getByRole("button", { name: "Add another line" }).click();
    await expect(page.getByLabel("Item name *").nth(2)).toBeFocused();
    await page.getByLabel("Item name *").nth(2).fill("Flat washer M8");
    await page.getByLabel("Quantity *").nth(2).fill("1000");
    await expectNoBlockingViolations(page, info);

    // posts as one RFQ with three lines
    await page.getByRole("button", { name: "Post requirement" }).click();
    const link = page.getByRole("link", { name: "View requirement" });
    await expect(link).toBeVisible();
    await link.click();
    await settle(page);
    await expect(page.getByRole("table", { name: /Items \(3\)/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /M8 nut/ })).toContainText("500 pcs");
    await expectNoBlockingViolations(page, info);
  });

  test("shows inline errors for a bad line and refuses a wrong file type", async ({ page }, info) => {
    await signUpBuyer(page, "bomerr");
    await openBom(page);
    await page.getByLabel("Quantity *").first().fill("0");
    await page.getByLabel("Quantity *").first().blur();
    await expect(page.getByRole("alert").filter({ hasText: "Enter a whole number above 0." })).toBeVisible();
    await page.getByLabel("Choose CSV or Excel file").setInputFiles({ name: "x.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
    await expect(page.getByText("Upload a .csv or .xlsx file.")).toBeVisible();
    await expectNoBlockingViolations(page, info);
  });
});

test.describe("line-by-line comparison and award", () => {
  test("matrix marks the lowest per line in words, awards lines to different suppliers, one order each", async ({ page }, info) => {
    await signUpBuyer(page, "bommatrix");
    await openBom(page);
    await page.getByLabel("Choose CSV or Excel file").setInputFiles({ ...CSV, buffer: Buffer.from("Item,Qty,Unit\nBolt,500,pcs\nNut,500,pcs\nWasher,1000,pcs\n") });
    await page.getByRole("group", { name: /Check the columns/ }).getByRole("button", { name: "Replace my items" }).click();
    await page.getByRole("button", { name: "Post requirement" }).click();
    const link = page.getByRole("link", { name: "View requirement" });
    await expect(link).toBeVisible();
    const id = (await link.getAttribute("href"))!.split("/").pop()!;
    const { a, b } = await seedLineQuotes(id);

    await page.goto(`/buyer/enquiries/${id}`);
    await settle(page);
    const matrix = page.getByTestId("line-matrix");
    await expect(matrix.getByRole("heading", { name: "Line-by-line comparison" })).toBeVisible();
    const table = matrix.getByRole("table");
    await expect(table.getByTestId("matrix-row")).toHaveCount(3);
    await expect(table.getByRole("columnheader", { name: new RegExp(a.sellerName) })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: /2 of 3 lines quoted/ })).toBeVisible();
    // line 1: B is cheaper (word "Lowest", not only colour); line 3: B skipped
    await expect(table.getByRole("row", { name: /Bolt/ }).getByText("Lowest")).toHaveCount(1);
    await expect(table.getByRole("row", { name: /Washer/ })).toContainText("Skipped");
    await expectNoBlockingViolations(page, info);

    // keyboard: radios, arrow keys inside a group
    await table.getByRole("radio", { name: `Award line 1 (Bolt) to ${b.sellerName}` }).check();
    await table.getByRole("radio", { name: `Award line 2 (Nut) to ${a.sellerName}` }).check();
    await table.getByRole("radio", { name: `Award line 3 (Washer) to ${a.sellerName}` }).check();
    await expect(page.getByTestId("award-summary")).toContainText("3 lines to 2 suppliers");
    await expectNoBlockingViolations(page, info);
    await matrix.getByRole("button", { name: "Award 3 lines" }).click();
    await expect(matrix.getByText("Orders recorded: 2")).toBeVisible();
    const awards = await lineAwards(id);
    expect(awards.map((x) => x.ordinal)).toEqual([1, 2, 3]);
    expect(new Set(awards.map((x) => x.orderId)).size).toBe(2);
    await page.reload();
    await settle(page);
    await expect(page.getByTestId("line-matrix").getByText(`Awarded to ${b.sellerName}`).first()).toBeVisible();
  });
});

import { describe, expect, it } from "vitest";
import {
  addDays, computePo, daysBetween, daysRemaining, formatPoNumber, isIntraState, istDate, normaliseAckNo, normaliseEwayBill, normaliseInvoiceNumber, normaliseIrn,
  normalisePaymentReference, paymentTermsToDays, reminderStage, statutoryDueDate,
} from "../src/po-core";
import { decodeSignedQr, mockEInvoiceVerifier, qrSvgDataUri } from "../src/einvoice";

describe("MSME s.43B(h) statutory due date", () => {
  it("is acceptance + the agreed days when a written agreement exists and is within 45 days", () => {
    expect(statutoryDueDate({ acceptance: "2026-10-01", agreedDays: 30, writtenAgreement: true })).toEqual({ dueDate: "2026-10-31", days: 30, capped: false });
    expect(statutoryDueDate({ acceptance: "2026-10-01", agreedDays: 0, writtenAgreement: true }).dueDate).toBe("2026-10-01");
  });
  it("caps the agreed period at 45 days", () => {
    expect(statutoryDueDate({ acceptance: "2026-10-01", agreedDays: 90, writtenAgreement: true })).toEqual({ dueDate: "2026-11-15", days: 45, capped: true });
    expect(statutoryDueDate({ acceptance: "2026-10-01", agreedDays: 45, writtenAgreement: true }).capped).toBe(false);
  });
  it("is 15 days with no written agreement, whatever the stated terms", () => {
    expect(statutoryDueDate({ acceptance: "2026-10-01", agreedDays: 30, writtenAgreement: false })).toEqual({ dueDate: "2026-10-16", days: 15, capped: false });
    expect(statutoryDueDate({ acceptance: "2026-10-01", agreedDays: null, writtenAgreement: true }).days).toBe(15);
  });
  it("crosses month and year ends and leap days", () => {
    expect(statutoryDueDate({ acceptance: "2026-12-20", agreedDays: 45, writtenAgreement: true }).dueDate).toBe("2027-02-03");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("dates and reminders", () => {
  it("uses the Indian calendar date", () => {
    expect(istDate(new Date("2026-10-05T19:00:00Z"))).toBe("2026-10-06"); // 00:30 IST next day
    expect(istDate(new Date("2026-10-05T18:29:00Z"))).toBe("2026-10-05");
    expect(daysBetween("2026-10-01", "2026-10-08")).toBe(7);
  });
  it("picks the most urgent stage", () => {
    const due = "2026-10-20";
    expect(reminderStage(due, "2026-10-10")).toBeNull(); // 10 days left
    expect(reminderStage(due, "2026-10-13")).toBe("t7");
    expect(reminderStage(due, "2026-10-18")).toBe("t7"); // 2 days left
    expect(reminderStage(due, "2026-10-19")).toBe("t1");
    expect(reminderStage(due, "2026-10-20")).toBe("t1"); // due today
    expect(reminderStage(due, "2026-10-21")).toBe("overdue");
    expect(daysRemaining(due, "2026-10-23")).toBe(-3);
  });
  it("maps quote payment terms to days", () => {
    expect(paymentTermsToDays("net_30")).toBe(30);
    expect(paymentTermsToDays("on_delivery")).toBe(0);
    expect(paymentTermsToDays("other")).toBeNull();
    expect(paymentTermsToDays(null)).toBeNull();
  });
});

describe("PO totals", () => {
  const line = { description: "Cotton yarn 30s", quantity: 100, unit: "kg", unitPricePaise: 25_050, gstRateBps: 500 };
  it("splits CGST+SGST intra-state and IGST inter-state with exact sums", () => {
    const intra = computePo([line], true);
    expect(intra.totals).toMatchObject({ taxablePaise: 2_505_000, cgstPaise: 62_625, sgstPaise: 62_625, igstPaise: 0, totalPaise: 2_630_250 });
    const inter = computePo([line], false);
    expect(inter.totals).toMatchObject({ igstPaise: 125_250, cgstPaise: 0, totalPaise: 2_630_250 });
    expect(intra.lines[0]).toMatchObject({ lineNo: 1, taxPaise: 125_250 });
  });
  it("backs GST out of an inclusive price", () => {
    const r = computePo([{ ...line, unitPricePaise: 10_500, quantity: 1, priceIncludesGst: true }], false);
    expect(r.totals.totalPaise).toBe(10_500);
    expect(r.totals.taxablePaise + r.totals.taxPaise).toBe(10_500);
  });
  it("is line based: N lines sum", () => {
    const r = computePo([line, { ...line, description: "Polyester", gstRateBps: 1200, quantity: 10 }], true);
    expect(r.lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(r.totals.totalPaise).toBe(r.lines.reduce((s, l) => s + l.totalPaise, 0));
  });
  it("validates lines", () => {
    expect(() => computePo([], true)).toThrow(/at least one/);
    expect(() => computePo([{ ...line, quantity: 0 }], true)).toThrow(/quantity/);
    expect(() => computePo([{ ...line, hsn: "12A" }], true)).toThrow(/HSN/);
    expect(() => computePo([{ ...line, gstRateBps: 5000 }], true)).toThrow(/GST rate/);
    expect(() => computePo([{ ...line, unitPricePaise: 999_999_999_999, quantity: 5 }], true)).toThrow(/too large/);
  });
  it("decides intra-state from the delivery state and the seller's state", () => {
    expect(isIntraState("29", "29")).toBe(true);
    expect(isIntraState("29", "27")).toBe(false);
    expect(isIntraState("29", null)).toBe(false);
  });
  it("formats the PO number", () => {
    expect(formatPoNumber("2026-27", 12)).toBe("PO/26-27/000012");
  });
});

describe("format validators", () => {
  const irn = "a".repeat(64);
  it("IRN is 64 hex characters, lowercased", () => {
    expect(normaliseIrn(irn.toUpperCase())).toBe(irn);
    expect(() => normaliseIrn("abc")).toThrow(/64/);
    expect(() => normaliseIrn("g".repeat(64))).toThrow(/64/);
  });
  it("e-way bill is 12 digits", () => {
    expect(normaliseEwayBill("1234 5678 9012")).toBe("123456789012");
    expect(() => normaliseEwayBill("12345678901")).toThrow(/12 digits/);
    expect(() => normaliseEwayBill("12345678901a")).toThrow(/12 digits/);
  });
  it("ack number, invoice number and payment reference", () => {
    expect(normaliseAckNo("112010000012345")).toBe("112010000012345");
    expect(() => normaliseAckNo("12")).toThrow();
    expect(normaliseInvoiceNumber("INV/26-27/0001")).toBe("INV/26-27/0001");
    expect(() => normaliseInvoiceNumber("INV 0001")).toThrow(/16 characters/);
    expect(() => normaliseInvoiceNumber("A".repeat(17))).toThrow();
    expect(normalisePaymentReference("hdfcr52026100512345")).toBe("HDFCR52026100512345");
    expect(() => normalisePaymentReference("12")).toThrow(/UTR/);
  });
});

describe("e-invoice mock verifier and QR", () => {
  const irn = "b".repeat(64);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = (inner: object) => `${b64({ alg: "RS256" })}.${b64({ data: JSON.stringify(inner), iss: "NIC" })}.sig`;
  const base = { irn, ackNo: "112010000012345", sellerGstin: "29ABCDE1234F1Z5", invoiceNumber: "INV-1", invoiceDate: "2026-10-01", totalPaise: 1_180_000 };
  const inner = { Irn: irn, DocNo: "INV-1", SellerGstin: "29ABCDE1234F1Z5", DocDt: "01/10/2026", TotInvVal: 11800 };

  it("decodes the NIC wrapper", () => {
    expect(decodeSignedQr(token(inner))).toMatchObject({ DocNo: "INV-1" });
    expect(decodeSignedQr("not-a-token")).toBeNull();
  });
  it("is consistent when the QR agrees with what was entered", async () => {
    expect(await mockEInvoiceVerifier.verify({ ...base, signedQr: token(inner) })).toEqual({ status: "consistent", note: null });
  });
  it("lists the fields that disagree", async () => {
    const r = await mockEInvoiceVerifier.verify({ ...base, signedQr: token({ ...inner, DocNo: "INV-2", TotInvVal: 9000, DocDt: "02/10/2026" }) });
    expect(r.status).toBe("mismatch");
    expect(r.note?.split(",").sort()).toEqual(["date", "docNo", "total"]);
  });
  it("is unchecked without a QR and a mismatch when the QR cannot be read", async () => {
    expect((await mockEInvoiceVerifier.verify({ ...base, signedQr: null })).status).toBe("unchecked");
    expect((await mockEInvoiceVerifier.verify({ ...base, signedQr: "garbage.garbage.sig" })).status).toBe("mismatch");
  });
  it("renders a QR as an SVG data URI and refuses oversize text", async () => {
    const uri = await qrSvgDataUri(token(inner));
    expect(uri?.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(await qrSvgDataUri("x".repeat(3000))).toBeNull();
  });
});

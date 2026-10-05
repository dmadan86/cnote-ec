// Pure helpers: boundary and error-path behaviour that the flow tests do not reach.
import { describe, expect, it } from "vitest";
import {
  checkLine, checkSignedQr, computePo, formatPoNumber, isIntraState, isIsoDate, MAX_PO_LINES, MAX_SIGNED_QR_CHARS, paymentTermsToDays, reminderStage,
  statutoryDueDate, toDbDate, fromDbDate, type PoLineInput,
} from "../src/po-core";
import { decodeSignedQr, getEInvoiceVerifier, mockEInvoiceVerifier, qrSvgDataUri, setEInvoiceVerifier, type EInvoiceCheckInput, type EInvoiceVerifier } from "../src/einvoice";
import { computeFakeLeadRisk, hashIpPrefix, ipPrefix, labelledRowsToCsv, precisionRecall, uaFamily, type LabelledRow, type RiskInput } from "../src/risk";

const line = (over: Partial<PoLineInput> = {}): PoLineInput => ({ description: "Boxes", quantity: 2, unit: "pcs", unitPricePaise: 1000, gstRateBps: 1800, ...over });

describe("po-core line validation", () => {
  it.each([
    ["short description", { description: "x" }],
    ["description not a string", { description: 5 as unknown as string }],
    ["long description", { description: "d".repeat(301) }],
    ["bad hsn", { hsn: "12" + "x" }],
    ["zero quantity", { quantity: 0 }],
    ["fractional quantity", { quantity: 1.5 }],
    ["huge quantity", { quantity: 2_000_000_001 }],
    ["blank unit", { unit: "  " }],
    ["long unit", { unit: "u".repeat(33) }],
    ["unit not a string", { unit: 3 as unknown as string }],
    ["negative price", { unitPricePaise: -1 }],
    ["fractional price", { unitPricePaise: 1.5 }],
    ["negative gst", { gstRateBps: -1 }],
    ["gst above 40%", { gstRateBps: 4001 }],
    ["fractional gst", { gstRateBps: 12.5 }],
    ["line value too large", { quantity: 2_000_000, unitPricePaise: 1_000_000_000 }],
  ] as [string, Partial<PoLineInput>][])("rejects %s", (_n, over) => {
    expect(() => checkLine(line(over), "Line 3")).toThrowError(/^Line 3: /);
  });

  it("accepts an empty or missing hsn and a well-formed 2 to 8 digit one", () => {
    expect(() => checkLine(line({ hsn: "" }))).not.toThrow();
    expect(() => checkLine(line({ hsn: null }))).not.toThrow();
    expect(() => checkLine(line({ hsn: "48191010" }))).not.toThrow();
  });

  it("computePo needs 1..50 lines, trims text, keeps empty hsn null and sums per-line splits", () => {
    expect(() => computePo([], true)).toThrow(/at least one line/);
    expect(() => computePo(Array.from({ length: MAX_PO_LINES + 1 }, () => line()), true)).toThrow(/up to 50/);
    const r = computePo([line({ description: "  Boxes  ", unit: " pcs ", hsn: "", quoteId: "q1" }), line({ priceIncludesGst: true, hsn: "4819" })], false);
    expect(r.lines[0]).toMatchObject({ lineNo: 1, description: "Boxes", unit: "pcs", hsn: null, quoteId: "q1", priceIncludesGst: false });
    expect(r.lines[1]).toMatchObject({ lineNo: 2, hsn: "4819", quoteId: null, priceIncludesGst: true });
    expect(r.totals.cgstPaise + r.totals.sgstPaise).toBe(0);
    expect(r.totals.igstPaise).toBe(r.totals.taxPaise);
    expect(r.totals.totalPaise).toBe(r.totals.taxablePaise + r.totals.taxPaise);
  });
});

describe("po-core small helpers", () => {
  it("validates calendar dates strictly", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "26-01-01", "", null, 20260101, "2026-1-01"]) expect(isIsoDate(bad)).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(fromDbDate(toDbDate("2026-10-06"))).toBe("2026-10-06");
  });

  it("statutoryDueDate rejects an invalid acceptance date and truncates/clamps the agreed days", () => {
    expect(() => statutoryDueDate({ acceptance: "nope", agreedDays: 10, writtenAgreement: true })).toThrow(/acceptance date/);
    expect(statutoryDueDate({ acceptance: "2026-10-01", agreedDays: 10.9, writtenAgreement: true }).days).toBe(10);
    expect(statutoryDueDate({ acceptance: "2026-10-01", agreedDays: -5, writtenAgreement: true }).days).toBe(0);
  });

  it("reminderStage covers each window", () => {
    expect(reminderStage("2026-10-10", "2026-10-01")).toBeNull(); // 9 days
    expect(reminderStage("2026-10-08", "2026-10-01")).toBe("t7");
    expect(reminderStage("2026-10-03", "2026-10-01")).toBe("t7");
    expect(reminderStage("2026-10-02", "2026-10-01")).toBe("t1");
    expect(reminderStage("2026-10-01", "2026-10-01")).toBe("t1");
    expect(reminderStage("2026-09-30", "2026-10-01")).toBe("overdue");
  });

  it("maps quote payment terms to days and leaves free text to the buyer", () => {
    expect(["advance", "on_delivery", "escrow"].map(paymentTermsToDays)).toEqual([0, 0, 0]);
    expect(["net_7", "net_15", "net_30"].map(paymentTermsToDays)).toEqual([7, 15, 30]);
    expect(paymentTermsToDays("other")).toBeNull();
    expect(paymentTermsToDays(null)).toBeNull();
    expect(paymentTermsToDays(undefined)).toBeNull();
  });

  it("intra-state needs a known seller state equal to the place of supply; numbers are zero-padded", () => {
    expect(isIntraState("29", "29")).toBe(true);
    expect(isIntraState("29", "27")).toBe(false);
    expect(isIntraState("29", null)).toBe(false);
    expect(formatPoNumber("2026-27", 12)).toBe("PO/26-27/000012");
  });

  it("checkSignedQr trims and bounds the text", () => {
    expect(checkSignedQr(`  ${"a".repeat(20)}  `)).toBe("a".repeat(20));
    expect(() => checkSignedQr("short")).toThrow(/20 to/);
    expect(() => checkSignedQr("a".repeat(MAX_SIGNED_QR_CHARS + 1))).toThrow();
    expect(() => checkSignedQr(`${"a".repeat(25)}\u0007`)).toThrow();
  });
});

describe("e-invoice verifier", () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = (inner: unknown, wrap: "string" | "object" | "none" = "string") =>
    `${b64({ alg: "RS256" })}.${b64(wrap === "none" ? inner : { data: wrap === "string" ? JSON.stringify(inner) : inner })}.sig`;
  const input = (over: Partial<EInvoiceCheckInput> = {}): EInvoiceCheckInput => ({ irn: "a".repeat(64), ackNo: null, signedQr: null, sellerGstin: "29ABCDE1234F1Z5", invoiceNumber: "INV-1", invoiceDate: "2026-10-05", totalPaise: 118_000, ...over });

  it("decodes string, object and bare payloads, and returns null for junk", () => {
    expect(decodeSignedQr(token({ DocNo: "A" }))).toEqual({ DocNo: "A" });
    expect(decodeSignedQr(token({ DocNo: "B" }, "object"))).toEqual({ DocNo: "B" });
    expect(decodeSignedQr(token({ DocNo: "C" }, "none"))).toEqual({ DocNo: "C", });
    expect(decodeSignedQr("nodots")).toBeNull();
    expect(decodeSignedQr("a.@@@.c")).toBeNull();
    expect(decodeSignedQr(`a.${Buffer.from("null").toString("base64url")}.c`)).toBeNull();
  });

  it("is unchecked without a QR and a mismatch for an unreadable one", async () => {
    expect(await mockEInvoiceVerifier.verify(input())).toEqual({ status: "unchecked", note: null });
    expect(await mockEInvoiceVerifier.verify(input({ signedQr: "garbage" }))).toEqual({ status: "mismatch", note: "signedQr" });
  });

  it("flags each disagreeing field and tolerates rupee rounding", async () => {
    const ok = { Irn: "A".repeat(64), DocNo: " inv-1 ", SellerGstin: "29abcde1234f1z5", DocDt: "05/10/2026", TotInvVal: 1180 };
    expect((await mockEInvoiceVerifier.verify(input({ signedQr: token(ok) }))).status).toBe("consistent");
    expect((await mockEInvoiceVerifier.verify(input({ signedQr: token({ ...ok, TotInvVal: "1180.4" }) }))).status).toBe("consistent");
    const bad = await mockEInvoiceVerifier.verify(input({ signedQr: token({ Irn: "b".repeat(64), DocNo: "X", SellerGstin: "27ZZZZZ0000Z1Z5", DocDt: "06/10/2026", TotInvVal: 999 }) }));
    expect(bad).toEqual({ status: "mismatch", note: "irn,docNo,sellerGstin,date,total" });
    // fields that are absent or of an unexpected type are ignored; a non-numeric total is not compared
    expect((await mockEInvoiceVerifier.verify(input({ signedQr: token({ DocNo: 5, Irn: 5, SellerGstin: 5, DocDt: 5, TotInvVal: "n/a" }) }))).status).toBe("consistent");
    expect((await mockEInvoiceVerifier.verify(input({ irn: null, sellerGstin: null, signedQr: token({ Irn: "c".repeat(64), SellerGstin: "29ABCDE1234F1Z5" }) }))).status).toBe("consistent");
  });

  it("swaps the adapter and restores the mock on null", async () => {
    const stub: EInvoiceVerifier = { name: "stub", verify: async () => ({ status: "consistent", note: null }) };
    setEInvoiceVerifier(stub);
    try {
      expect(getEInvoiceVerifier().name).toBe("stub");
    } finally {
      setEInvoiceVerifier(null);
    }
    expect(getEInvoiceVerifier()).toBe(mockEInvoiceVerifier);
  });

  it("renders a QR data URI only for bounded, non-empty text", async () => {
    expect(await qrSvgDataUri("")).toBeNull();
    expect(await qrSvgDataUri("x".repeat(MAX_SIGNED_QR_CHARS + 1))).toBeNull();
    expect((await qrSvgDataUri("hello"))?.startsWith("data:image/svg+xml;base64,")).toBe(true);
    // too much data for a version-40 symbol at level L: the encoder throws and we return null
    expect(await qrSvgDataUri("é".repeat(1500))).toBeNull();
  });
});

describe("fake-lead risk signals", () => {
  it("classifies user agents", () => {
    const cases: [string | null | undefined, string][] = [
      [null, "none"], ["  ", "none"], ["Googlebot/2.1", "bot"], ["HeadlessChrome", "bot"], ["curl/8.0", "script"], ["python-requests/2.31", "script"],
      ["Mozilla/5.0 (Linux; Android 14) SamsungBrowser/23.0 Chrome/115", "samsung"], ["Mozilla/5.0 Windows Edg/120.0", "edge"], ["Mozilla/5.0 Firefox/121.0", "firefox"],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 17) Safari/604", "safari-ios"], ["Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile", "chrome-android"],
      ["Mozilla/5.0 (Windows NT 10) Chrome/120 Safari/537", "chrome-desktop"], ["Mozilla/5.0 (Macintosh) Version/17 Safari/605", "safari-desktop"], ["Lynx/2.9", "other"],
    ];
    for (const [ua, want] of cases) expect(uaFamily(ua)).toBe(want);
  });

  it("truncates ip addresses to a prefix and never guesses", () => {
    expect(ipPrefix("203.0.113.45")).toBe("203.0.113");
    expect(ipPrefix(" 10.1.2.3 ")).toBe("10.1.2");
    expect(ipPrefix("2001:db8:85a3:0:0:8a2e:370:7334")).toBe("2001:0db8:85a3");
    expect(ipPrefix("2001:DB8::1")).toBe("2001:0db8:0000");
    expect(ipPrefix("fe80::")).toBe("fe80:0000:0000");
    expect(ipPrefix("::1")).toBe("0000:0000:0000");
    expect(ipPrefix("::ffff:1.2.3.4")).toBeNull();
    expect(ipPrefix("not an ip")).toBeNull();
    expect(ipPrefix("")).toBeNull();
    expect(ipPrefix(undefined)).toBeNull();
    expect(hashIpPrefix("nope")).toBeNull();
    expect(hashIpPrefix("203.0.113.45")).toBe(hashIpPrefix("203.0.113.99"));
    expect(hashIpPrefix("203.0.113.45")).not.toBe(hashIpPrefix("203.0.114.45"));
  });

  it("sums weights per rule, with reasons, capped at 100", () => {
    const calm: RiskInput = { uaFamily: "chrome-android", hasIp: true, phoneVerified: true, velocityPerson1h: 0, velocityPerson24h: 0, distinctOtherPersonsOnIp24h: 0 };
    expect(computeFakeLeadRisk(calm)).toEqual({ score: 0, reasons: [] });
    expect(computeFakeLeadRisk({ ...calm, uaFamily: "bot" }).score).toBe(40);
    expect(computeFakeLeadRisk({ ...calm, uaFamily: "script" }).score).toBe(35);
    expect(computeFakeLeadRisk({ ...calm, uaFamily: "none", hasIp: false, phoneVerified: false }).score).toBe(35);
    expect(computeFakeLeadRisk({ ...calm, velocityPerson1h: 3 }).score).toBe(20);
    expect(computeFakeLeadRisk({ ...calm, velocityPerson1h: 5 }).score).toBe(40);
    expect(computeFakeLeadRisk({ ...calm, velocityPerson24h: 6 }).score).toBe(10);
    expect(computeFakeLeadRisk({ ...calm, velocityPerson24h: 10 }).score).toBe(20);
    expect(computeFakeLeadRisk({ ...calm, distinctOtherPersonsOnIp24h: 3 }).reasons[0]).toMatch(/^4 different buyers/);
    expect(computeFakeLeadRisk({ ...calm, distinctOtherPersonsOnIp24h: 6 }).score).toBe(35);
    const worst = computeFakeLeadRisk({ uaFamily: "bot", hasIp: false, phoneVerified: false, velocityPerson1h: 9, velocityPerson24h: 20, distinctOtherPersonsOnIp24h: 9 });
    expect(worst.score).toBe(100);
    expect(worst.reasons).toHaveLength(6);
  });

  it("computes precision and recall, null on empty denominators, and writes a CSV without free text", () => {
    expect(precisionRecall([])).toMatchObject({ labelled: 0, precision: null, recall: null });
    const pr = precisionRecall([
      { isFake: true, predictedFake: true }, { isFake: false, predictedFake: true }, { isFake: true, predictedFake: false }, { isFake: false, predictedFake: false }, { isFake: true, predictedFake: true },
    ]);
    expect(pr).toMatchObject({ truePositive: 2, falsePositive: 1, falseNegative: 1, trueNegative: 1, precision: 2 / 3, recall: 2 / 3 });
    expect(precisionRecall([{ isFake: false, predictedFake: false }])).toMatchObject({ precision: null, recall: null });

    const row: LabelledRow = { enquiryId: "e1", createdAt: "2026-10-01T00:00:00.000Z", label: "=cmd|' /C calc'!A0", isFake: true, riskScore: 70, intentScore: null, predictedFake: true, uaFamily: "bot", velocityPerson1h: 1, velocityPerson24h: 2, velocityIp24h: 3, reachability: 'a,"b"' };
    const csv = labelledRowsToCsv([row]);
    const [head, body] = csv.trim().split("\r\n");
    expect(head!.split(",")).toHaveLength(12);
    expect(body).not.toMatch(/^=|,=/); // formula neutralised
    expect(body).toContain('"a,""b"""'); // quoting
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});

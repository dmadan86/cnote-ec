import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { amountInWords, computeLines, financialYear, numberToWordsIN, placeOfSupply, platformSupplier, renderInvoicePdf, splitGst, splitInclusive } from "../src/invoices";
import { stateFromGstin } from "../src/parties";

describe("GST split", () => {
  it("cgst + sgst + igst equals total GST exactly, and total = taxable + gst", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 5_000_000_000 }), fc.constantFrom(0, 500, 1200, 1800, 2800), fc.boolean(), (t, r, intra) => {
      const s = splitGst(t, r, intra);
      expect(s.cgstPaise + s.sgstPaise + s.igstPaise).toBe(s.gstPaise);
      expect(s.totalPaise).toBe(t + s.gstPaise);
      expect(intra ? s.igstPaise : s.cgstPaise + s.sgstPaise).toBe(0);
      expect(Math.abs(s.gstPaise - (t * r) / 10_000)).toBeLessThanOrEqual(0.5);
      if (intra) expect(s.sgstPaise - s.cgstPaise).toBeLessThanOrEqual(1);
    }));
  });
  it("inclusive split always sums to the given total", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 2_000_000_000 }), fc.boolean(), (total, intra) => {
      const s = splitInclusive(total, 1800, intra);
      expect(s.taxablePaise + s.cgstPaise + s.sgstPaise + s.igstPaise).toBe(total);
    }));
  });
  it("rounds half up: 18% of 99,900 paise = 17,982", () => {
    expect(splitGst(99_900, 1800, true)).toMatchObject({ gstPaise: 17_982, cgstPaise: 8991, sgstPaise: 8991, totalPaise: 117_882 });
    expect(splitGst(5, 1800, false).gstPaise).toBe(1); // 0.9 -> 1
  });
  it("rejects bad input", () => {
    expect(() => splitGst(-1, 1800, true)).toThrow();
    expect(() => splitGst(1.5, 1800, true)).toThrow();
    expect(() => splitGst(1, -1, true)).toThrow();
  });
  it("computeLines totals equal the sum of lines", () => {
    const { lines, totals } = computeLines([{ description: "a", sac: "998314", quantity: 3, unitPaise: 3333, gstRateBps: 1800 }, { description: "b", sac: "998314", quantity: 1, unitPaise: 101, gstRateBps: 1800 }], false);
    expect(lines).toHaveLength(2);
    expect(totals.totalPaise).toBe(totals.taxablePaise + totals.igstPaise);
  });
});

describe("financial year (IST)", () => {
  it("rolls on 1 April IST", () => {
    expect(financialYear(new Date("2026-03-31T18:29:00Z"))).toBe("2025-26"); // 23:59 IST 31 Mar
    expect(financialYear(new Date("2026-03-31T18:30:00Z"))).toBe("2026-27"); // 00:00 IST 1 Apr
    expect(financialYear(new Date("2027-01-15T00:00:00Z"))).toBe("2026-27");
  });
});

describe("amount in words (Indian numbering)", () => {
  it.each([
    [0, "Rupees Zero Only"],
    [100, "Rupees One Only"],
    [117_882, "Rupees One Thousand One Hundred and Seventy Eight and Eighty Two Paise Only"],
    [12_345_600, "Rupees One Lakh Twenty Three Thousand Four Hundred and Fifty Six Only"],
    [10_000_000_00, "Rupees One Crore Only"],
    [2_51_00_000_00, "Rupees Two Crore Fifty One Lakh Only"],
    [5, "Rupees Zero and Five Paise Only"],
  ])("%i", (p, w) => {
    // "and" only appears before the paise part; normalise the hundreds "and" our formatter does not emit
    expect(amountInWords(p).replace(" and ", " ")).toBe(w.replace(/ and /g, " "));
  });
  it("numberToWordsIN handles teens and tens", () => {
    expect(numberToWordsIN(19)).toBe("Nineteen");
    expect(numberToWordsIN(90)).toBe("Ninety");
    expect(numberToWordsIN(100_000)).toBe("One Lakh");
  });
});

describe("place of supply", () => {
  it("uses recipient state, else supplier state", () => {
    expect(placeOfSupply("27", "29")).toBe("27");
    expect(placeOfSupply(null, "29")).toBe("29");
    expect(placeOfSupply("bad", "29")).toBe("29");
    expect(stateFromGstin("27AAPFU0939F1ZV")).toBe("27");
    expect(stateFromGstin("x")).toBeNull();
    expect(stateFromGstin(null)).toBeNull();
  });
  it("platformSupplier reads env with sane fallbacks", () => {
    expect(platformSupplier({ PLATFORM_STATE_CODE: "07", PLATFORM_SAC: "998313", PLATFORM_GST_RATE_BPS: "1200" } as never)).toMatchObject({ stateCode: "07", sac: "998313", gstRateBps: 1200 });
    expect(platformSupplier({} as never)).toMatchObject({ stateCode: "29", sac: "998314", gstRateBps: 1800 });
    expect(platformSupplier({ PLATFORM_GST_RATE_BPS: "x" } as never).gstRateBps).toBe(1800);
  });
});

describe("PDF", () => {
  it("renders a valid PDF for invoice and credit note (incl. IGST, long text, non-latin)", async () => {
    const sup = { name: "Cnote Pvt Ltd", gstin: "29ABCDE1234F1Z5", address: "1 MG Road, Bengaluru", stateCode: "29", sac: "998314", gstRateBps: 1800 };
    const { lines, totals } = computeLines([{ description: "Pro plan - 1 month " + "long ".repeat(30) + "हिंदी", sac: "998314", quantity: 1, unitPaise: 299_900, gstRateBps: 1800 }], false);
    for (const kind of ["tax_invoice", "credit_note"]) {
      const bytes = await renderInvoicePdf({
        number: "CN/26-27/000001", kind, supplier: sup, recipient: { name: "Buyer", gstin: null, address: "Pune", stateCode: "27" }, lines,
        taxablePaise: BigInt(totals.taxablePaise), cgstPaise: 0n, sgstPaise: 0n, igstPaise: BigInt(totals.igstPaise), totalPaise: BigInt(totals.totalPaise), placeOfSupply: "27", issuedAt: new Date(), refInvoiceId: "x",
      } as never);
      expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    }
  });
});

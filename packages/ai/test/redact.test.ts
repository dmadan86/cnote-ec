import { describe, expect, it } from "vitest";
import { redactDeep, redactPii } from "../src";

describe("redactPii (ADR-010)", () => {
  it("masks emails, phones, GSTIN, PAN and Aadhaar-like numbers", () => {
    const out = redactPii(
      "mail a.b@corp.co.in, call +91 98765 43210 or 9876543210, GSTIN 27ABCDE1234F1Z5, PAN ABCDE1234F, aadhaar 1234 5678 9012",
    );
    expect(out).toBe("mail [email], call [phone] or [phone], GSTIN [gstin], PAN [pan], aadhaar [aadhaar]");
  });
  it("keeps ordinary quantities and pincodes", () => {
    expect(redactPii("500 pcs to 560001, 180 gsm")).toBe("500 pcs to 560001, 180 gsm");
  });
  it("redacts nested strings", () => {
    expect(redactDeep({ a: ["x@y.com"], n: 3 })).toEqual({ a: ["[email]"], n: 3 });
  });
});

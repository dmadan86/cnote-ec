import { describe, expect, it } from "vitest";
import { GRIEVANCE_CATEGORIES } from "@cnote/compliance";
import { isHttpUrl, reportToTicket, safePrefillUrl, validateReport } from "@/features/legal/report";

const VALID = {
  url: "https://example.in/p/abc",
  type: "ipr",
  name: "Asha Rao",
  email: "asha@example.in",
  details: "This listing uses our registered trademark without permission.",
  proof: "https://example.in/certificate.pdf",
  declaration: "on",
};

describe("report form validation", () => {
  it("accepts a complete report and trims values", () => {
    const r = validateReport({ ...VALID, name: "  Asha Rao  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ name: "Asha Rao", type: "ipr", url: VALID.url });
  });

  it("proof is optional", () => {
    expect(validateReport({ ...VALID, proof: "" }).ok).toBe(true);
  });

  it("reports an error code per invalid field", () => {
    const r = validateReport({ url: "", type: "nope", name: "", email: "x", details: "short", proof: "javascript:alert(1)" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual({ url: "urlRequired", type: "typeRequired", name: "nameRequired", email: "emailInvalid", details: "detailsShort", proof: "proofInvalid", declaration: "declarationRequired" });
    }
  });

  it("requires the good-faith declaration", () => {
    const r = validateReport({ ...VALID, declaration: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual({ declaration: "declarationRequired" });
  });

  it("rejects non-http(s) links and over-long text", () => {
    expect(validateReport({ ...VALID, url: "ftp://x.in/a" }).ok).toBe(false);
    expect(validateReport({ ...VALID, url: "not a url" }).ok).toBe(false);
    const long = validateReport({ ...VALID, details: "x".repeat(3001) });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.errors.details).toBe("detailsLong");
  });

  it("accepts every report type", () => {
    for (const type of ["ipr", "counterfeit", "prohibited", "fraud", "other"]) expect(validateReport({ ...VALID, type }).ok, type).toBe(true);
  });
});

describe("?url= prefill", () => {
  it("passes only safe http(s) URLs", () => {
    expect(safePrefillUrl("https://example.in/p/1")).toBe("https://example.in/p/1");
    expect(safePrefillUrl("javascript:alert(1)")).toBe("");
    expect(safePrefillUrl("data:text/html,x")).toBe("");
    expect(safePrefillUrl(null)).toBe("");
    expect(isHttpUrl(`https://a.in/${"x".repeat(2000)}`)).toBe(false);
  });
});

describe("ticket mapping", () => {
  it("fits the grievance limits and carries every field", () => {
    const r = validateReport({ ...VALID, details: "d".repeat(3000), url: `https://example.in/${"u".repeat(1900)}` });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = reportToTicket(r.value);
    expect(t.subject.length).toBeLessThanOrEqual(200);
    expect(t.body.length).toBeLessThanOrEqual(5000);
    expect(t.body).toContain("asha@example.in");
    expect(t.body).toContain("Good-faith declaration: accepted");
  });

  it("files under a category the compliance module accepts", () => {
    expect(GRIEVANCE_CATEGORIES).toContain("report");
  });
});

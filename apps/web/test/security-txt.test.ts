import { describe, expect, it } from "vitest";
import { GET } from "@/app/.well-known/security.txt/route";
import { buildSecurityTxt, securityTxtExpires } from "@/features/legal/security-txt";

const NOW = new Date("2026-10-02T10:00:00.000Z");

describe("security.txt", () => {
  it("renders every RFC 9116 field from env", () => {
    const txt = buildSecurityTxt({ SECURITY_CONTACT_EMAIL: "sec@example.in", SUPPORT_EMAIL: "help@example.in", APP_URL: "https://shop.example.in/" }, NOW);
    expect(txt).toContain("Contact: mailto:sec@example.in");
    expect(txt).toContain("Expires: 2027-10-01T10:00:00.000Z");
    expect(txt).toContain("Preferred-Languages: en, hi");
    expect(txt).toContain("Policy: https://shop.example.in/security");
    expect(txt).toContain("Canonical: https://shop.example.in/.well-known/security.txt");
    expect(txt.endsWith("\n")).toBe(true);
  });
  it("falls back to the support email, then to security@<host>", () => {
    expect(buildSecurityTxt({ SUPPORT_EMAIL: "help@example.in", APP_URL: "https://x.in" }, NOW)).toContain("Contact: mailto:help@example.in");
    expect(buildSecurityTxt({ SECURITY_CONTACT_EMAIL: "  ", APP_URL: "https://shop.example.in" }, NOW)).toContain("Contact: mailto:security@shop.example.in");
    expect(buildSecurityTxt({}, NOW)).toContain("Contact: mailto:security@localhost");
    expect(buildSecurityTxt({ APP_URL: "not a url" }, NOW)).toContain("mailto:security@localhost");
  });
  it("expires one year (less a day) ahead, also across leap days", () => {
    expect(securityTxtExpires(new Date("2027-03-01T00:00:00.000Z"))).toBe("2028-02-29T00:00:00.000Z");
  });
  it("route serves text/plain", async () => {
    const res = GET();
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toMatch(/^# Security contact/);
  });
});

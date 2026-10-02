import { describe, expect, it } from "vitest";
import { mailtoHref, telHref, whatsappHref } from "@/features/contact/links";

describe("contact links", () => {
  it("tel: only for valid E.164", () => {
    expect(telHref("+919876543210")).toBe("tel:+919876543210");
    expect(telHref("9876543210")).toBeNull();
    expect(telHref("+91 98765 43210")).toBeNull();
    expect(telHref("javascript:alert(1)")).toBeNull();
    expect(telHref(null)).toBeNull();
  });
  it("wa.me uses the digits without + and a prefilled, encoded message naming the product", () => {
    const msg = 'Hello, I found "Kraft Box" on BizKart & I am interested.';
    const href = whatsappHref("+919876543210", msg)!;
    expect(href.startsWith("https://wa.me/919876543210?text=")).toBe(true);
    expect(decodeURIComponent(href.split("text=")[1]!)).toBe(msg);
    expect(href).not.toContain("+");
    expect(whatsappHref("12345", msg)).toBeNull();
    expect(whatsappHref(null, msg)).toBeNull();
  });
  it("mailto: encodes the subject and body and rejects non-addresses", () => {
    const href = mailtoHref("sales@acme.example", "Enquiry about A&B", "Hi there")!;
    expect(href).toBe("mailto:sales@acme.example?subject=Enquiry%20about%20A%26B&body=Hi%20there");
    expect(mailtoHref("not an email", "s", "b")).toBeNull();
    expect(mailtoHref("a@b.c,evil@x.y", "s", "b")).toBeNull();
    expect(mailtoHref(null, "s", "b")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { redactPii } from "../src";

describe("redactPii coverage and bounds (security audit)", () => {
  const phones = [
    "+91 98765 43210", "+91-98765-43210", "+91 - 98 765 - 43 210", "91 9876543210", "09876543210", "98765 43210",
    "9 8 7 6 5 4 3 2 1 0", "+91 (98765) 43210", "98765-43210", "(011) 2345 6789", "011-23456789", "080 2345 6789", "+91 11 23456789", "0484-2345678",
  ];
  for (const p of phones) {
    it(`no phone digits survive: ${p}`, () => {
      const out = redactPii(`call me on ${p} tomorrow`);
      expect(out.replace(/\D/g, "")).toBe("");
      expect(out).toContain("[phone]");
    });
  }

  it("handles the +91 0 trunk form and ignores long non-phone digit runs", () => {
    expect(redactPii("call +91 0 98765 43210").replace(/\D/g, "")).toBe("");
    expect(redactPii("lot 1 2 3 4 5 6 7 8 9 0 1 2 3 4")).toBe("lot 1 2 3 4 5 6 7 8 9 0 1 2 3 4");
  });

  it("property: random mobiles in random separators never survive", () => {
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >> 8) % n; };
    const seps = ["", " ", "-", "  ", " - ", "."];
    for (let i = 0; i < 300; i++) {
      const digits = String(6 + rnd(4)) + Array.from({ length: 9 }, () => rnd(10)).join("");
      const prefix = ["", "+91", "91", "0", "+91 "][rnd(5)]!;
      let s = prefix;
      for (const d of digits) s += d + seps[rnd(seps.length)]!;
      expect(redactPii(`reach ${s.trim()} now`).replace(/\D/g, ""), s).toBe("");
    }
  });

  it("property: emails with assorted shapes never survive", () => {
    for (const e of ["a@b.com", "first.last+tag@sub.example.co.in", "X_Y%z@corp-name.io"]) expect(redactPii(`mail ${e}!`)).not.toContain("@");
  });

  it("redacts PIN-code addresses and names after markers", () => {
    expect(redactPii("Deliver to Plot 5, Okhla Industrial Area, New Delhi 110020 asap")).not.toContain("110020");
    expect(redactPii("My name is Rajesh Kumar and I need 500 pcs")).toBe("My name is [name] and I need 500 pcs");
    expect(redactPii("Contact: Anil Gupta")).toContain("[name]");
    expect(redactPii("Shri Anil Gupta wants cotton")).toContain("Shri [name]");
    expect(redactPii("Contact us for details")).toBe("Contact us for details");
  });

  it("keeps quantities, prices and bare pincodes", () => {
    expect(redactPii("10000 pcs at 25 each, 2026-10-02")).toBe("10000 pcs at 25 each, 2026-10-02");
  });

  it("caps input length and stays fast on adversarial input", () => {
    const evil = "1 ".repeat(100_000) + "a".repeat(100_000) + ".".repeat(50_000);
    const t = performance.now();
    const out = redactPii(evil);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(out.length).toBeLessThan(21_000);
  });
});

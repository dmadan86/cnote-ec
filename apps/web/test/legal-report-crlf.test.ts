import { describe, expect, it } from "vitest";
import { isHttpUrl, reportToTicket, validateReport } from "@/features/legal/report";

const VALID = {
  url: "https://example.in/p/abc",
  type: "ipr",
  name: "Asha Rao",
  email: "asha@example.in",
  details: "This listing uses our registered trademark without permission.",
  proof: "",
  declaration: "on",
};

describe("report URL and header injection (security audit)", () => {
  // new URL() silently strips tab/CR/LF, so these used to validate and the raw text (with CRLF) was stored
  for (const bad of ["https://example.in/a\r\nBcc: attacker@evil.test", "https://example.in/a\nX: y", "https://exa\tmple.in/", "https://example.in/\u0000"]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(isHttpUrl(bad)).toBe(false);
      const r = validateReport({ ...VALID, url: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.url).toBe("urlInvalid");
    });
  }

  it("rejects CR/LF in the proof URL too", () => {
    const r = validateReport({ ...VALID, proof: "https://example.in/p\r\nX: y" });
    expect(r.ok).toBe(false);
  });

  it("stores the normalised href and a single-line name; the ticket subject has no CR/LF", () => {
    const r = validateReport({ ...VALID, url: "https://EXAMPLE.in", name: "Asha\r\nBcc: x@y.z" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.url).toBe("https://example.in/");
    expect(r.value.name).not.toMatch(/[\r\n]/);
    const { subject, body } = reportToTicket({ ...r.value, name: "A\nB", type: "ipr" });
    expect(subject).not.toMatch(/[\r\n]/);
    expect(body.split("\n").find((l) => l.startsWith("Claimant:"))).toBe("Claimant: A B <asha@example.in>");
  });
});

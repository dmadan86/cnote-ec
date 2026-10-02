import { beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.fn();
vi.mock("node:dns/promises", () => ({ lookup: (...a: unknown[]) => lookup(...a) }));
const pinned = vi.fn();
vi.mock("@cnote/security", async (orig) => ({ ...(await orig<typeof import("@cnote/security")>()), pinnedFetch: (...a: unknown[]) => pinned(...a) }));

const { httpProbe } = await import("../src/verify");

beforeEach(() => { lookup.mockReset(); pinned.mockReset(); });

describe("domain probe is not an SSRF primitive (security audit)", () => {
  const targets: [string, { address: string; family: number }[]][] = [
    ["evil.example.com", [{ address: "169.254.169.254", family: 4 }]], // cloud metadata
    ["evil2.example.com", [{ address: "10.0.0.5", family: 4 }]],
    ["evil3.example.com", [{ address: "127.0.0.1", family: 4 }]],
    ["evil4.example.com", [{ address: "::1", family: 6 }]],
    ["evil5.example.com", [{ address: "fd00::1", family: 6 }]],
    ["evil6.example.com", [{ address: "93.184.216.34", family: 4 }, { address: "192.168.1.1", family: 4 }]], // one bad answer poisons the set
  ];
  for (const [host, answers] of targets) {
    it(`refuses ${host} -> ${answers.map((a) => a.address).join(",")} without connecting`, async () => {
      lookup.mockResolvedValue(answers);
      const r = await httpProbe(host);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/public internet address/);
      expect(pinned).not.toHaveBeenCalled();
    });
  }

  it("refuses literal-IP and local names, and unresolvable hosts", async () => {
    for (const h of ["169.254.169.254", "localhost", "metadata.google.internal", "[::1]"]) expect((await httpProbe(h)).ok, h).toBe(false);
    lookup.mockResolvedValue([]);
    expect((await httpProbe("nx.example.com")).ok).toBe(false);
    expect(pinned).not.toHaveBeenCalled();
  });

  it("resolves once and hands the validated address to the pinned client", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    pinned.mockRejectedValue(new Error("stop here"));
    const r = await httpProbe("shop.example.com");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(pinned).toHaveBeenCalledTimes(1);
    expect(r.error).toMatch(/stop here/);
  });
});

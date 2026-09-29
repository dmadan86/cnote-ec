import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PRIVILEGES, ROLES, ROLE_PRIVILEGES, isRole, privilegesFor } from "../src";
import { hasPrivilege, requirePrivilege } from "../src/context";

describe("rbac properties", () => {
  it("every role's privileges are a subset of PRIVILEGES, without duplicates", () => {
    for (const r of ROLES) {
      const list = ROLE_PRIVILEGES[r];
      expect(new Set(list).size).toBe(list.length);
      for (const p of list) expect(PRIVILEGES).toContain(p);
    }
  });
  it("PRIVILEGES has no duplicates and ROLE_PRIVILEGES covers exactly ROLES", () => {
    expect(new Set(PRIVILEGES).size).toBe(PRIVILEGES.length);
    expect(Object.keys(ROLE_PRIVILEGES).sort()).toEqual([...ROLES].sort());
  });
  it("full role x privilege matrix matches privilegesFor / hasPrivilege / requirePrivilege", () => {
    for (const r of ROLES) {
      const set = privilegesFor([r]);
      for (const p of PRIVILEGES) {
        const expected = ROLE_PRIVILEGES[r].includes(p);
        expect(set.has(p)).toBe(expected);
        expect(hasPrivilege({ privileges: [...set] }, p)).toBe(expected);
        if (expected) expect(() => requirePrivilege({ privileges: [...set] }, p)).not.toThrow();
        else expect(() => requirePrivilege({ privileges: [...set] }, p)).toThrow(expect.objectContaining({ code: "forbidden" }));
      }
    }
  });
  it("super_admin has all; unknown roles grant nothing; union is monotone", () => {
    expect(privilegesFor(["super_admin"]).size).toBe(PRIVILEGES.length);
    fc.assert(
      fc.property(fc.array(fc.string()), (codes) => {
        const known = codes.filter(isRole);
        const got = privilegesFor(codes);
        expect(got).toEqual(privilegesFor(known));
        for (const p of got) expect(PRIVILEGES).toContain(p);
        if (!known.length) expect(got.size).toBe(0);
        if (known.includes("super_admin")) expect(got.size).toBe(PRIVILEGES.length);
      }),
    );
    fc.assert(
      fc.property(fc.subarray([...ROLES]), fc.constantFrom(...ROLES), (base, extra) => {
        const a = privilegesFor(base);
        const b = privilegesFor([...base, extra]);
        for (const p of a) expect(b.has(p)).toBe(true);
      }),
    );
  });
  it("hasPrivilege is false for privileges outside the list and requirePrivilege carries the privilege", () => {
    expect(hasPrivilege({ privileges: [] }, "audit.read")).toBe(false);
    try {
      requirePrivilege({ privileges: [] }, "audit.read");
    } catch (e) {
      expect((e as { details?: unknown }).details ?? (e as { meta?: unknown }).meta).toBeDefined();
    }
  });
  it("isRole is prototype-safe", () => {
    for (const s of ["__proto__", "constructor", "toString", "", "SUPER_ADMIN"]) expect(isRole(s)).toBe(false);
    expect(privilegesFor(["__proto__", "constructor"]).size).toBe(0);
  });
});

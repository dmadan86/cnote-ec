// Shared helpers behind the views: category cache, trust profiles, contact lookup and view mapping.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  listCategories: vi.fn(async () => [{ id: "c1", slug: "fasteners", name: "Fasteners", prohibited: false, leadCap: 3 }]),
  getTrustProfiles: vi.fn(async (ids: string[]) => new Map(ids.map((i) => [i, { name: `n-${i}` }]))),
  contact: { fn: undefined as undefined | ((id: string) => Promise<{ phone: string | null } | null>) },
}));

vi.mock("@cnote/catalogue", () => ({ listCategories: m.listCategories }));
vi.mock("@cnote/identity", () => ({
  getTrustProfiles: m.getTrustProfiles,
  get getPersonContact() { return m.contact.fn; },
}));

import { categories, categoryById, enquiryBase, matchView, personContact, profiles, strArr } from "../src/support";

beforeEach(() => { m.contact.fn = undefined; m.getTrustProfiles.mockClear(); });

describe("categories", () => {
  it("caches the catalogue list for a minute and finds by id", async () => {
    const first = await categories();
    await categories();
    expect(m.listCategories).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(1);
    expect(await categoryById("c1")).toMatchObject({ slug: "fasteners" });
    expect(await categoryById("missing")).toBeNull();
    expect(await categoryById(null)).toBeNull();
  });
});

describe("profiles and contacts", () => {
  it("de-duplicates ids, and skips the lookup for none", async () => {
    expect((await profiles(["a", "a", "b"])).size).toBe(2);
    expect(m.getTrustProfiles).toHaveBeenCalledWith(["a", "b"]);
    expect((await profiles([])).size).toBe(0);
    expect(m.getTrustProfiles).toHaveBeenCalledTimes(1);
  });

  it("degrades to no contact until identity exports getPersonContact", async () => {
    expect(await personContact("p1")).toBeNull();
    m.contact.fn = async () => ({ phone: "+919999900000" });
    expect(await personContact("p1")).toEqual({ phone: "+919999900000" });
    m.contact.fn = async () => null;
    expect(await personContact("p1")).toBeNull();
  });
});

describe("view mapping", () => {
  it("strArr keeps only strings", () => {
    expect(strArr(["a", 1, null, "b"])).toEqual(["a", "b"]);
    expect(strArr("a")).toEqual([]);
    expect(strArr(null)).toEqual([]);
  });

  it("enquiryBase handles absent optional values", () => {
    const e = {
      id: "e1", title: "T", requirement: "R", quantity: null, quantityUnit: null, targetPricePaise: null, deliveryCity: null, deliveryPincode: null, neededBy: null,
      intentScore: null, intentReasons: null, status: "open", createdAt: new Date("2026-10-01T00:00:00Z"), buyerPicks: [], sellerCap: 3, budgetMinPaise: null, budgetMaxPaise: null,
      expiresAt: null, minSellerTier: 0,
    };
    const v = enquiryBase(e as never, null);
    expect(v).toMatchObject({ category: null, targetPricePaise: null, neededBy: null, expiresAt: null, budgetMinPaise: null, budgetMaxPaise: null, intentReasons: [], attachments: [], lines: [] });
    const full = enquiryBase({ ...e, targetPricePaise: 500n, budgetMinPaise: 1n, budgetMaxPaise: 9n, neededBy: new Date("2026-11-02T00:00:00Z"), expiresAt: new Date("2026-12-01T00:00:00Z"), intentReasons: ["x", 2] } as never, { slug: "s", name: "S" } as never);
    expect(full).toMatchObject({ category: { slug: "s", name: "S" }, targetPricePaise: 500, budgetMinPaise: 1, budgetMaxPaise: 9, neededBy: "2026-11-02", expiresAt: "2026-12-01T00:00:00.000Z", intentReasons: ["x"] });
  });

  it("matchView falls back to a generic seller name when there is no profile", () => {
    const match = { id: "m1", enquiryId: "e1", sellerBusinessId: "s1", rank: 2, matchScore: 0.5, status: "offered", respondBy: new Date("2026-10-02T00:00:00Z") };
    expect(matchView(match as never, 3, undefined, null)).toMatchObject({ sellerName: "Seller", of: 3, conversationId: null, seller: undefined });
    const p = { name: "Acme", verificationTier: 2, badgeActive: true, trustScore: 70, city: "Pune" };
    expect(matchView(match as never, 3, p as never, "c1")).toMatchObject({ sellerName: "Acme", conversationId: "c1", seller: { verificationTier: 2, badgeActive: true, trustScore: 70, city: "Pune" } });
  });
});

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const sub = vi.hoisted(() => ({ value: null as { planCode: string } | null, plans: [] as { code: string; features: string[] }[], listings: [] as unknown[], profile: { state: "Maharashtra", pincode: "400001" } as { state: string | null; pincode: string | null } }));
vi.mock("@cnote/billing", () => ({ getActiveSubscription: async () => sub.value, listPlans: async () => sub.plans }));
vi.mock("@cnote/catalogue", async (orig) => ({ ...(await orig<typeof import("@cnote/catalogue")>()), listSellerListings: async () => sub.listings }));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: async (ids: string[]) => new Map(ids.map((i) => [i, { businessId: i, ...sub.profile }])) }));

import { cleanup, mkCategory, seedQualifying } from "./helpers";
import { getSellerCompetitiveness, hasPriceIntelPlan, runBenchmarks } from "../src/index";

afterAll(cleanup);
beforeEach(() => { process.env.PRICE_INTEL_ENABLED = "1"; sub.value = { planCode: "pro" }; sub.plans = []; });

const listing = (o: Record<string, unknown>) => ({ id: "l1", title: "Widget", status: "published", pricePaise: 1000, priceUnit: "kg", moq: 10, category: { id: "x", name: "Cat" }, ...o });

describe("seller competitiveness", () => {
  it("flag off / free plan / paid plan", async () => {
    process.env.PRICE_INTEL_ENABLED = "0";
    expect(await getSellerCompetitiveness("b")).toEqual({ enabled: false });
    process.env.PRICE_INTEL_ENABLED = "1";
    sub.value = null;
    expect(await getSellerCompetitiveness("b")).toEqual({ enabled: true, premium: false });
    sub.value = { planCode: "free" };
    expect(await hasPriceIntelPlan("b")).toBe(false);
    sub.value = { planCode: "starter" };
    expect(await hasPriceIntelPlan("b")).toBe(true);
  });

  it("when a plan lists the feature, only those plans qualify", async () => {
    sub.plans = [{ code: "starter", features: ["x"] }, { code: "pro", features: ["Price intelligence dashboards"] }];
    sub.value = { planCode: "starter" };
    expect(await hasPriceIntelPlan("b")).toBe(false);
    sub.value = { planCode: "pro" };
    expect(await hasPriceIntelPlan("b")).toBe(true);
  });

  it("places each live listing below / within / above the band, with no-data and skipped cases", async () => {
    const cat = await mkCategory("seller");
    await seedQualifying(cat.id, 6, 1000, { quantity: 50 }); // prices 1000..1050
    await runBenchmarks({ trigger: "manual", k: 5 });
    const c = { id: cat.id, name: "Cat" };
    sub.listings = [
      listing({ id: "below", category: c, pricePaise: 500 }),
      listing({ id: "within", category: c, pricePaise: 1020 }),
      listing({ id: "above", category: c, pricePaise: 5000 }),
      listing({ id: "nodata", category: { id: "00000000-0000-4000-8000-000000000000", name: "None" }, pricePaise: 1 }),
      listing({ id: "draft", category: c, status: "draft" }),
      listing({ id: "onrequest", category: c, pricePaise: null }),
    ];
    const r = await getSellerCompetitiveness("biz");
    if (!r.enabled || !r.premium) throw new Error("expected premium");
    const by = Object.fromEntries(r.items.map((i) => [i.listingId, i]));
    expect(Object.keys(by).sort()).toEqual(["above", "below", "nodata", "within"]);
    expect(by.below!.position).toBe("below");
    expect(by.within!.position).toBe("within");
    expect(by.above!.position).toBe("above");
    expect(by.above!.vsMedianBps).toBeGreaterThan(0);
    expect(by.below!.vsMedianBps).toBeLessThan(0);
    expect(by.within!.band).toMatchObject({ unit: "kg", regionLabel: "Maharashtra", rolledUp: false });
    expect(by.within!.trend).toBe("unknown");
    expect(by.nodata).toMatchObject({ position: "no_data", band: null, vsMedianBps: null });
    // no seller location falls back to national
    sub.profile = { state: null, pincode: null };
    const n = await getSellerCompetitiveness("biz");
    if (!n.enabled || !n.premium) throw new Error("expected premium");
    expect(n.items.find((i) => i.listingId === "within")!.band).toMatchObject({ regionLabel: "India" });
    sub.profile = { state: "Maharashtra", pincode: "400001" };
  });
});

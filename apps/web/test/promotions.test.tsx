import { createTranslator } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../messages/en.promotions.json";
import hi from "../messages/hi.promotions.json";

vi.mock("next-intl/server", () => ({
  getTranslations: async ({ locale }: { locale: string }) => createTranslator({ locale, messages: (locale === "hi" ? hi : en) as never, namespace: "promotions" as never }),
}));
vi.mock("@/features/promotions/report-offer", () => ({ ReportOffer: () => null }));

type Json = { [k: string]: Json | string };
const flat = (o: Json, p = ""): Record<string, string> => Object.entries(o).reduce<Record<string, string>>((a, [k, v]) => (typeof v === "string" ? { ...a, [p + k]: v } : { ...a, ...flat(v, `${p}${k}.`) }), {});
const E = flat(en as Json);
const H = flat(hi as Json);
const ph = (m: string) => [...m.matchAll(/\{(\w+)/g)].map((x) => x[1]!).sort().join();

describe("promotions catalogue", () => {
  it("hi has exactly the keys and placeholders of en, and is translated", () => {
    expect(Object.keys(H).sort()).toEqual(Object.keys(E).sort());
    for (const k of Object.keys(E)) expect(ph(H[k]!), k).toBe(ph(E[k]!));
    for (const [k, v] of Object.entries(H)) expect(/[ऀ-ॿ]/.test(v), k).toBe(true);
  });
});

describe("cardOffer", () => {
  it("timed: offer price + struck reference only when the platform derived one", async () => {
    const { cardOffer } = await import("@/features/promotions/card-offer");
    const withRef = await cardOffer({ listingId: "l", tiers: null, freeDelivery: null, timed: { offerId: "o", unitPricePaise: 8000, startsAt: "", endsAt: "", reference: { pricePaise: 10000, percentOff: 20 } } }, "en");
    expect(withRef).toMatchObject({ pricePaise: 8000, chip: { label: "Offer", referencePaise: 10000, percentLabel: "20% below" } });
    const noRef = await cardOffer({ listingId: "l", tiers: null, freeDelivery: null, timed: { offerId: "o", unitPricePaise: 8000, startsAt: "", endsAt: "", reference: null } }, "en");
    expect(noRef!.chip).toMatchObject({ referencePaise: null, percentLabel: null });
    expect((await cardOffer({ listingId: "l", timed: null, freeDelivery: null, tiers: { offerId: "o", endsAt: null, referencePaise: null, tiers: [] } }, "hi"))!.chip.label).toBe("थोक मूल्य");
    expect(await cardOffer({ listingId: "l", timed: null, tiers: null, freeDelivery: null }, "en")).toBeNull();
  });
});

describe("OfferPanel honesty", () => {
  const base = { listingId: "l", tiers: null, freeDelivery: null };
  it("with a reference: strike-through is labelled, dated in absolute terms, no countdown or scarcity copy", async () => {
    const { OfferPanel } = await import("@/features/promotions/offer-panel");
    const html = renderToStaticMarkup(await OfferPanel({ offer: { ...base, timed: { offerId: "o", unitPricePaise: 8000, startsAt: "2026-09-30T00:00:00Z", endsAt: "2026-10-05T12:30:00Z", reference: { pricePaise: 10000, percentOff: 20 } } }, unit: "piece", locale: "en" }));
    expect(html).toContain("<s>");
    expect(html).toContain("Lowest price in the last 30 days");
    expect(html).toContain("20% below the lowest price of the last 30 days");
    expect(html).toContain('<time dateTime="2026-10-05T12:30:00Z">');
    expect(html).not.toMatch(/only \d+ left|hurry|selling fast|countdown|ends in/i);
    expect(html).toMatch(/must honour/);
  });
  it("without a reference: no struck price and no percentage at all", async () => {
    const { OfferPanel } = await import("@/features/promotions/offer-panel");
    const html = renderToStaticMarkup(await OfferPanel({ offer: { ...base, timed: { offerId: "o", unitPricePaise: 8000, startsAt: "2026-09-30T00:00:00Z", endsAt: "2026-10-05T12:30:00Z", reference: null } }, unit: "piece", locale: "en" }));
    expect(html).not.toContain("<s>");
    expect(html).not.toMatch(/%/);
    expect(html).not.toContain("Lowest price in the last 30 days");
  });
  it("tiers render as a real table with headers", async () => {
    const { OfferPanel } = await import("@/features/promotions/offer-panel");
    const html = renderToStaticMarkup(await OfferPanel({ offer: { ...base, timed: null, tiers: { offerId: "o", endsAt: null, referencePaise: null, tiers: [{ minQty: 10, unitPricePaise: 9000, percentOff: null }, { minQty: 100, unitPricePaise: 8000, percentOff: null }] } }, unit: "piece", locale: "en" }));
    expect(html).toContain("<caption");
    expect(html).toContain('scope="col"');
    expect(html).toContain("10+ units");
  });
});

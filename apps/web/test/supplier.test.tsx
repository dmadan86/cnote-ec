import { createTranslator } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { VerificationEvidence } from "@cnote/identity";
import en from "../messages/en.supplier.json";
import hi from "../messages/hi.supplier.json";
import { priceTiersOf } from "@/features/compare/price-tiers";
import { HighlightRegion } from "@/features/compare/highlight-region";
import { evidenceItems, responseText, yearsText } from "@/features/supplier/evidence-items";
import { buildSupplierTrust, formatEvidenceDate, splitDuration } from "@/features/supplier/model";
import { ProfileTabs } from "@/features/supplier/profile-tabs";
import { VerifiedDisclosure } from "@/features/supplier/verified-disclosure";
import { sellerLd } from "@/lib/schema";

const evidence = (over: Partial<VerificationEvidence> = {}): VerificationEvidence => ({
  businessId: "b1", tier: 1, badgeActive: true, memberSince: "2023-06-01T00:00:00.000Z", gstinMasked: "27•••••••••F1Z5",
  checks: [
    { key: "phone", tier: 0, passed: true, at: "2023-06-02T00:00:00.000Z" },
    { key: "gstin", tier: 1, passed: true, at: "2023-07-01T00:00:00.000Z" },
    { key: "gstin_name_match", tier: 1, passed: false, at: null },
    { key: "udyam", tier: 1, passed: false, at: null },
    { key: "documents", tier: 2, passed: false, at: null },
    { key: "audit", tier: 3, passed: false, at: null },
  ],
  ...over,
});
const resp = (over = {}) => ({ sufficient: true, sample: 12, medianFirstResponseMinutes: 95, acceptRate: 0.75, ...over });
const trustOf = (r = resp(), rating?: { count: number; average: number; histogram: [number, number, number, number, number] }) =>
  buildSupplierTrust({ evidence: evidence(), response: r, rating, liveListings: 7, storefrontSlug: null, now: new Date("2026-10-02T00:00:00Z") });
const tr = (locale: "en" | "hi" = "en") => createTranslator({ locale, messages: { supplier: locale === "en" ? en.supplier : hi.supplier }, namespace: "supplier" }) as unknown as (k: string, v?: Record<string, string | number>) => string;

describe("buildSupplierTrust", () => {
  it("shows New supplier (no numbers) below the 5-lead sample even if numbers were passed", () => {
    const t = trustOf(resp({ sufficient: false, sample: 3 }));
    expect(t.response).toMatchObject({ isNew: true, medianFirstResponseMinutes: null, acceptRate: null });
    expect(responseText(t, tr())).toEqual({ time: null, accept: null });
  });
  it("derives years on platform and passed checks from evidence only", () => {
    const t = trustOf();
    expect(t.yearsOnPlatform).toBe(3);
    expect(t.passedChecks.map((c) => c.key)).toEqual(["phone", "gstin"]);
    expect(Object.keys(t).join()).not.toMatch(/plan|payment|subscription|sponsor/i);
  });
  it("has no rating object when there are no approved reviews", () => {
    expect(trustOf().rating).toBeNull();
    expect(trustOf(resp(), { count: 0, average: 0, histogram: [0, 0, 0, 0, 0] }).rating).toBeNull();
    expect(trustOf(resp(), { count: 2, average: 4.5, histogram: [0, 0, 0, 1, 1] }).rating).toMatchObject({ count: 2 });
  });
});

describe("formatting", () => {
  it("splits durations into minutes, hours and days", () => {
    expect(splitDuration(0.2)).toEqual({ unit: "minutes", value: 1 });
    expect(splitDuration(95)).toEqual({ unit: "hours", value: 2 });
    expect(splitDuration(60 * 72)).toEqual({ unit: "days", value: 3 });
  });
  it("renders response text in English and Hindi", () => {
    const t = trustOf();
    expect(responseText(t, tr())).toEqual({ time: "2 hours", accept: "75% accepted" });
    expect(responseText(t, tr("hi")).time).toContain("2");
    expect(yearsText(t, tr())).toBe("3 years");
  });
  it("formats evidence dates in UTC so server and client agree", () => {
    expect(formatEvidenceDate("2023-07-01T23:30:00.000Z", "en-IN")).toContain("2023");
  });
  it("states each check's status in text", () => {
    const items = evidenceItems(trustOf(), tr(), "en-IN");
    expect(items.find((i) => i.key === "gstin")!.status).toMatch(/^Passed /);
    expect(items.find((i) => i.key === "audit")!.status).toBe("Not completed");
  });
});

describe("priceTiersOf", () => {
  it("tolerates listings without tiers", () => {
    expect(priceTiersOf({ id: "x" })).toEqual([]);
    expect(priceTiersOf([{ id: "x" }, null])).toEqual([[], []]);
  });
  it("reads tiers by any known quantity key, sorted", () => {
    expect(priceTiersOf({ priceTiers: [{ minQty: 100, pricePaise: 900 }, { minQuantity: 10, pricePaise: 1000 }, { bad: true }] })).toEqual([
      { qty: 10, pricePaise: 1000 },
      { qty: 100, pricePaise: 900 },
    ]);
  });
});

describe("components (static markup)", () => {
  it("VerifiedDisclosure is a collapsed aria-expanded button controlling a hidden panel with text statuses", () => {
    const html = renderToStaticMarkup(
      <VerifiedDisclosure label="What's verified" summary="2 checks passed" listLabel="Verification checks" items={evidenceItems(trustOf(), tr(), "en-IN")} gstinLine="GSTIN on file: 27•••••••••F1Z5" />,
    );
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="/);
    expect(html).toContain("hidden");
    expect(html).toContain("Not completed");
    expect(html).toContain("27•••••••••F1Z5");
  });
  it("ProfileTabs renders the ARIA tabs pattern with one selected tab and every panel in the DOM", () => {
    const html = renderToStaticMarkup(
      <ProfileTabs label="Supplier sections" tabs={[{ id: "about", label: "About", panel: <p>A</p> }, { id: "products", label: "Products", panel: <p>P</p> }]} />,
    );
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('aria-selected="true"');
    expect(html.match(/role="tabpanel"/g)).toHaveLength(2);
    expect(html).toContain("<p>P</p>");
    expect(html).toMatch(/tabindex="-1"/);
  });
  it("HighlightRegion exposes a labelled switch, on by default", () => {
    const html = renderToStaticMarkup(<HighlightRegion label="Highlight differences"><table /></HighlightRegion>);
    expect(html).toContain('role="switch"');
    expect(html).toContain("Highlight differences");
    expect(html).toContain('data-highlight="true"');
  });
});

describe("sellerLd", () => {
  const seller = { businessId: "b1", name: "Acme", city: "Pune", state: "Maharashtra", pincode: null, verificationTier: 1, trustScore: 70, badgeActive: true, languages: ["en"] };
  it("emits aggregateRating only with real reviews", () => {
    expect(JSON.stringify(sellerLd(seller, "en", null))).not.toContain("aggregateRating");
    expect(JSON.stringify(sellerLd(seller, "en", { average: 0, count: 0 }))).not.toContain("aggregateRating");
    expect(JSON.stringify(sellerLd(seller, "en", { average: 4.5, count: 3 }))).toContain('"reviewCount":3');
  });
});

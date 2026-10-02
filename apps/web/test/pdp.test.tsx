import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { activeSlabIndex, buildSlabs, estimateTotalPaise, formatPaise, parseQty, unitPriceFor } from "@/features/pdp/tiers";
import { clampPan, clampScale, nextIndex, pinchScale } from "@/features/pdp/zoom";
import { withRfqPrefill } from "@/features/pdp/prefill";
import { mailHref, whatsappHref } from "@/features/pdp/share-menu";
import { tradeRows } from "@/features/pdp/trade-info";
import { rfqUnit } from "@/features/enquiry/rfq-form";

// The unlock island needs the session/OTP client stack; here it is just a labelled button.
vi.mock("@/features/leadgen/unlock-buttons", () => ({
  UnlockButton: ({ label, prefill }: { label: string; prefill?: { quantity?: number | null } }) => <button type="button" data-qty={prefill?.quantity ?? ""}>{label}</button>,
}));
const { PurchasePanel } = await import("@/features/pdp/purchase-panel");
const { Gallery } = await import("@/features/pdp/gallery");

const en = JSON.parse(readFileSync(join(__dirname, "..", "messages", "en.pdp.json"), "utf8"));
const wrap = (node: React.ReactNode) => renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={en}>{node}</NextIntlClientProvider>);

const TIERS = [
  { minQty: 100, pricePaise: 1000 },
  { minQty: 500, pricePaise: 950 },
  { minQty: 2000, pricePaise: 899 },
];

describe("slabs", () => {
  it("adds the base-price row when the first slab starts above the MOQ", () => {
    expect(buildSlabs(TIERS, 1100, 50)).toEqual([
      { from: 50, to: 99, pricePaise: 1100 },
      { from: 100, to: 499, pricePaise: 1000 },
      { from: 500, to: 1999, pricePaise: 950 },
      { from: 2000, to: null, pricePaise: 899 },
    ]);
  });
  it("starts at the first slab when it equals the MOQ; empty without tiers", () => {
    expect(buildSlabs(TIERS, 1100, 100).map((s) => s.from)).toEqual([100, 500, 2000]);
    expect(buildSlabs([], 1100, 100)).toEqual([]);
    expect(buildSlabs(undefined, null, null)).toEqual([]);
  });
  it("selects the slab at the boundaries", () => {
    const slabs = buildSlabs(TIERS, 1100, 50);
    const at = (q: number) => unitPriceFor(slabs, 1100, q);
    expect([49, 50, 99, 100, 499, 500, 1999, 2000, 1_000_000].map(at)).toEqual([1100, 1100, 1100, 1000, 1000, 950, 950, 899, 899]);
    expect([50, 100, 500, 2000].map((q) => activeSlabIndex(slabs, q))).toEqual([0, 1, 2, 3]);
    expect(activeSlabIndex([], 5)).toBe(-1);
    expect(unitPriceFor([], 1234, 5)).toBe(1234);
    expect(unitPriceFor([], null, 5)).toBeNull();
  });
  it("totals are exact integer paise (no float drift) and null when unsafe or invalid", () => {
    expect(estimateTotalPaise(1999, 3)).toBe(5997);
    expect(estimateTotalPaise(899, 2000)).toBe(1_798_000);
    expect(estimateTotalPaise(Number.MAX_SAFE_INTEGER, 2)).toBeNull();
    expect(estimateTotalPaise(null, 5)).toBeNull();
    expect(estimateTotalPaise(100, 0)).toBeNull();
    expect(estimateTotalPaise(100, 1.5)).toBeNull();
  });
  it("parses quantities strictly", () => {
    expect([parseQty("250"), parseQty(" 1,200 "), parseQty("0"), parseQty("2.5"), parseQty("abc"), parseQty(""), parseQty("3000000000"), parseQty("-4")]).toEqual([250, 1200, null, null, null, null, null, null]);
  });
  it("formats paise at the display edge", () => {
    expect(formatPaise(899)).toBe("₹8.99");
    expect(formatPaise(150000)).toBe("₹1,500");
    expect(formatPaise(1_798_000)).toBe("₹17,980");
  });
});

describe("zoom maths", () => {
  it("clamps scale 1..4 and pan to the covered area", () => {
    expect([clampScale(0.2), clampScale(2.5), clampScale(9)]).toEqual([1, 2.5, 4]);
    expect(clampPan(500, -500, 2, 400, 300)).toEqual({ x: 200, y: -150 });
    expect(clampPan(10, 10, 1, 400, 300)).toEqual({ x: 0, y: 0 });
  });
  it("pinch scales by the finger distance ratio", () => {
    expect(pinchScale(1, 100, 250)).toBe(2.5);
    expect(pinchScale(2, 100, 10)).toBe(1);
    expect(pinchScale(1.5, 0, 50)).toBe(1.5);
  });
  it("prev/next wrap around", () => {
    expect([nextIndex(0, -1, 5), nextIndex(4, 1, 5), nextIndex(2, 1, 5), nextIndex(0, 1, 0)]).toEqual([4, 0, 3, 0]);
  });
});

describe("RFQ prefill", () => {
  it("adds qty, unit and slab price to the RFQ link only", () => {
    expect(withRfqPrefill("/rfq/new?listing=abc", { quantity: 250, unit: "pcs", pricePaise: 1000 })).toBe("/rfq/new?listing=abc&qty=250&unit=pcs&price=1000");
    expect(withRfqPrefill("/rfq/new", { quantity: 5 })).toBe("/rfq/new?qty=5");
    expect(withRfqPrefill("/buyer/enquiries/1", { quantity: 250 })).toBe("/buyer/enquiries/1");
    expect(withRfqPrefill("/rfq/new?listing=abc", { quantity: null })).toBe("/rfq/new?listing=abc");
  });
  it("maps listing units onto the RFQ unit list", () => {
    expect([rfqUnit("piece"), rfqUnit("meters"), rfqUnit("kg"), rfqUnit("pallets"), rfqUnit(undefined)]).toEqual(["pcs", "meter", "kg", "pcs", "pcs"]);
  });
});

describe("share links", () => {
  it("encode the text and canonical url", () => {
    const url = "https://example.test/p/box-1?a=b&c=d";
    expect(whatsappHref("Look at this", url)).toBe(`https://wa.me/?text=${encodeURIComponent(`Look at this ${url}`)}`);
    expect(mailHref("A & B", `x\n${url}`)).toBe(`mailto:?subject=${encodeURIComponent("A & B")}&body=${encodeURIComponent(`x\n${url}`)}`);
  });
});

describe("trade rows", () => {
  const base = { priceUnit: "piece", moq: 500, moqUnit: "pcs", hsn: "4819" };
  it("renders only what exists", () => {
    expect(tradeRows({ ...base, trade: {} }).map((r) => r.key)).toEqual(["unitSold", "moq", "hsn"]);
    expect(tradeRows({ priceUnit: null, moq: null, moqUnit: null, hsn: null, trade: undefined })).toEqual([]);
  });
  it("adds the optional seller facts in a stable order", () => {
    const rows = tradeRows({ ...base, trade: { leadTimeDays: 0, packaging: "Cartons", sampleAvailable: true, samplePricePaise: 0, supplyCapacityPerMonth: 5000, paymentTerms: "Net 30", certifications: ["BIS"] } });
    expect(rows.map((r) => r.key)).toEqual(["unitSold", "moq", "hsn", "leadTime", "packaging", "sample", "capacity", "paymentTerms", "certifications"]);
    expect(rows.find((r) => r.key === "sample")?.value).toBe("free");
  });
});

describe("PurchasePanel (server render = the buyer's first paint)", () => {
  const props = {
    listingId: "00000000-0000-4000-8000-000000000001",
    listingTitle: "Printed boxes",
    unit: "piece",
    basePaise: 1100,
    tiers: TIERS,
    moq: 100,
    moqText: "100 pcs",
    moqUnit: "pcs",
    labels: { priceOnRequest: "Price on request", minOrder: "Min. order 100 pcs", indicative: "Indicative price", getBestPrice: "Get best price", requestQuote: "Request quote" },
  };
  it("defaults the quantity to the MOQ, highlights that slab and shows the estimate labelled excl. GST", () => {
    const h = wrap(<PurchasePanel {...props} />);
    expect(h).toMatch(/data-testid="pdp-qty"[^>]*value="100"|value="100"[^>]*data-testid="pdp-qty"/);
    expect(h.match(/data-active="true"/g)).toHaveLength(1);
    expect(h).toContain("Your tier");
    expect(h).toContain("₹1,000"); // 100 units x 1000 paise (Rs 10) = Rs 1,000
    expect(h).toContain("Estimate, excl. GST");
    expect(h).toContain("100–499 pcs");
    expect(h).toContain("2,000+ pcs");
    expect(h).toContain('data-qty="100"'); // the quote button carries the quantity to the RFQ
  });
  it("without tiers shows no slab table but still an estimate for a priced listing", () => {
    const h = wrap(<PurchasePanel {...props} tiers={[]} />);
    expect(h).not.toContain("pdp-slabs");
    expect(h).toContain("₹1,100");
  });
  it("price on request has no quantity box", () => {
    const h = wrap(<PurchasePanel {...props} tiers={[]} basePaise={null} />);
    expect(h).toContain("Price on request");
    expect(h).not.toContain("pdp-qty");
  });
});

describe("Gallery", () => {
  const images = [1, 2, 3].map((n) => ({ src: `/media/listing-images/${n}`, blur: null, alt: n === 1 ? "Printed boxes" : `Printed boxes, image ${n}` }));
  it("opens the viewer from a labelled button, lists thumbnails as buttons and keeps the closed dialog empty", () => {
    const h = wrap(<Gallery images={images} title="Printed boxes" />);
    expect(h).toContain('aria-label="View image 1 of 3 full screen"');
    expect(h).toContain('aria-haspopup="dialog"');
    expect(h.match(/aria-label="Show image \d"/g)).toHaveLength(3);
    expect(h).toContain("<dialog");
    expect(h).not.toContain("Next image"); // viewer content mounts only when opened
    expect(h).toContain('alt="Printed boxes"');
  });
  it("a single image has no thumbnail strip", () => {
    const h = wrap(<Gallery images={images.slice(0, 1)} title="Printed boxes" />);
    expect(h).not.toContain("Show image");
  });
});

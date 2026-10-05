import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComparisonRow, QuoteComparison } from "@cnote/enquiry";
import type { QuoteLandedRow } from "@cnote/logistics";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import enBuyer from "../messages/en.buyer.json";
import enRfq2 from "../messages/en.rfq2.json";
import enFreight from "../messages/en.freight.json";
import hiFreight from "../messages/hi.freight.json";

vi.mock("@/features/enquiry/actions", () => ({ quoteDecisionAction: async () => null, shortlistQuoteAction: async () => null, postRfqAction: async () => null }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const estimateForListing = vi.hoisted(() => vi.fn());
const limited = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@cnote/logistics", () => ({ estimateForListing }));
vi.mock("@/features/search/api-guard", async () => {
  const { NextResponse } = await import("next/server");
  return { limited, fail: (status: number, code: string) => NextResponse.json({ error: code }, { status }) };
});

const { FreightEstimate } = await import("@/features/pdp/freight-estimate");
const { QuoteCompare } = await import("@/features/enquiry/quote-compare");
const { GET } = await import("@/app/api/freight/estimate/route");

const wrap = (node: React.ReactNode, locale = "en") =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="Asia/Kolkata" messages={{ ...en, ...enBuyer, ...enRfq2, ...(locale === "hi" ? hiFreight : enFreight) } as never}>{node}</NextIntlClientProvider>,
  );

describe("PDP freight panel", () => {
  it("renders a labelled form and the always-visible estimate disclaimer (en and hi)", () => {
    const html = wrap(<FreightEstimate listingId="11111111-1111-4111-8111-111111111111" unit="piece" moq={50} />);
    expect(html).toContain("Estimate freight");
    expect(html).toContain("Delivery PIN code");
    expect(html).toContain("Quantity (piece)");
    expect(html).toContain('value="50"');
    expect(html).toContain("This is an estimate only. The final freight is quoted by the seller.");
    expect(html).toMatch(/<label[^>]*for="[^"]+-pin"/);
    expect(html).toContain('aria-live="polite"');
    const hi = wrap(<FreightEstimate listingId="11111111-1111-4111-8111-111111111111" unit="piece" moq={null} />, "hi");
    expect(hi).toContain("यह केवल अनुमान है। अंतिम भाड़ा विक्रेता बताएगा।");
  });
});

const row = (id: string, o: Partial<ComparisonRow["quote"]> = {}): ComparisonRow => ({
  matchId: id, conversationId: `c-${id}`, sellerBusinessId: `s-${id}`, sellerName: `Supplier ${id}`, verificationTier: 1, badgeActive: true, trustScore: 60, rank: 1, of: 3,
  totalPaise: 100000, quantityBasis: "requested", quantity: 200, decision: null, earlierQuotes: 0,
  quote: { id: `q-${id}`, pricePaise: 500, quantity: 200, unit: "pcs", leadTimeDays: 10, notes: null, validUntil: "2026-12-01", createdAt: "2026-10-01T00:00:00.000Z", moq: null, moqUnit: null, deliveryTerms: null, deliveryNote: null, deliveryChargePaise: null, paymentTerms: null, paymentNote: null, gstIncluded: null, attachments: [], shortlisted: false, ...o },
});
const comparison = (rows: ComparisonRow[]): QuoteComparison => ({ enquiryId: "e1", quantity: 200, quantityUnit: "pcs", sentTo: 2, quotesFrom: rows.length, expiresAt: null, rows });
const landed = (o: Partial<QuoteLandedRow>): QuoteLandedRow => ({ key: "a", lowPaise: 112000, highPaise: 124000, freightSource: "estimated", goodsGstPaise: 0, goodsGstAssumed: false, gstUnknown: true, complete: true, estimate: { lowPaise: 10000, highPaise: 20000, mode: "parcel", transitDays: { min: 2, max: 4 }, assumptions: [] }, ...o });

describe("quote compare: landed cost", () => {
  it("shows a landed column with the reason for each assumption in words", () => {
    const html = wrap(<QuoteCompare comparison={comparison([row("a"), row("b")])} landed={{ a: landed({}), b: landed({ freightSource: "quoted", estimate: null, lowPaise: 107000, highPaise: 107000, goodsGstAssumed: true, gstUnknown: false }) }} />);
    expect(html).toContain("Landed cost (est.)");
    expect(html).toContain("₹1,120 to ₹1,240");
    expect(html).toContain("Includes estimated freight of ₹100 to ₹200, because the seller has not stated a charge.");
    expect(html).toContain("GST not stated by the seller, so not added.");
    expect(html).toContain("Includes the seller&#x27;s stated delivery charge.");
    expect(html).toContain("assumed 18%");
    expect(html).toContain("The final freight is quoted by the seller.");
  });
  it("renders no landed column when not computed", () => {
    expect(wrap(<QuoteCompare comparison={comparison([row("a")])} />)).not.toContain("Landed cost (est.)");
  });
});

describe("GET /api/freight/estimate", () => {
  const url = (q: string) => ({ nextUrl: new URL(`http://x/api/freight/estimate?${q}`), headers: new Headers() }) as never;
  const id = "11111111-1111-4111-8111-111111111111";
  beforeEach(() => {
    estimateForListing.mockReset();
    limited.mockReset();
    limited.mockResolvedValue(null);
  });
  it("validates input before touching the estimator", async () => {
    expect((await GET(url("listingId=bad&quantity=1&pincode=400001"))).status).toBe(404);
    expect((await GET(url(`listingId=${id}&quantity=1&pincode=12`))).status).toBe(400);
    expect((await GET(url(`listingId=${id}&quantity=0&pincode=400001`))).status).toBe(400);
    expect((await GET(url(`listingId=${id}&quantity=1.5&pincode=400001`))).status).toBe(400);
    expect(estimateForListing).not.toHaveBeenCalled();
  });
  it("returns the estimate privately (no shared caching) and maps errors", async () => {
    estimateForListing.mockResolvedValue({ listingId: id, quantity: 5 });
    const ok = await GET(url(`listingId=${id}&quantity=5&pincode=400001`));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toMatch(/^private/);
    expect(estimateForListing).toHaveBeenCalledWith(id, 5, "400001");
    const { DomainError } = await import("@cnote/core");
    estimateForListing.mockRejectedValue(new DomainError("not_found", "Listing not found"));
    expect((await GET(url(`listingId=${id}&quantity=5&pincode=400001`))).status).toBe(404);
    estimateForListing.mockRejectedValue(new Error("boom"));
    expect((await GET(url(`listingId=${id}&quantity=5&pincode=400001`))).status).toBe(503);
  });
  it("is rate limited before any work", async () => {
    const { NextResponse } = await import("next/server");
    limited.mockResolvedValue(NextResponse.json({ error: "rate_limited" }, { status: 429 }) as never);
    expect((await GET(url(`listingId=${id}&quantity=5&pincode=400001`))).status).toBe(429);
    expect(estimateForListing).not.toHaveBeenCalled();
  });
});

describe("freight catalogues", () => {
  it("web en and hi mirror each other", () => {
    expect(Object.keys((hiFreight as { freight: object }).freight).sort()).toEqual(Object.keys((enFreight as { freight: object }).freight).sort());
    void readFileSync;
    void join;
  });
});

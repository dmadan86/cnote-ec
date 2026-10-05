import type { ComparisonRow, QuoteComparison } from "@cnote/enquiry";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import enBuyer from "../messages/en.buyer.json";
import enRfq2 from "../messages/en.rfq2.json";
import hiRfq2 from "../messages/hi.rfq2.json";

vi.mock("@/features/enquiry/actions", () => ({
  quoteDecisionAction: async () => null,
  shortlistQuoteAction: async () => null,
  postRfqAction: async () => null,
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const { QuoteCompare } = await import("@/features/enquiry/quote-compare");
const { RfqForm, validateFiles, MAX_FILES } = await import("@/features/enquiry/rfq-form");
const { bestByColumn, sortRows, SORT_KEYS } = await import("@/features/enquiry/compare-logic");
const { remaining } = await import("@/features/enquiry/expiry");

const row = (o: Partial<ComparisonRow> & { id: string }): ComparisonRow => ({
  matchId: o.id,
  conversationId: `c-${o.id}`,
  sellerBusinessId: `s-${o.id}`,
  sellerName: `Supplier ${o.id}`,
  verificationTier: 1,
  badgeActive: true,
  trustScore: 60,
  rank: 1,
  of: 3,
  totalPaise: 100000,
  quantityBasis: "requested",
  quantity: 200,
  decision: null,
  earlierQuotes: 0,
  approval: null,
  quote: {
    id: `q-${o.id}`, pricePaise: 500, quantity: 200, unit: "pcs", leadTimeDays: 10, notes: null, validUntil: "2026-12-01", createdAt: "2026-10-01T00:00:00.000Z",
    moq: null, moqUnit: null, deliveryTerms: null, deliveryNote: null, deliveryChargePaise: null, paymentTerms: "net_15", paymentNote: null, gstIncluded: null,
    attachments: [], shortlisted: false, lineTotals: null,
  },
  coverage: null,
  ...o,
});

const A = row({ id: "a", rank: 1, verificationTier: 2, totalPaise: 120000, quote: { ...row({ id: "a" }).quote, pricePaise: 600, leadTimeDays: 14, shortlisted: true, attachments: [{ id: "att-1", fileName: "quote.pdf", mimeType: "application/pdf", sizeBytes: 10 }], notes: "Includes tooling" } });
const B = row({ id: "b", rank: 2, verificationTier: 1, totalPaise: 90000, quote: { ...row({ id: "b" }).quote, pricePaise: 450, leadTimeDays: 7, paymentTerms: "advance" } });
const C = row({ id: "c", rank: 3, verificationTier: 1, totalPaise: 90000, decision: "won", quote: { ...row({ id: "c" }).quote, pricePaise: 450, leadTimeDays: null, paymentTerms: null } });

const comparison = (rows: ComparisonRow[], o: Partial<QuoteComparison> = {}): QuoteComparison => ({
  enquiryId: "e1", quantity: 200, quantityUnit: "pcs", sentTo: 3, quotesFrom: rows.length, expiresAt: "2026-10-09T00:00:00.000Z", rows, lines: [], lowestByLine: {}, awards: [], ...o,
});

function render(ui: React.ReactElement, locale = "en") {
  const messages = locale === "hi" ? { ...en, ...enBuyer, ...hiRfq2 } : { ...en, ...enBuyer, ...enRfq2 };
  return renderToStaticMarkup(<NextIntlClientProvider locale={locale} timeZone="Asia/Kolkata" messages={messages as never}>{ui}</NextIntlClientProvider>);
}

describe("compare logic", () => {
  it("sorts by each key with rank as the stable tiebreak, and puts a missing lead time last", () => {
    const rows = [A, B, C];
    expect(sortRows(rows, "rank").map((r) => r.matchId)).toEqual(["a", "b", "c"]);
    expect(sortRows(rows, "price").map((r) => r.matchId)).toEqual(["b", "c", "a"]);
    expect(sortRows(rows, "total").map((r) => r.matchId)).toEqual(["b", "c", "a"]);
    expect(sortRows(rows, "leadTime").map((r) => r.matchId)).toEqual(["b", "a", "c"]);
    expect(sortRows(rows, "tier").map((r) => r.matchId)).toEqual(["a", "b", "c"]);
    expect(rows.map((r) => r.matchId)).toEqual(["a", "b", "c"]); // input untouched
    expect(SORT_KEYS).toHaveLength(5);
  });
  it("marks the best per column, counts ties, and skips columns with nothing to prefer", () => {
    const best = bestByColumn([A, B, C]);
    expect([...best.price].sort()).toEqual(["b", "c"]);
    expect([...best.total].sort()).toEqual(["b", "c"]);
    expect([...best.leadTime]).toEqual(["b"]);
    expect([...best.tier]).toEqual(["a"]);
    expect([...best.rank]).toEqual(["a"]);
    const same = bestByColumn([row({ id: "x", rank: 1 }), row({ id: "y", rank: 2 })]);
    expect(same.price.size).toBe(0);
    expect(same.tier.size).toBe(0);
    expect(bestByColumn([A]).price.size).toBe(0);
    expect(bestByColumn([]).rank.size).toBe(0);
  });
});

describe("expiry countdown maths", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  it("picks days+hours, hours+minutes or minutes, and null once passed", () => {
    expect(remaining("2026-10-04T05:30:00Z", now)).toEqual({ key: "timeDaysHours", params: { days: 3, hours: 5 } });
    expect(remaining("2026-10-01T03:20:00Z", now)).toEqual({ key: "timeHoursMinutes", params: { hours: 3, minutes: 20 } });
    expect(remaining("2026-10-01T00:00:20Z", now)).toEqual({ key: "timeMinutes", params: { minutes: 1 } });
    expect(remaining("2026-10-01T00:00:00Z", now)).toBeNull();
    expect(remaining("2026-09-30T00:00:00Z", now)).toBeNull();
  });
});

describe("QuoteCompare", () => {
  const html = render(<QuoteCompare comparison={comparison([A, B, C])} />);

  it("shows the ADR-002 transparency line and a table with one row per supplier", () => {
    expect(html).toContain("Sent to 3 suppliers; you are seeing quotes from 3.");
    expect(html).toMatch(/<table/);
    expect(html).toMatch(/<caption class="sr-only">Quotes received for this requirement/);
    expect((html.match(/data-testid="quote-row"/g) ?? []).length).toBe(3);
    for (const h of ["Supplier", "Verification", "Rank", "Unit price", "Total for 200 pcs", "Lead time", "Valid until", "Payment terms", "Attachments", "Notes", "Actions"]) {
      expect(html).toContain(`>${h}</th>`);
    }
    expect(html).toContain('scope="row"');
  });

  it("marks best values with the word Best and a screen-reader column name, not colour alone", () => {
    expect(html).toMatch(/Best<span class="sr-only"> \(Best Unit price\)<\/span>/);
    expect(html).toContain("(Best Lead time)");
    expect(html).toContain("Best marks the strongest value in each column.");
  });

  it("renders amounts, terms, attachments, notes and the shortlist state", () => {
    expect(html).toContain(">₹6<");
    expect(html).toContain("₹1,200"); // total
    expect(html).toContain("14 days");
    expect(html).toContain("Net 15 days");
    expect(html).toContain("Advance payment");
    expect(html).toContain('href="/api/rfq-attachments/att-1"');
    expect(html).toContain("Includes tooling");
    expect(html).toContain("Shortlisted");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Accepted"); // C was accepted: no accept button for it
    expect((html.match(/aria-label="Accept quote from Supplier/g) ?? []).length).toBe(4);
    expect(html).toContain('aria-label="Message Supplier a"');
    expect(html).toContain('href="/conversations/c-a"');
  });

  it("renders a swipeable card strip for mobile with every quote", () => {
    expect((html.match(/data-testid="quote-card"/g) ?? []).length).toBe(3);
    expect(html).toContain("snap-x");
    expect(html).toContain("Swipe sideways");
    expect(html).toContain("Quote 2 of 3");
    expect(html).toContain("Next quote");
  });

  it("controls: sort select, shortlisted-only checkbox, live region", () => {
    expect(html).toContain("Sort quotes by");
    for (const label of ["Supplier rank", "Lowest unit price", "Lowest total", "Fastest lead time", "Highest verification"]) expect(html).toContain(label);
    expect(html).toContain("Show shortlisted only");
    expect(html).toMatch(/role="status" class="sr-only">Sorted by Supplier rank/);
  });

  it("is honest when nobody has quoted yet, with and without a deadline", () => {
    const none = render(<QuoteCompare comparison={comparison([], { sentTo: 3, quotesFrom: 0 })} />);
    expect(none).toContain("Sent to 3 suppliers; you are seeing quotes from 0.");
    expect(none).toContain("No quotes yet. Suppliers can respond until");
    expect(none).not.toContain("<table");
    expect(render(<QuoteCompare comparison={comparison([], { quotesFrom: 0, expiresAt: null })} />)).toContain("Suppliers usually reply within a day.");
    expect(render(<QuoteCompare comparison={comparison([B], { sentTo: 1 })} />)).toContain("Sent to 1 supplier; you are seeing quotes from 1.");
  });

  it("uses the quoted quantity heading when the buyer gave no quantity, and shows delivery charge, MOQ and GST", () => {
    const q = row({ id: "z", quantityBasis: "quoted", quantity: 7, quote: { ...B.quote, deliveryChargePaise: 15000, moq: 5, moqUnit: "pcs", gstIncluded: true, attachments: [], shortlisted: false }, earlierQuotes: 2 });
    const h = render(<QuoteCompare comparison={comparison([q], { quantity: null, quantityUnit: null })} />);
    expect(h).toContain("(quoted quantity)");
    expect(h).toContain("plus delivery ₹150");
    expect(h).toContain("Minimum order 5 pcs");
    expect(h).toContain("GST included");
    expect(h).toContain("Replaced 2 earlier quotes");
  });

  it("renders in Hindi", () => {
    const hi = render(<QuoteCompare comparison={comparison([A, B])} />, "hi");
    expect(hi).toMatch(/[ऀ-ॿ]/);
    expect(hi).not.toContain("rfq2.compare");
  });
});

describe("RfqForm optional fields", () => {
  const form = render(<RfqForm categories={[{ slug: "x", name: "X" }]} />);
  it("adds budget, expiry (default 7 days), tier floor and a described file input", () => {
    expect(form).toContain('name="budgetMin"');
    expect(form).toContain('name="budgetMax"');
    expect(form).toMatch(/<select[^>]*name="expiresInDays"[^>]*>/);
    expect(form).toContain("7 days");
    expect(form).toMatch(/<option[^>]*value="7"[^>]*selected|selected=""[^>]*value="7"|value="7"/);
    expect(form).toContain('name="minSellerTier"');
    expect(form).toContain("GST verified or higher");
    expect(form).toMatch(/<input[^>]*id="attachments"[^>]*type="file"|<input[^>]*type="file"[^>]*id="attachments"/);
    expect(form).toContain("multiple");
    expect(form).toContain("accept=\".pdf,.jpg,.jpeg,.png");
    expect(form).toContain("Up to 5 files, PDF, JPG or PNG, 10 MB each.");
    expect(form).toContain("aria-describedby=\"attachments-hint\"");
    expect(form).toContain("<fieldset");
    expect(form).toContain("<legend");
    expect(form).toContain("Filled in from your Deliver to location");
  });
  it("validates picked files like the server does", () => {
    const ok = { name: "a.pdf", type: "application/pdf", size: 1000 };
    expect(validateFiles([ok])).toBeNull();
    expect(validateFiles(Array.from({ length: MAX_FILES + 1 }, () => ok))).toEqual({ key: "errTooMany" });
    expect(validateFiles([{ ...ok, name: "x.exe", type: "application/x-msdownload" }])).toEqual({ key: "errType", name: "x.exe" });
    expect(validateFiles([{ ...ok, size: 10 * 1024 * 1024 + 1 }])).toEqual({ key: "errSize", name: "a.pdf" });
    expect(validateFiles([{ ...ok, size: 10 * 1024 * 1024 }, { name: "p.png", type: "image/png", size: 5 }, { name: "j.jpg", type: "image/jpeg", size: 5 }])).toBeNull();
  });
});

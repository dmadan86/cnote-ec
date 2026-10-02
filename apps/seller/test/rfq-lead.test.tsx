import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LeadView } from "@cnote/enquiry";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LOCALES } from "../src/i18n/config";

vi.mock("../src/features/leads/actions", () => ({ acceptLeadAction: async () => null, declineLeadAction: async () => null, reportBuyerProblemAction: async () => null }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const { LeadCard } = await import("../src/features/leads/lead-card");

type Json = { [k: string]: Json | string };
const ROOT = join(__dirname, "..");
const read = (f: string): Json => JSON.parse(readFileSync(join(ROOT, "messages", f), "utf8")) as Json;
const en = { ...read("en.json"), ...read("en.leads.json"), ...read("en.rfqLead.json") };

const lead = (e: Partial<LeadView["enquiry"]> = {}): LeadView => ({
  matchId: "m1",
  enquiry: {
    id: "e1", title: "CNC brackets", requirement: "200 brackets", category: null, quantity: 200, quantityUnit: "pcs", targetPricePaise: 45000,
    deliveryCity: "Pune", deliveryPincode: "411001", neededBy: "2026-11-01", intentScore: 80, intentReasons: [], status: "matched", createdAt: "2026-10-01T00:00:00Z",
    budgetMinPaise: 40000, budgetMaxPaise: 52000, expiresAt: new Date(Date.now() + 5 * 864e5).toISOString(), minSellerTier: 2,
    attachments: [{ id: "att-1", fileName: "bracket.pdf", mimeType: "application/pdf", sizeBytes: 100 }, { id: "att-2", fileName: "photo.png", mimeType: "image/png", sizeBytes: 100 }],
    ...e,
  },
  rank: 1, of: 3, status: "offered", respondBy: new Date(Date.now() + 3600_000).toISOString(),
  buyer: { businessName: "Hidden until you accept", city: null, verificationTier: 1, phone: null }, conversationId: null,
});

const render = (l: LeadView) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="Asia/Kolkata" messages={en as never}>
      <LeadCard lead={l} balance={5} />
    </NextIntlClientProvider>,
  );

describe("seller lead card shows the RFQ fields", () => {
  it("target price, budget, pincode, deadline, tier floor and attachment links", () => {
    const html = render(lead());
    expect(html).toContain('data-testid="rfq-details"');
    expect(html).toContain("Target price per unit");
    expect(html).toContain("₹450");
    expect(html).toContain("₹400 – ₹520");
    expect(html).toContain("411001");
    expect(html).toContain("Quote deadline");
    expect(html).toContain("Tier 2 or higher");
    expect(html).toContain('href="/api/rfq-attachments/att-1"');
    expect(html).toContain("Download bracket.pdf");
    expect(html).toContain("Download photo.png");
    // the intent score, N and rank stay visible alongside (ADR-002)
    expect(html).toContain("Rank 1 of 3");
  });
  it("says so when the deadline has passed and omits the block when nothing was given", () => {
    expect(render(lead({ expiresAt: new Date(Date.now() - 5 * 60_000).toISOString() }))).toContain("Deadline passed");
    const bare = render(lead({ targetPricePaise: null, budgetMinPaise: null, budgetMaxPaise: null, deliveryPincode: null, expiresAt: null, minSellerTier: null, attachments: [] }));
    expect(bare).not.toContain('data-testid="rfq-details"');
    expect(bare).not.toContain("rfq-attachments");
  });
  it("shows a one-sided budget", () => {
    expect(render(lead({ budgetMinPaise: null }))).toContain("₹520");
  });
});

describe("rfqLead catalogue", () => {
  const keys = Object.keys((en.rfqLead as Json)).filter((k) => !k.startsWith("_")).sort();
  it("exists in all 8 locales with the same keys and placeholders", () => {
    for (const l of LOCALES) {
      const f = read(`${l}.rfqLead.json`).rfqLead as Json;
      expect(Object.keys(f).filter((k) => !k.startsWith("_")).sort(), l).toEqual(keys);
      for (const k of keys) {
        const v = f[k] as string;
        expect(v.trim().length, `${l} ${k}`).toBeGreaterThan(0);
        const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(ph(v), `${l} ${k}`).toEqual(ph((en.rfqLead as Json)[k] as string));
      }
    }
  });
});

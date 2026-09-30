import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ALL_LOCALES as LOCALES, LOCALE_META, type Locale } from "@/i18n/config";
import { loadMessages, pickClientMessages, APP_CLIENT_NAMESPACES } from "@/i18n/messages";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }), usePathname: () => "/buyer/enquiries" }));
vi.mock("@/features/enquiry/actions", () => ({ reportDealAction: async () => null, sendMessageAction: async () => null, pickSellersAction: async () => null, postRfqAction: async () => null }));

const { EnquiryStatusBadge, MatchStatusBadge } = await import("@/features/enquiry/status");
const { OrderStatusBadge } = await import("@/features/orders/status");
const { QuoteCard } = await import("@/features/enquiry/conversation");
const { IntentScore } = await import("@/features/enquiry/intent-score");
const { DealReport } = await import("@/features/enquiry/deal-report");

async function render(locale: Locale, node: React.ReactNode) {
  const messages = pickClientMessages(await loadMessages(locale), APP_CLIENT_NAMESPACES);
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages as never} timeZone="Asia/Kolkata">
      {node}
    </NextIntlClientProvider>,
  );
}

const quote = { id: "q1", createdAt: "2026-09-30T05:00:00.000Z", pricePaise: 12500, unit: "pcs", quantity: 100, leadTimeDays: 5, validUntil: null, moq: null, moqUnit: null, deliveryTerms: "door_delivery", deliveryNote: null, deliveryChargePaise: 0, paymentTerms: "net_30", paymentNote: null, gstIncluded: true, notes: null } as never;

describe("buyer components render from the locale's catalogue", () => {
  it("English keeps today's wording", async () => {
    expect(await render("en", <EnquiryStatusBadge enquiry={{ status: "matched", awaitingPick: false }} />)).toContain(">Matched<");
    expect(await render("en", <OrderStatusBadge status="recorded" />)).toContain("Awaiting confirmation");
    const q = await render("en", <QuoteCard quote={quote} from="Acme" at="2026-09-30T05:00:00.000Z" />);
    expect(q).toContain("Quote from Acme");
    expect(q).toContain("Door delivery");
    expect(q).toContain("Net 30 days");
    expect(q).toContain("5 days");
    expect(await render("en", <IntentScore score={82} />)).toContain("Intent 82");
  });

  it.each(LOCALES.filter((l) => l !== "en"))("%s: badges, quote card and deal report are translated with Latin digits", async (locale) => {
    const en = await render("en", <QuoteCard quote={quote} from="Acme" at="2026-09-30T05:00:00.000Z" />);
    const out = await render(locale, <QuoteCard quote={quote} from="Acme" at="2026-09-30T05:00:00.000Z" />);
    expect(out).not.toBe(en);
    expect(out).not.toContain("Quote from");
    expect(out).not.toContain("Door delivery");
    expect(out).toContain("Acme");
    expect(out).toMatch(/[^\x00-\x7f]/);
    expect(out).toContain("5"); // lead time keeps Latin digits
    for (const status of ["scoring", "review", "matched", "unmatched", "closed", "rejected"] as const) {
      const html = await render(locale, <EnquiryStatusBadge enquiry={{ status, awaitingPick: false }} />);
      expect(html, `${locale} ${status}`).toMatch(/[^\x00-\x7f]/);
    }
    for (const status of ["offered", "accepted", "declined", "expired", "refunded"] as const) expect(await render(locale, <MatchStatusBadge status={status} />)).toMatch(/[^\x00-\x7f]/);
    const deal = await render(locale, <DealReport conversationId="c" matchId="m" current="won" />);
    expect(deal).not.toContain("Did this deal close?");
    expect(deal).toContain("<strong");
    expect(LOCALE_META[locale].script).not.toBe("latin");
  });
});

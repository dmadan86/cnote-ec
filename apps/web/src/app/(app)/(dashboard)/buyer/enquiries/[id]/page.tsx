import { getBuyerEnquiry, getQuoteComparison, listCandidatesForBuyer } from "@cnote/enquiry";
import { landedForQuotes } from "@cnote/logistics";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Card, CardBody, CardTitle, Container, Money, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { formatDate } from "@/i18n/config";
import { getRequestLocale } from "@/lib/request-locale";
import { IntentScore } from "@/features/enquiry/intent-score";
import { QuoteCompare } from "@/features/enquiry/quote-compare";
import { MatchedSellers } from "@/features/enquiry/matched-sellers";
import { NegotiationAssist } from "@/features/negotiation/negotiation-assist";
import { PickSellersForm } from "@/features/enquiry/pick-sellers-form";
import { EnquiryStatusBadge } from "@/features/enquiry/status";
import { canRequestAgain, RequestAgain } from "@/features/retention/request-again";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("enquiry") };
}

export default async function EnquiryDetailPage(props: PageProps<"/buyer/enquiries/[id]">) {
  const { id } = await props.params;
  const s = await requireBusiness(`/buyer/enquiries/${id}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const e = await getBuyerEnquiry(s.business.id, id);
  if (!e) notFound();
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "buyer" });
  const t2 = await getTranslations({ locale, namespace: "rfq2" });
  const tc = await getTranslations({ locale, namespace: "cards" });
  const tl = await getTranslations({ locale, namespace: "rfqLines" });
  const comparison = await getQuoteComparison(actorOf(s), e.id);
  // Landed cost per supplier (goods + GST + freight; an estimate where the seller states no delivery charge). Never blocks the page.
  const landed = comparison?.rows.length
    ? Object.fromEntries(
        await landedForQuotes(
          comparison.rows.map((r) => ({ key: r.matchId, sellerBusinessId: r.sellerBusinessId, quantity: r.quantity, goodsPaise: r.totalPaise, gstIncluded: r.quote.gstIncluded, deliveryChargePaise: r.quote.deliveryChargePaise, deliveryTerms: r.quote.deliveryTerms })),
          e.deliveryPincode,
          e.category?.slug ?? null,
        ).catch(() => new Map()),
      )
    : undefined;
  const money = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

  const cap = e.sellerCap ?? 3;
  const active = e.matches.filter((m) => m.status === "offered" || m.status === "accepted").length;
  const canPick = !!e.buyerPicks && ["scoring", "matched", "unmatched"].includes(e.status) && active < cap;
  const candidates = canPick ? await listCandidatesForBuyer(actorOf(s), e.id) : [];

  return (
    <Container className="max-w-4xl py-8">
      <PageHeader title={e.title} description={t("posted", { date: formatDate(e.createdAt, locale) })} actions={<>{canRequestAgain(e) ? <RequestAgain enquiryId={e.id} locale={locale} /> : null}<EnquiryStatusBadge enquiry={e} /></>} />

      <div className="mt-6 flex flex-col gap-6">
        {e.status === "review" ? <Alert tone="warning">{t("detailReview")}</Alert> : null}
        {e.status === "rejected" ? <Alert tone="danger">{t("detailRejected")}</Alert> : null}
        {e.status === "unmatched" && !canPick ? <Alert tone="warning">{t("detailUnmatched")}</Alert> : null}

        <Card>
          <CardBody className="flex flex-col gap-4">
            <p className="whitespace-pre-wrap text-sm text-ink">{e.requirement}</p>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {e.category ? <Row k={t("category")} v={e.category.name} /> : null}
              {e.quantity ? <Row k={t("quantity")} v={`${e.quantity} ${e.quantityUnit ?? ""}`} /> : null}
              {e.targetPricePaise ? <Row k={t("targetPrice")} v={<Money paise={e.targetPricePaise} unit={e.quantityUnit} />} /> : null}
              {e.deliveryCity || e.deliveryPincode ? <Row k={t("deliverTo")} v={[e.deliveryCity, e.deliveryPincode].filter(Boolean).join(" - ")} /> : null}
              {e.budgetMinPaise || e.budgetMaxPaise ? (
                <Row
                  k={t2("budgetRange")}
                  v={[e.budgetMinPaise ? money(e.budgetMinPaise) : null, e.budgetMaxPaise ? money(e.budgetMaxPaise) : null].filter(Boolean).join(" – ")}
                />
              ) : null}
              {e.neededBy ? <Row k={t("neededBy")} v={e.neededBy} /> : null}
              {e.expiresAt ? <Row k={t2("quotesUntil")} v={formatDate(e.expiresAt, locale)} /> : null}
              {e.minSellerTier ? <Row k={t2("preferredTier")} v={t2("tierOrHigher", { label: tc(`tier${e.minSellerTier}`) })} /> : null}
            </dl>
            {e.attachments.length ? (
              <div className="text-sm">
                <p className="font-medium text-ink">{t2("attachmentsLabel")}</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {e.attachments.map((a) => (
                    <li key={a.id}>
                      <a href={`/api/rfq-attachments/${a.id}`} className="break-all text-brand-700 underline" download>
                        {t2("download", { name: a.fileName })}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardBody>
        </Card>

        {e.lines.length > 1 ? (
          <Card>
            <CardBody className="flex flex-col gap-3">
              <CardTitle>{tl("itemsHeading", { count: e.lines.length })}</CardTitle>
              <div role="region" aria-label={tl("itemsHeading", { count: e.lines.length })} tabIndex={0} className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-brand-600">
                <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
                  <caption className="sr-only">{tl("itemsHeading", { count: e.lines.length })}</caption>
                  <thead className="text-xs text-muted">
                    <tr>
                      <th scope="col" className="py-1 pr-3 font-semibold">{tl("lineCol")}</th>
                      <th scope="col" className="py-1 pr-3 font-semibold">{tl("field.itemName")}</th>
                      <th scope="col" className="py-1 pr-3 font-semibold">{tl("field.quantity")}</th>
                      <th scope="col" className="py-1 pr-3 font-semibold">{tl("field.targetPrice")}</th>
                      <th scope="col" className="py-1 font-semibold">{tl("field.hsn")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.lines.map((l) => (
                      <tr key={l.id} className="border-t border-line align-top">
                        <td className="py-2 pr-3 text-muted">{l.ordinal}</td>
                        <th scope="row" className="py-2 pr-3 font-medium text-ink">
                          {l.itemName}
                          {l.spec ? <span className="block text-xs font-normal text-muted">{l.spec}</span> : null}
                          {l.category ? <span className="block text-xs font-normal text-muted">{l.category.name}</span> : null}
                        </th>
                        <td className="py-2 pr-3">{l.quantity} {l.unit}</td>
                        <td className="py-2 pr-3">{l.targetPricePaise ? <Money paise={l.targetPricePaise} unit={l.unit} /> : "—"}</td>
                        <td className="py-2">{l.hsn ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        ) : null}

        {e.intentScore !== null ? (
          <Card>
            <CardBody className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <CardTitle>{t("intentScore")}</CardTitle>
                <IntentScore score={e.intentScore} />
              </div>
              {e.intentReasons.length ? (
                <ul className="list-disc pl-5 text-sm text-ink">
                  {e.intentReasons.map((r) => (<li key={r}>{r}</li>))}
                </ul>
              ) : null}
            </CardBody>
          </Card>
        ) : null}

        {comparison ? <QuoteCompare comparison={comparison} landed={landed} /> : null}

        {e.matches.length ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-bold text-ink">{t("sellersHeading", { active, cap })}</h2>
            <MatchedSellers matches={e.matches} />
          </section>
        ) : null}

        <NegotiationAssist enquiryId={e.id} actor={actorOf(s)} locale={locale} />

        {canPick ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-bold text-ink">{t("pickHeading")}</h2>
            <PickSellersForm enquiryId={e.id} candidates={candidates} max={cap - active} />
          </section>
        ) : null}
      </div>
    </Container>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line py-1.5">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right text-ink">{v}</dd>
    </div>
  );
}

import { getBuyerEnquiry, listCandidatesForBuyer } from "@cnote/enquiry";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Card, CardBody, CardTitle, Container, Money, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { formatDate } from "@/i18n/config";
import { getRequestLocale } from "@/lib/request-locale";
import { IntentScore } from "@/features/enquiry/intent-score";
import { MatchedSellers } from "@/features/enquiry/matched-sellers";
import { NegotiationAssist } from "@/features/negotiation/negotiation-assist";
import { PickSellersForm } from "@/features/enquiry/pick-sellers-form";
import { EnquiryStatusBadge } from "@/features/enquiry/status";

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

  const cap = e.sellerCap ?? 3;
  const active = e.matches.filter((m) => m.status === "offered" || m.status === "accepted").length;
  const canPick = !!e.buyerPicks && ["scoring", "matched", "unmatched"].includes(e.status) && active < cap;
  const candidates = canPick ? await listCandidatesForBuyer(actorOf(s), e.id) : [];

  return (
    <Container className="max-w-4xl py-8">
      <PageHeader title={e.title} description={t("posted", { date: formatDate(e.createdAt, locale) })} actions={<EnquiryStatusBadge enquiry={e} />} />

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
              {e.neededBy ? <Row k={t("neededBy")} v={e.neededBy} /> : null}
            </dl>
          </CardBody>
        </Card>

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

import { addDays, istDate, listContractCounterparties, rateContractsEnabled, suggestFromQuote } from "@cnote/enquiry";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Card, CardBody, Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRequestLocale } from "@/lib/request-locale";
import { EMPTY_ITEM, TermsForm, type TermsDefaults } from "@/features/contracts/forms";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "contracts" });
  return { title: t("newMetaTitle") };
}

export default async function NewContractPage(props: { searchParams: Promise<{ supplier?: string; quote?: string }> }) {
  const sp = await props.searchParams;
  const s = await requireBusiness("/buyer/contracts/new");
  if (!rateContractsEnabled()) notFound();
  const actor = actorOf(s);
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "contracts" });
  const now = new Date();
  const today = istDate(now);
  const quote = sp.quote ? await suggestFromQuote(actor, sp.quote, now) : null;
  const suppliers = quote ? [] : await listContractCounterparties(actor);
  const defaults: TermsDefaults = quote
    ? {
        title: quote.title, validFrom: quote.terms.validFrom, validTo: quote.terms.validTo, paymentTermsDays: String(quote.terms.paymentTermsDays), priceBasis: quote.terms.priceBasis,
        valueCap: "", notes: "",
        items: quote.terms.items.map((i) => ({
          ...EMPTY_ITEM, description: i.description, unit: i.unit, price: String(i.unitPricePaise / 100), gstPercent: i.gstRateBps / 100, moq: i.moq ? String(i.moq) : "",
        })),
      }
    : { title: "", validFrom: today, validTo: addDays(today, 364), paymentTermsDays: "30", priceBasis: "delivered", valueCap: "", notes: "", items: [EMPTY_ITEM] };
  return (
    <Container className="max-w-3xl py-8">
      <Link href="/buyer/contracts" className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">{t("backToList")}</Link>
      <PageHeader title={quote ? t("newFromQuoteTitle") : t("newTitle")} description={t("newIntro")} />
      <div className="mt-6 flex flex-col gap-4">
        {sp.quote && !quote ? <Alert tone="warning">{t("quoteUnavailable")}</Alert> : null}
        {quote ? <Alert tone="info">{t("quotePrefilled")}</Alert> : null}
        <Card>
          <CardBody>
            <TermsForm mode="create" quoteId={quote?.sourceQuoteId} suppliers={suppliers} supplierId={sp.supplier} defaults={defaults} today={today} />
          </CardBody>
        </Card>
      </div>
    </Container>
  );
}

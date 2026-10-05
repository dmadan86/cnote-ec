import { getRateContract, istDate, purchaseOrdersEnabled, rateContractsEnabled, variationBand } from "@cnote/enquiry";
import { listAddresses } from "@cnote/identity";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Card, CardBody, Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRequestLocale } from "@/lib/request-locale";
import { CallOffForm, type AddressOption, type CallOffItem } from "@/features/contracts/forms";
import { day, inr } from "@/features/contracts/views";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "contracts" });
  return { title: t("calloff.metaTitle") };
}

export default async function CallOffPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = await requireBusiness(`/buyer/contracts/${id}/call-off`);
  if (!rateContractsEnabled()) notFound();
  const now = new Date();
  const c = await getRateContract(actorOf(s), id, now);
  if (!c || c.role !== "buyer") notFound();
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "contracts" });
  const back = <Link href={`/buyer/contracts/${id}`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">{t("backToContract")}</Link>;

  if (!c.actions.callOff || !c.current) {
    return (
      <Container className="max-w-3xl py-8">
        {back}
        <PageHeader title={t("calloff.title", { number: c.number })} description={c.counterparty.name} />
        <div className="mt-6"><Alert tone="warning">{c.phase === "not_started" && c.current ? t("notStarted", { date: day(c.current.validFrom, locale) }) : t("calloff.unavailable")}</Alert></div>
      </Container>
    );
  }
  const poOn = purchaseOrdersEnabled();
  const addresses = poOn ? await listAddresses(s.business.id) : [];
  const options: AddressOption[] = addresses.map((a) => ({ id: a.id, label: a.label, isDefault: a.isDefault, summary: `${a.line1}, ${a.city} ${a.pincode}` }));
  const items: CallOffItem[] = c.current.items
    .filter((i) => i.remainingQuantity !== 0)
    .map((i) => {
      const band = i.variationKind === "indexed" && i.variationCapBps ? variationBand(i.unitPricePaise, i.variationCapBps) : null;
      return {
        itemKey: i.itemKey, description: i.description, unit: i.unit, priceLabel: inr(i.unitPricePaise), unitPricePaise: i.unitPricePaise, moq: i.moq, remaining: i.remainingQuantity,
        indexed: band ? { minPaise: band.min, maxPaise: band.max, capLabel: `${(i.variationCapBps ?? 0) / 100}%` } : null,
      };
    });
  const needsAddress = poOn;
  return (
    <Container className="max-w-3xl py-8">
      {back}
      <PageHeader title={t("calloff.title", { number: c.number })} description={`${c.title} · ${c.counterparty.name}`} />
      <div className="mt-6 flex flex-col gap-4">
        <Alert tone="info">{t("calloff.intro", { to: day(c.current.validTo, locale) })}</Alert>
        {needsAddress && options.length === 0 ? (
          <Alert tone="warning">
            {t("calloff.addressNone")}{" "}
            <Link href="/account/business" className="font-medium underline">{t("calloff.addressAdd")}</Link>
          </Alert>
        ) : items.length === 0 ? (
          <Alert tone="warning">{t("calloff.nothingLeft")}</Alert>
        ) : (
          <Card>
            <CardBody>
              <CallOffForm contractId={id} items={items} addresses={options} needsAddress={needsAddress} today={istDate(now)} idempotencyKey={randomUUID()} />
            </CardBody>
          </Card>
        )}
      </div>
    </Container>
  );
}

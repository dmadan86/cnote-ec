import { getRateContract, istDate, rateContractsEnabled, type RcRevisionView } from "@cnote/enquiry";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Badge, Card, CardBody, CardTitle, Container, PageHeader, buttonClasses } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRequestLocale } from "@/lib/request-locale";
import { RenewForm, RespondForm, SendForm, TermsForm, TerminateForm, type TermsDefaults } from "@/features/contracts/forms";
import { StatusBadge, TermsSummary, TermsTable, UsageBar, day, inr } from "@/features/contracts/views";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "contracts" });
  return { title: t("metaTitle") };
}

const defaultsOf = (title: string, r: RcRevisionView): TermsDefaults => ({
  title, validFrom: r.validFrom, validTo: r.validTo, paymentTermsDays: String(r.paymentTermsDays), priceBasis: r.priceBasis,
  valueCap: r.valueCapPaise === null ? "" : String(r.valueCapPaise / 100), notes: r.notes ?? "",
  items: r.items.map((i) => ({
    itemKey: i.itemKey, listingId: i.listingId, description: i.description, hsn: i.hsn ?? "", unit: i.unit, price: String(i.unitPricePaise / 100), gstPercent: i.gstRateBps / 100,
    moq: i.moq ? String(i.moq) : "", quantityCap: i.quantityCap ? String(i.quantityCap) : "", variationKind: i.variationKind,
    variationCapPercent: i.variationCapBps ? String(i.variationCapBps / 100) : "", variationNote: i.variationNote ?? "",
  })),
});

export default async function BuyerContractPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = await requireBusiness(`/buyer/contracts/${id}`);
  if (!rateContractsEnabled()) notFound();
  const now = new Date();
  const c = await getRateContract(actorOf(s), id, now);
  if (!c || c.role !== "buyer") notFound();
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "contracts" });
  const today = istDate(now);
  const shown = c.current ?? c.pending;
  const edit = shown ? defaultsOf(c.title, c.pending && c.status === "draft" ? c.pending : (c.current ?? c.pending!)) : null;
  const phaseKey = c.phase ? `phase.${c.phase}` : null;

  return (
    <Container className="max-w-4xl py-8">
      <Link href="/buyer/contracts" className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">{t("backToList")}</Link>
      <PageHeader
        title={t("title", { number: c.number })}
        description={`${c.title} · ${c.counterparty.name}`}
        actions={<><StatusBadge status={c.status} locale={locale} />{phaseKey ? <Badge tone={c.phase === "in_force" ? "success" : "neutral"}>{t(phaseKey)}</Badge> : null}</>}
      />
      <div className="mt-6 flex flex-col gap-6">
        {c.status === "draft" ? <Alert tone="info">{t("draftIntro")}</Alert> : null}
        {c.status === "proposed" && c.pending && !c.actions.respond ? <Alert tone="info">{t("waitingForSeller")}</Alert> : null}
        {c.status === "expired" ? <Alert tone="warning">{t("expiredNote")}</Alert> : null}
        {c.status === "terminated" ? <Alert tone="danger">{c.terminationReason ? t("terminatedReason", { role: t(`role.${c.terminatedByRole ?? "buyer"}`), reason: c.terminationReason }) : t("terminated")}</Alert> : null}
        {c.status === "active" && c.daysLeft !== null && c.daysLeft <= 30 && c.daysLeft >= 0 ? <Alert tone="warning">{t("endsSoon", { days: c.daysLeft })}</Alert> : null}
        {c.status === "active" && c.phase === "not_started" && c.current ? <Alert tone="info">{t("notStarted", { date: day(c.current.validFrom, locale) })}</Alert> : null}

        {c.current ? (
          <Card>
            <CardBody className="flex flex-col gap-4">
              <CardTitle>{t("inForceTitle", { revision: c.current.revision })}</CardTitle>
              <TermsSummary rev={c.current} locale={locale} t={t} />
              <TermsTable rev={c.current} locale={locale} showUsage />
              <div className="flex flex-col gap-3" role="group" aria-label={t("usageTitle")}>
                <h3 className="text-base font-semibold text-ink">{t("usageTitle")}</h3>
                {c.current.items.filter((i) => i.quantityCap !== null).map((i) => (
                  <UsageBar key={i.itemKey} label={i.description} percent={i.usedPercent} text={t("usage.of", { used: i.consumedQuantity, cap: i.quantityCap ?? 0, unit: i.unit, percent: i.usedPercent ?? 0 })} />
                ))}
                {c.consumption.valueCapPaise !== null ? (
                  <UsageBar label={t("usage.value")} percent={c.consumption.valuePercent} text={t("usage.valueOf", { used: inr(c.consumption.valueUsedPaise), cap: inr(c.consumption.valueCapPaise), percent: c.consumption.valuePercent ?? 0 })} />
                ) : (
                  <p className="text-sm text-muted">{t("usage.valueUncapped", { used: inr(c.consumption.valueUsedPaise) })}</p>
                )}
              </div>
              {c.actions.callOff ? (
                <div><Link href={`/buyer/contracts/${c.id}/call-off`} className={buttonClasses("primary")}>{t("calloff.open")}</Link></div>
              ) : null}
            </CardBody>
          </Card>
        ) : null}

        {c.pending ? (
          <Card>
            <CardBody className="flex flex-col gap-4">
              <CardTitle>{c.status === "draft" ? t("draftTitle") : t("pendingTitle", { revision: c.pending.revision })}</CardTitle>
              {c.status !== "draft" ? (
                <p className="text-sm text-muted">
                  {t("proposedBy", { role: t(`role.${c.pending.proposedByRole}`) })} · {t("answers", { buyer: t(`answer.${c.pending.answers.buyer}`), seller: t(`answer.${c.pending.answers.seller}`) })}
                  {c.pending.answers.sellerReason ? ` · ${t("sellerReason", { reason: c.pending.answers.sellerReason })}` : ""}
                </p>
              ) : null}
              <TermsSummary rev={c.pending} locale={locale} t={t} />
              <TermsTable rev={c.pending} locale={locale} showUsage={false} />
              {c.actions.respond ? <RespondForm contractId={c.id} revision={c.pending.revision} /> : null}
              {c.actions.send ? <SendForm contractId={c.id} /> : null}
            </CardBody>
          </Card>
        ) : null}

        {c.actions.edit && edit ? (
          <Card>
            <CardBody className="flex flex-col gap-3">
              <details>
                <summary className="min-h-11 cursor-pointer text-sm font-semibold text-brand-700 focus-visible:outline-2 focus-visible:outline-brand-600">{t("editDraft")}</summary>
                <div className="pt-3"><TermsForm mode="draft" contractId={c.id} defaults={edit} today={today} /></div>
              </details>
            </CardBody>
          </Card>
        ) : null}

        {c.actions.propose && c.current ? (
          <Card>
            <CardBody>
              <details>
                <summary className="min-h-11 cursor-pointer text-sm font-semibold text-brand-700 focus-visible:outline-2 focus-visible:outline-brand-600">{t("reviseTitle")}</summary>
                <div className="flex flex-col gap-3 pt-3">
                  <p className="text-sm text-muted">{t("reviseIntro")}</p>
                  <TermsForm mode="revise" contractId={c.id} defaults={defaultsOf(c.title, c.pending ?? c.current)} today={today} />
                </div>
              </details>
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardBody className="flex flex-col gap-3">
            <CardTitle>{t("callOffsTitle")}</CardTitle>
            {c.callOffs.length === 0 ? (
              <p className="text-sm text-muted">{t("callOffsNone")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {c.callOffs.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3 text-sm">
                    <span>
                      <span className="font-medium text-ink">{t("callOffLabel", { n: o.callOffNo })}</span> · {day(o.createdAt.slice(0, 10), locale)} · {inr(o.taxablePaise)} · {t("revisionShort", { n: o.revision })}
                      {o.status === "cancelled" ? ` · ${t("callOffCancelled")}` : ""}
                    </span>
                    <Link href={`/buyer/orders/${o.orderId}`} className="inline-flex min-h-11 items-center font-medium text-brand-700 underline">{t("openOrder")}</Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody className="flex flex-col gap-3">
            <CardTitle>{t("historyTitle")}</CardTitle>
            <ol className="flex flex-col gap-2 text-sm">
              {c.history.map((h) => (
                <li key={h.revision} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{t("revisionLabel", { n: h.revision })}</span>
                  <Badge tone={h.state === "active" ? "success" : h.state === "declined" ? "danger" : "neutral"}>{t(`historyState.${h.state}`)}</Badge>
                  <span className="text-muted">{t("proposedBy", { role: t(`role.${h.proposedByRole}`) })} · {day(h.createdAt.slice(0, 10), locale)}{h.changeNote ? ` · ${h.changeNote}` : ""}</span>
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>

        {c.actions.renew ? (
          <Card><CardBody className="flex flex-col gap-3"><CardTitle>{t("renew.title")}</CardTitle><RenewForm contractId={c.id} /></CardBody></Card>
        ) : null}

        {c.actions.terminate ? (
          <Card>
            <CardBody>
              <details>
                <summary className="min-h-11 cursor-pointer text-sm font-semibold text-brand-700 focus-visible:outline-2 focus-visible:outline-brand-600">{c.status === "draft" ? t("terminate.discard") : t("terminate.title")}</summary>
                <div className="pt-3"><TerminateForm contractId={c.id} /></div>
              </details>
            </CardBody>
          </Card>
        ) : null}
        {c.sourceQuoteId ? <p className="text-xs text-muted">{t("fromQuote")}</p> : null}
        {c.renewedFromId ? <p className="text-xs text-muted"><Link href={`/buyer/contracts/${c.renewedFromId}`} className="underline">{t("renewalOf")}</Link></p> : null}
      </div>
    </Container>
  );
}

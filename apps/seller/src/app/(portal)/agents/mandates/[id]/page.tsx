import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Alert, Card, CardBody, CardHeader, CardTitle, Money, PageHeader } from "@cnote/ui";
import { isA2aEnabled, getMandate, listActivity, listMandateChanges } from "@cnote/a2a";
import { listPriceBook } from "@cnote/negotiation";
import { actorOf } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { ActivityList } from "@/features/a2a/activity-list";
import { AutoAcceptPanel } from "@/features/a2a/auto-accept-panel";
import { MandateStatusBadge } from "@/features/a2a/badges";
import { MandateForm } from "@/features/a2a/mandate-form";
import { StatusControls } from "@/features/a2a/status-controls";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("a2a"))("mandate.metaTitle") };
}

const istDate = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export default async function MandatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSeller(`/agents/mandates/${id}`);
  const t = await getTranslations("a2a");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const biz = actorOf(session).businessId;
  const found = await load(() => getMandate(biz, id));
  if (!found.ok) return <div className="space-y-6"><PageHeader title={t("mandate.title")} /><Alert tone="danger">{found.error}</Alert></div>;
  const m = found.data;
  if (!m || m.side !== "seller") notFound();
  const [changes, activity, book] = await Promise.all([
    load(() => listMandateChanges(biz, id)),
    load(() => listActivity(biz, { mandateId: id, limit: 20 })),
    load(() => listPriceBook(biz)),
  ]);
  const options = book.ok ? book.data.filter((b) => b.active || b.id === m.priceBookId).map((b) => ({ id: b.id, title: b.title })) : [];
  const live = m.status === "active" || m.status === "paused";
  return (
    <div className="space-y-8">
      <PageHeader title={m.name} description={t("mandate.description")} actions={<MandateStatusBadge status={m.status} />} />
      <p><Link href="/agents" className="text-sm font-semibold text-brand-700 underline">{t("mandate.back")}</Link></p>
      {!isA2aEnabled() ? <Alert tone="warning">{t("disabled")}</Alert> : null}

      <Card>
        <CardHeader><CardTitle>{t("mandate.limitsHeading")}</CardTitle></CardHeader>
        <CardBody>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted">{t("form.floor")}</dt><dd>{m.limitPricePaise !== null ? <Money paise={m.limitPricePaise} /> : t("mandate.none")}</dd></div>
            <div><dt className="text-muted">{t("form.maxDiscount")}</dt><dd>{m.maxDiscountPct !== null ? `${m.maxDiscountPct}%` : t("mandate.none")}</dd></div>
            <div><dt className="text-muted">{t("form.capacity")}</dt><dd>{m.capacityQty ?? t("mandate.none")}</dd></div>
            <div><dt className="text-muted">{t("form.rounds")}</dt><dd>{m.maxRounds}</dd></div>
            <div><dt className="text-muted">{t("mandate.consented")}</dt><dd>{formatDateTime(m.consentedAt, locale)}</dd></div>
            <div><dt className="text-muted">{t("mandate.versionLabel")}</dt><dd>{m.version}</dd></div>
          </dl>
          <p className="mt-3 text-xs text-muted">{t("mandate.floorPrivate")}</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("auto.heading")}</CardTitle></CardHeader>
        <CardBody><AutoAcceptPanel id={m.id} enabled={m.autoAccept} limitPaise={m.autoAcceptLimitPaise} editable={live} /></CardBody>
      </Card>

      {live ? (
        <Card>
          <CardHeader><CardTitle>{t("mandate.editHeading")}</CardTitle></CardHeader>
          <CardBody className="space-y-2">
            <p className="text-sm text-muted">{t("mandate.editNote")}</p>
            <MandateForm mode="edit" mandate={m} priceBook={options} expiryDate={m.expiresAt ? istDate(m.expiresAt) : ""} />
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>{t("controls.heading")}</CardTitle></CardHeader>
        <CardBody><StatusControls id={m.id} status={m.status} /></CardBody>
      </Card>

      <section aria-labelledby="mh-h" className="space-y-3">
        <h2 id="mh-h" className="text-lg font-bold text-ink">{t("mandate.historyHeading")}</h2>
        {!changes.ok ? <Alert tone="danger">{changes.error}</Alert> : (
          <ol className="space-y-2" aria-label={t("mandate.historyHeading")}>
            {changes.data.map((c) => (
              <li key={c.id} className="rounded-lg border border-line p-3 text-sm">
                <span className="font-medium text-ink">{t("mandate.historyRow", { n: c.version, action: c.action })}</span>{" "}
                <span className="text-muted">{c.byPerson ? t("activity.you") : t("activity.agent")} · {formatDateTime(c.createdAt, locale)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="ma-h" className="space-y-3">
        <h2 id="ma-h" className="text-lg font-bold text-ink">{t("overview.activityHeading")}</h2>
        {activity.ok ? <ActivityList items={activity.data} /> : <Alert tone="danger">{activity.error}</Alert>}
      </section>
    </div>
  );
}

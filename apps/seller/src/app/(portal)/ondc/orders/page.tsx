import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Alert, Badge, Card, CardBody, EmptyState, Money, PageHeader, buttonClasses, type BadgeTone } from "@cnote/ui";
import { listSellerOrders, type OndcOrderStatus } from "@/lib/ondc";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import { load } from "@/lib/safe";
import { OrderDecision } from "../forms";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("ondc.orders"))("metaTitle") };
}

const TONE: Record<OndcOrderStatus, BadgeTone> = {
  created: "warning",
  accepted: "success",
  in_progress: "brand",
  completed: "neutral",
  cancelled: "danger",
};

export default async function OndcOrdersPage() {
  const session = await requireSeller("/ondc/orders");
  const t = await getTranslations("ondc.orders");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const res = await load(() => listSellerOrders(session.business.id));
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} actions={<Link href="/ondc" className={buttonClasses("outline", "md", "min-h-11")}>{t("settings")}</Link>} />
      {!res.ok ? <Alert tone="danger">{res.error}</Alert> : res.data.length === 0 ? <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} /> : (
        <ul className="grid gap-3">
          {res.data.map((o) => (
            <li key={o.id}>
              <Card><CardBody className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">{o.lines.map((l) => `${l.name} x ${l.count}`).join(", ") || t("order")}</p>
                    <p className="mt-0.5 text-xs text-muted">{t("from", { bap: o.bapId, date: formatDate(o.createdAt, locale) })}</p>
                  </div>
                  <div className="flex items-center gap-3"><Money paise={o.totalPaise} /><Badge tone={TONE[o.status]}>{t(`status.${o.status}`)}</Badge></div>
                </div>
                {o.status === "created" ? <OrderDecision orderId={o.id} /> : null}
              </CardBody></Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, EmptyState, PageHeader, buttonClasses, type BadgeTone } from "@cnote/ui";
import { getSellerState, isEnabled, listSellerListingOptIns, TERMS_VERSION } from "@/lib/ondc";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { ChannelForm, OptInButton } from "./forms";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("ondc"))("metaTitle") };
}

export default async function OndcPage() {
  const session = await requireSeller("/ondc");
  const t = await getTranslations("ondc");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const id = session.business.id;
  const [state, rows] = await Promise.all([load(() => getSellerState(id)), load(() => listSellerListingOptIns(id))]);
  const live = isEnabled();
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} actions={<Link href="/ondc/orders" className={buttonClasses("outline", "md", "min-h-11")}>{t("ordersButton")}</Link>} />
      {!live ? <Alert tone="info">{t("notLive")}</Alert> : null}
      {!state.ok ? <Alert tone="danger">{state.error}</Alert> : (
        <Card>
          <CardHeader><CardTitle>{t("channel")}</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            <p className="flex items-center gap-2 text-sm">{t("statusLabel")} <Badge tone={state.data.enabled ? "success" : "neutral"}>{state.data.enabled ? t("connected") : t("notConnected")}</Badge></p>
            {state.data.enabled ? <p className="text-xs text-muted">{t("termsAccepted", { version: state.data.termsVersion ?? "", when: state.data.acceptedAt ? formatDateTime(state.data.acceptedAt, locale) : "" })} {t("listingsReady", { count: state.data.publishedItems })}</p> : null}
            <ChannelForm connected={state.data.enabled} termsVersion={TERMS_VERSION} />
          </CardBody>
        </Card>
      )}
      <section aria-labelledby="ondc-listings" className="space-y-3">
        <h2 id="ondc-listings" className="text-lg font-semibold">{t("yourListings")}</h2>
        {!rows.ok ? <Alert tone="danger">{rows.error}</Alert> : rows.data.length === 0 ? <EmptyState title={t("noListingsTitle")} description={t("noListingsDescription")} /> : (
          <ul className="grid gap-2">
            {rows.data.map((r) => {
              const tone: BadgeTone = r.optedIn && !r.reason ? "success" : r.optedIn ? "warning" : "neutral";
              return (
                <li key={r.listingId}>
                  <Card><CardBody className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink">{r.title}</p>
                      <p className="mt-0.5"><Badge tone={tone}>{r.optedIn && !r.reason ? t("shown") : r.reason ? t(`reason.${r.reason}`) : t("reason.not_opted_in")}</Badge></p>
                    </div>
                    <OptInButton listingId={r.listingId} optedIn={r.optedIn} />
                  </CardBody></Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

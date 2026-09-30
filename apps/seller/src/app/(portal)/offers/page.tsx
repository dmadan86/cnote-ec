import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, EmptyState, Money, PageHeader, type BadgeTone } from "@cnote/ui";
import { referencePrice } from "@cnote/catalogue";
import { listSellerOffers, offerPrivilegesSuspended, type OfferView } from "@cnote/promotions";
import { requireSeller } from "@/lib/auth";
import { intlTag } from "@/i18n/config";
import { load } from "@/lib/safe";
import { catalogue } from "@/lib/services";
import { CancelOfferButton } from "@/features/offers/cancel-button";
import { OfferForm, type ListingChoice } from "@/features/offers/offer-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("offers");
  return { title: t("meta.title") };
}

type T = Awaited<ReturnType<typeof getTranslations>>;
const TONE: Record<OfferView["status"], BadgeTone> = { draft: "brand", needs_review: "warning", active: "success", rejected: "danger", expired: "neutral", cancelled: "neutral", suspended: "danger" };
const KNOWN_FLAGS = ["deep_discount", "below_floor", "prior_honour_complaint"];
const KNOWN_ENDED = ["listing_changed", "suspended", "expired", "cancelled"];

function terms(o: OfferView, t: T, locale: string): string {
  const x = o.terms as { unitPricePaise?: number; tiers?: { minQty: number; unitPricePaise: number }[]; minQty?: number; minOrderValuePaise?: number; regions?: string[] };
  const inr = (p: number) => `₹${(p / 100).toLocaleString(intlTag(locale), { maximumFractionDigits: 2 })}`;
  if (o.kind === "timed_price") return t("terms.perUnit", { price: inr(x.unitPricePaise ?? 0) });
  if (o.kind === "volume_tiers") return (x.tiers ?? []).map((r) => t("terms.tier", { qty: r.minQty, price: inr(r.unitPricePaise) })).join(" · ");
  return [x.minQty ? t("terms.units", { qty: x.minQty }) : null, x.minOrderValuePaise ? t("terms.above", { price: inr(x.minOrderValuePaise) }) : null, x.regions?.length ? x.regions.join(", ") : t("terms.allIndia")].filter(Boolean).join(" · ");
}

export default async function OffersPage() {
  const session = await requireSeller("/offers");
  const t = await getTranslations("offers");
  const locale = await getLocale();
  const formatDateTime = (iso: string) => new Intl.DateTimeFormat(intlTag(locale), { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(iso));
  const id = session.business.id;
  const [offers, listings, paused] = await Promise.all([
    load(() => listSellerOffers(id)),
    load(async () => {
      const live = (await catalogue.listSellerListings(id)).filter((l) => l.status === "published" && l.moderationStatus === "approved" && l.pricePaise);
      return Promise.all(live.map(async (l): Promise<ListingChoice> => ({ id: l.id, title: l.title, pricePaise: l.pricePaise, moq: l.moq, referencePaise: await referencePrice(l.id).catch(() => null) })));
    }),
    load(() => offerPrivilegesSuspended(id)),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader title={t("page.title")} description={t("page.description")} />

      <Alert tone="info">
        <strong>{t("page.howTitle")}</strong> {t("page.howBody")}
      </Alert>
      {paused.ok && paused.data ? <Alert tone="danger">{t("page.paused")}</Alert> : null}

      <Card>
        <CardHeader><CardTitle>{t("page.createTitle")}</CardTitle></CardHeader>
        <CardBody>
          {listings.ok ? <OfferForm listings={listings.data} /> : <Alert tone="danger">{listings.error}</Alert>}
        </CardBody>
      </Card>

      <section aria-labelledby="your-offers" className="space-y-3">
        <h2 id="your-offers" className="text-lg font-bold text-ink">{t("page.yourOffers")}</h2>
        {!offers.ok ? <Alert tone="danger">{offers.error}</Alert> : offers.data.length === 0 ? (
          <EmptyState title={t("page.emptyTitle")} description={t("page.emptyDesc")} />
        ) : (
          <ul className="space-y-3">
            {offers.data.map((o) => {
                            const open = o.status === "active" || o.status === "draft" || o.status === "needs_review";
              return (
                <li key={o.id}>
                  <Card>
                    <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <p className="truncate font-semibold text-ink">{o.listingTitle ?? t("page.listingFallback")}</p>
                        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
                          <Badge tone={TONE[o.status]}>{t(`status.${o.status}`)}</Badge> {t(`kind.${o.kind}`)}
                        </p>
                        <p className="text-sm text-ink">{terms(o, t, locale)}</p>
                        <p className="text-xs text-muted">
                          {o.endsAt ? t("page.period", { start: formatDateTime(o.startsAt), end: formatDateTime(o.endsAt) }) : t("page.untilEnd", { start: formatDateTime(o.startsAt) })}
                        </p>
                        {o.status === "active" && o.kind !== "free_delivery_moq" ? (
                          <p className="text-xs text-muted">
                            {o.referencePricePaise ? t.rich(o.discountBps ? "page.refSeenPct" : "page.refSeen", { money: () => <Money paise={o.referencePricePaise!} />, pct: Math.floor((o.discountBps ?? 0) / 100) }) : t("page.noRef")}
                          </p>
                        ) : null}
                        {o.status === "needs_review" ? <p className="text-xs text-warning">{t("page.held", { flags: o.reviewFlags.map((f) => (KNOWN_FLAGS.includes(f) ? t(`flag.${f}`) : f)).join(", ") })}</p> : null}
                        {o.reviewNote && (o.status === "rejected" || o.status === "suspended") ? <p className="text-xs text-danger">{t("page.note", { note: o.reviewNote })}</p> : null}
                        {o.endedReason && (o.status === "suspended" || o.status === "rejected") ? <p className="text-xs text-muted">{t("page.endedBecause", { reason: KNOWN_ENDED.includes(o.endedReason) ? t(`ended.${o.endedReason}`) : o.endedReason })}</p> : null}
                      </div>
                      {open ? <CancelOfferButton offerId={o.id} title={o.listingTitle ?? t("page.listingFallback")} /> : null}
                    </CardBody>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

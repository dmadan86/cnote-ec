import type { ReactNode } from "react";
import { MapPin } from "lucide-react";
import { getTranslations } from "next-intl/server";
import type { TrustProfile } from "@cnote/identity";
import { Avatar, buttonClasses, Card, CardBody, TrustBadge } from "@cnote/ui";
import { LOCALE_META, type Locale } from "@/i18n/config";
import { LocaleLink as Link } from "@/i18n/link";
import { sellerPath } from "@/lib/paths";
import { RatingStars } from "@/features/reviews/stars";
import { getUiLabels } from "@/features/search/labels";
import { evidenceItems, responseText, yearsText } from "./evidence-items";
import type { SupplierTrust } from "./model";
import { FollowIsland } from "@/features/retention/follow-island";
import { VerifiedDisclosure } from "./verified-disclosure";

/**
 * Supplier card (PDP and anywhere a supplier is summarised). Trust evidence comes from the public read model
 * (`loadSupplierTrust`); `contact` is a slot for the page's existing unlock flow, so this component stays free of
 * leadgen concerns. Without `trust` (read model unavailable) it degrades to the plain badge + trust score.
 */
export async function SellerCard({
  seller,
  trust,
  locale,
  place,
  contact,
  heading = "h2",
}: {
  seller: TrustProfile;
  trust: SupplierTrust | null;
  locale: Locale;
  /** translated "City, State" (or empty) */
  place: string;
  contact?: ReactNode;
  heading?: "h2" | "h3";
}) {
  const [t, tp, ui] = await Promise.all([getTranslations({ locale, namespace: "supplier" }), getTranslations({ locale, namespace: "product" }), getUiLabels(locale)]);
  const H = heading;
  const tx = t as unknown as (k: string, v?: Record<string, string | number>) => string;
  const resp = trust ? responseText(trust, tx) : { time: null, accept: null };
  const items = trust ? evidenceItems(trust, tx, LOCALE_META[locale].bcp47) : [];

  return (
    <Card>
      <CardBody className="flex items-start gap-3">
        <Avatar name={seller.name} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{t("card.heading")}</p>
          <H className="truncate text-base font-semibold text-ink">
            <Link href={sellerPath(seller.businessId)} className="hover:text-brand-700 hover:underline">
              {seller.name}
            </Link>
          </H>
          <p className="mt-0.5 inline-flex items-center gap-1 text-sm text-muted">
            <MapPin className="size-3.5" aria-hidden /> {place || t("card.india")}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <TrustBadge tier={seller.verificationTier} badgeActive={seller.badgeActive} labels={ui.trust} />
            <span className="text-xs text-muted">{tp("trustScore", { score: seller.trustScore })}</span>
          </div>
          {trust ? (
            <VerifiedDisclosure
              className="mt-2"
              label={t("card.whatsVerified")}
              summary={t("card.checksPassed", { passed: trust.passedChecks.length })}
              listLabel={t("evidence.list")}
              items={items}
              gstinLine={trust.gstinMasked ? t("evidence.gstinOnFile", { gstin: trust.gstinMasked }) : null}
              footer={
                <Link href={`${sellerPath(seller.businessId)}#verification`} className="font-medium text-brand-700 underline">
                  {t("verification.title")}
                </Link>
              }
            />
          ) : null}

          {trust ? (
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <div>
                <dt className="text-muted">{t("card.responseTime")}</dt>
                <dd className="font-semibold text-ink">{resp.time ?? t("card.newSupplier")}</dd>
              </div>
              <div>
                <dt className="text-muted">{t("card.acceptRate")}</dt>
                <dd className="font-semibold text-ink">{resp.accept ?? t("card.newSupplier")}</dd>
              </div>
              <div>
                <dt className="text-muted">{t("card.onPlatform")}</dt>
                <dd className="font-semibold text-ink">{yearsText(trust, tx)}</dd>
              </div>
              <div>
                <dt className="text-muted">{t("card.rating")}</dt>
                <dd className="font-semibold text-ink">{trust.rating ? <RatingStars average={trust.rating.average} count={trust.rating.count} /> : t("card.noReviews")}</dd>
              </div>
            </dl>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Link href={sellerPath(seller.businessId)} className={buttonClasses("outline-brand", "md")}>
              {t("card.viewProfile")}
            </Link>
            <FollowIsland businessId={seller.businessId} name={seller.name} />
            {contact}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

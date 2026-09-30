import Link from "next/link";
import type { ReactNode } from "react";
import { MapPin } from "lucide-react";
import { getTranslations } from "next-intl/server";
import type { CategoryView, ListingView } from "@cnote/catalogue";
import type { TrustProfile } from "@cnote/identity";
import { buttonClasses, cn, Money, TrustBadge, WishlistButton } from "@cnote/ui";
import { productPath } from "@/lib/paths";
import { trustLabels } from "@/features/enquiry/trust-labels";
import { getRequestLocale } from "@/lib/request-locale";
import { RatingStars } from "@/features/reviews/stars";
import { ProductImage } from "@/features/search/product-image";
import { moqText } from "@/features/search/format";
import { toggleSavedAction } from "@/features/wishlist/actions";
import { removeFromCompareAction } from "./actions";

type Field = CategoryView["attributeSchema"]["fields"][number];

const prettify = (k: string) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const MISSING = "—";

function attrText(l: ListingView, f: { key: string; unit?: string }): string {
  const v = l.attributes?.[f.key];
  if (v === undefined || v === null || v === "") return MISSING;
  return f.unit ? `${v} ${f.unit}` : String(v);
}

const th = "sticky left-0 z-10 w-32 min-w-32 bg-surface px-3 py-3 text-left align-top text-xs font-semibold uppercase tracking-wide text-muted sm:w-40";
const td = "min-w-44 px-3 py-3 align-top text-sm text-ink";

function Row({ label, listings, values, plain, differNote }: { label: string; listings: ListingView[]; values: ReactNode[]; plain?: string[]; differNote: string }) {
  const differs = plain ? new Set(plain).size > 1 : false;
  return (
    <tr className="border-t border-line">
      <th scope="row" className={th}>
        {label}
      </th>
      {values.map((v, i) => (
        <td key={listings[i]!.id} className={cn(td, differs && "bg-brand-50")}>
          {v}
          {differs && i === 0 ? <span className="sr-only"> ({differNote})</span> : null}
        </td>
      ))}
    </tr>
  );
}

/** Side-by-side table. Mobile: columns scroll horizontally and the row-label column stays put. */
export async function CompareTable({
  listings,
  sellers,
  fields,
  savedIds,
  signedIn,
  shared,
  ids,
  ratings = {},
}: {
  listings: ListingView[];
  sellers: Record<string, TrustProfile>;
  fields: Field[];
  savedIds: string[];
  signedIn: boolean;
  shared: boolean;
  ids: string[];
  /** Approved-review rating summaries by listing id (from loadRatings). */
  ratings?: Record<string, { average: number; count: number }>;
}) {
  const locale = await getRequestLocale();
  const [t, tc] = await Promise.all([getTranslations({ locale, namespace: "compare" }), getTranslations({ locale, namespace: "cards" })]);
  const trust = trustLabels(tc);
  const wishLabels = { save: tc.raw("saveTitle") as string, remove: tc.raw("removeSavedTitle") as string, saved: tc("saved"), saveShort: tc("save"), signInToSave: tc("signInToSave"), error: tc("saveError") };
  const saved = new Set(savedIds);
  // Rows = union of the category's schema fields plus any extra attribute keys the products carry.
  const known = new Set(fields.map((f) => f.key));
  const extra = [...new Set(listings.flatMap((l) => Object.keys(l.attributes ?? {})))].filter((k) => !known.has(k));
  const rows: { key: string; label: string; unit?: string }[] = [...fields.map((f) => ({ key: f.key, label: f.label, unit: f.unit })), ...extra.map((k) => ({ key: k, label: prettify(k) }))];

  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface">
      <table className="w-full border-collapse">
        <caption className="sr-only">{t("caption")}</caption>
        <thead>
          <tr>
            <th scope="col" className={th}>
              <span className="sr-only">{t("attribute")}</span>
            </th>
            {listings.map((l) => (
              <th key={l.id} scope="col" className="min-w-44 px-3 py-3 text-left align-top font-normal">
                <div className="relative aspect-square w-full max-w-40 overflow-hidden rounded-lg bg-canvas">
                  <ProductImage src={l.imageUrls[0]} blur={l.imageBlurs?.[0]} sizes="160px" />
                </div>
                <Link href={productPath(l)} className="mt-2 line-clamp-3 block text-sm font-semibold text-ink hover:text-brand-700 hover:underline">
                  {l.title}
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <Row
            listings={listings}
            label={t("price")}
            differNote={t("differNote")}
            plain={listings.map((l) => String(l.pricePaise ?? MISSING))}
            values={listings.map((l) => (l.pricePaise != null ? <Money key={l.id} paise={l.pricePaise} unit={l.priceUnit} /> : <span key={l.id} className="text-muted">{tc("priceOnRequest")}</span>))}
          />
          <Row differNote={t("differNote")} listings={listings} label={t("minOrder")} plain={listings.map((l) => moqText(l) ?? MISSING)} values={listings.map((l) => moqText(l) ?? MISSING)} />
          <Row
            listings={listings}
            label={t("seller")}
            differNote={t("differNote")}
            values={listings.map((l) => {
              const s = sellers[l.sellerBusinessId];
              return s ? (
                <div key={l.id} className="flex flex-col gap-1.5">
                  <Link href={`/manufacturers/${s.businessId}`} className="font-medium hover:text-brand-700 hover:underline">
                    {s.name}
                  </Link>
                  <TrustBadge tier={s.verificationTier} badgeActive={s.badgeActive} labels={trust} />
                  {s.city ? (
                    <span className="inline-flex items-center gap-0.5 text-xs text-muted">
                      <MapPin className="size-3" aria-hidden /> {s.city}
                    </span>
                  ) : null}
                  <span className="text-xs text-muted">{tc("trustScore", { score: s.trustScore })}</span>
                </div>
              ) : (
                MISSING
              );
            })}
          />
          {rows.map((r) => {
            const plain = listings.map((l) => attrText(l, r));
            return <Row key={r.key} differNote={t("differNote")} listings={listings} label={r.label} plain={plain} values={plain} />;
          })}
          <Row differNote={t("differNote")} listings={listings} label={t("hsn")} plain={listings.map((l) => l.hsn ?? MISSING)} values={listings.map((l) => l.hsn ?? MISSING)} />
          <Row
            listings={listings}
            label={t("rating")}
            differNote={t("differNote")}
            plain={listings.map((l) => (ratings[l.id]?.count ? String(ratings[l.id]!.average) : MISSING))}
            values={listings.map((l) => {
              const r = ratings[l.id];
              return r?.count ? <RatingStars key={l.id} average={r.average} count={r.count} /> : <span key={l.id} className="text-muted">{t("noReviews")}</span>;
            })}
          />
          <tr className="border-t border-line">
            <th scope="row" className={th}>
              {t("actions")}
            </th>
            {listings.map((l) => (
              <td key={l.id} className={td}>
                <div className="flex flex-col items-start gap-2">
                  <Link href={`/rfq/new?listing=${l.id}`} className={buttonClasses("accent", "md")}>
                    {t("requestQuote")}
                  </Link>
                  <div className="flex items-center gap-2">
                    <WishlistButton id={l.id} title={l.title} saved={saved.has(l.id)} onToggle={signedIn ? toggleSavedAction : undefined} className="size-10" labels={wishLabels} />
                    {shared ? (
                      <Link
                        href={`/compare?ids=${ids.filter((x) => x !== l.id).join(",")}`}
                        className="inline-flex min-h-11 items-center text-xs font-medium text-muted underline hover:text-danger"
                        aria-label={t("removeFromComparison", { title: l.title })}
                      >
                        {t("remove")}
                      </Link>
                    ) : (
                      <form action={removeFromCompareAction}>
                        <input type="hidden" name="listingId" value={l.id} />
                        <button type="submit" aria-label={tc("removeCompare", { title: l.title })} className="inline-flex min-h-11 items-center text-xs font-medium text-muted underline hover:text-danger focus-visible:outline-2 focus-visible:outline-brand-600">
                          {t("remove")}
                        </button>
                      </form>
                    )}
                  </div>
                </div>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

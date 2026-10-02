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
import { LOCALE_META } from "@/i18n/config";
import { responseText, yearsText } from "@/features/supplier/evidence-items";
import type { SupplierTrust } from "@/features/supplier/model";
import { removeFromCompareAction } from "./actions";
import { HighlightRegion } from "./highlight-region";
import { priceTiersOf } from "./price-tiers";

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

function Row({ label, listings, values, plain, differNote, differsLabel }: { label: string; listings: ListingView[]; values: ReactNode[]; plain?: string[]; differNote: string; differsLabel: string }) {
  const differs = plain ? new Set(plain).size > 1 : false;
  return (
    <tr className="border-t border-line" data-differs={differs ? "true" : undefined}>
      <th scope="row" className={th}>
        {label}
        {differs ? (
          <>
            <span className="sr-only"> ({differNote})</span>
            <span aria-hidden className="mt-1 hidden w-fit rounded border border-brand-600 px-1 text-[10px] font-semibold normal-case tracking-normal text-brand-700 group-data-[highlight=true]/cmp:block">
              {differsLabel}
            </span>
          </>
        ) : null}
      </th>
      {values.map((v, i) => (
        <td key={listings[i]!.id} className={cn(td, differs && "group-data-[highlight=true]/cmp:bg-brand-50")}>
          {v}
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
  supplierTrust = {},
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
  /** Public supplier trust read models by seller business id (absent entries render a dash). */
  supplierTrust?: Record<string, SupplierTrust>;
}) {
  const locale = await getRequestLocale();
  const [t, tc, tsRaw] = await Promise.all([getTranslations({ locale, namespace: "compare" }), getTranslations({ locale, namespace: "cards" }), getTranslations({ locale, namespace: "supplier" })]);
  const ts = tsRaw as unknown as (k: string, v?: Record<string, string | number>) => string;
  const bcp47 = LOCALE_META[locale].bcp47;
  const differs = ts("compare.differs");
  const tiers = priceTiersOf(listings);
  const trust = trustLabels(tc);
  const wishLabels = { save: tc.raw("saveTitle") as string, remove: tc.raw("removeSavedTitle") as string, saved: tc("saved"), saveShort: tc("save"), signInToSave: tc("signInToSave"), error: tc("saveError") };
  const saved = new Set(savedIds);
  // Rows = union of the category's schema fields plus any extra attribute keys the products carry.
  const known = new Set(fields.map((f) => f.key));
  const extra = [...new Set(listings.flatMap((l) => Object.keys(l.attributes ?? {})))].filter((k) => !known.has(k));
  const rows: { key: string; label: string; unit?: string }[] = [...fields.map((f) => ({ key: f.key, label: f.label, unit: f.unit })), ...extra.map((k) => ({ key: k, label: prettify(k) }))];

  return (
    <HighlightRegion label={ts("compare.highlight")}>
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
            differsLabel={differs}
            listings={listings}
            label={t("price")}
            differNote={t("differNote")}
            plain={listings.map((l) => String(l.pricePaise ?? MISSING))}
            values={listings.map((l) => (l.pricePaise != null ? <Money key={l.id} paise={l.pricePaise} unit={l.priceUnit} /> : <span key={l.id} className="text-muted">{tc("priceOnRequest")}</span>))}
          />
          <Row differsLabel={differs} differNote={t("differNote")} listings={listings} label={t("minOrder")} plain={listings.map((l) => moqText(l) ?? MISSING)} values={listings.map((l) => moqText(l) ?? MISSING)} />
          <Row
            differsLabel={differs}
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
          <Row differsLabel={differs} differNote={t("differNote")} listings={listings} label={ts("compare.tier")}
            plain={listings.map((l) => { const s = sellers[l.sellerBusinessId]; return s ? `${s.badgeActive ? s.verificationTier : 0}` : MISSING; })}
            values={listings.map((l) => {
              const s = sellers[l.sellerBusinessId];
              const st = supplierTrust[l.sellerBusinessId];
              if (!s) return MISSING;
              return (
                <span key={l.id} className="flex flex-col gap-0.5">
                  <span>{tc(`tier${Math.min(s.badgeActive ? s.verificationTier : 0, 3)}`)}</span>
                  {st ? <span className="text-xs text-muted">{ts("compare.checks", { count: st.passedChecks.length })}</span> : null}
                </span>
              );
            })}
          />
          <Row differsLabel={differs} differNote={t("differNote")} listings={listings} label={ts("compare.location")}
            plain={listings.map((l) => sellers[l.sellerBusinessId]?.city ?? MISSING)}
            values={listings.map((l) => { const s = sellers[l.sellerBusinessId]; return s ? [s.city, s.state].filter(Boolean).join(", ") || MISSING : MISSING; })}
          />
          <Row differsLabel={differs} differNote={t("differNote")} listings={listings} label={ts("compare.response")}
            plain={listings.map((l) => { const st = supplierTrust[l.sellerBusinessId]; return st ? (responseText(st, ts).time ?? ts("card.newSupplier")) : MISSING; })}
            values={listings.map((l) => { const st = supplierTrust[l.sellerBusinessId]; return st ? (responseText(st, ts).time ?? ts("card.newSupplier")) : MISSING; })}
          />
          <Row differsLabel={differs} differNote={t("differNote")} listings={listings} label={ts("compare.accept")}
            plain={listings.map((l) => { const st = supplierTrust[l.sellerBusinessId]; return st ? (responseText(st, ts).accept ?? ts("card.newSupplier")) : MISSING; })}
            values={listings.map((l) => { const st = supplierTrust[l.sellerBusinessId]; return st ? (responseText(st, ts).accept ?? ts("card.newSupplier")) : MISSING; })}
          />
          <Row differsLabel={differs} differNote={t("differNote")} listings={listings} label={ts("compare.rating")}
            plain={listings.map((l) => { const st = supplierTrust[l.sellerBusinessId]; return st?.rating ? String(st.rating.average) : MISSING; })}
            values={listings.map((l) => { const st = supplierTrust[l.sellerBusinessId]; return st?.rating ? <RatingStars key={l.id} average={st.rating.average} count={st.rating.count} /> : <span key={l.id} className="text-muted">{ts("card.noReviews")}</span>; })}
          />
          <Row differsLabel={differs} differNote={t("differNote")} listings={listings} label={ts("compare.years")}
            plain={listings.map((l) => { const st = supplierTrust[l.sellerBusinessId]; return st ? yearsText(st, ts) : MISSING; })}
            values={listings.map((l) => { const st = supplierTrust[l.sellerBusinessId]; return st ? yearsText(st, ts) : MISSING; })}
          />
          {tiers.some((x) => x.length) ? (
            <Row differsLabel={differs} differNote={t("differNote")} listings={listings} label={ts("compare.priceTiers")}
              plain={tiers.map((x) => x.map((r) => `${r.qty}:${r.pricePaise}`).join("|") || MISSING)}
              values={tiers.map((x, i) =>
                x.length ? (
                  <ul key={listings[i]!.id} className="flex flex-col gap-0.5">
                    {x.map((r) => (
                      <li key={r.qty} className="text-xs">
                        {ts("compare.tierQty", { qty: r.qty.toLocaleString(bcp47) })}: <Money paise={r.pricePaise} unit={listings[i]!.priceUnit} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  MISSING
                ),
              )}
            />
          ) : null}
          {rows.map((r) => {
            const plain = listings.map((l) => attrText(l, r));
            return <Row key={r.key} differsLabel={differs} differNote={t("differNote")} listings={listings} label={r.label} plain={plain} values={plain} />;
          })}
          <Row differsLabel={differs} differNote={t("differNote")} listings={listings} label={t("hsn")} plain={listings.map((l) => l.hsn ?? MISSING)} values={listings.map((l) => l.hsn ?? MISSING)} />
          <Row
            differsLabel={differs}
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
    </HighlightRegion>
  );
}

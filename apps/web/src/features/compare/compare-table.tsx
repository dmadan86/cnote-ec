import Link from "next/link";
import type { ReactNode } from "react";
import { MapPin } from "lucide-react";
import type { CategoryView, ListingView } from "@cnote/catalogue";
import type { TrustProfile } from "@cnote/identity";
import { buttonClasses, cn, Money, TrustBadge, WishlistButton } from "@cnote/ui";
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

function Row({ label, listings, values, plain }: { label: string; listings: ListingView[]; values: ReactNode[]; plain?: string[] }) {
  const differs = plain ? new Set(plain).size > 1 : false;
  return (
    <tr className="border-t border-line">
      <th scope="row" className={th}>
        {label}
      </th>
      {values.map((v, i) => (
        <td key={listings[i]!.id} className={cn(td, differs && "bg-brand-50")}>
          {v}
          {differs && i === 0 ? <span className="sr-only"> (values differ between products)</span> : null}
        </td>
      ))}
    </tr>
  );
}

/** Side-by-side table. Mobile: columns scroll horizontally and the row-label column stays put. */
export function CompareTable({
  listings,
  sellers,
  fields,
  savedIds,
  signedIn,
  shared,
  ids,
}: {
  listings: ListingView[];
  sellers: Record<string, TrustProfile>;
  fields: Field[];
  savedIds: string[];
  signedIn: boolean;
  shared: boolean;
  ids: string[];
}) {
  const saved = new Set(savedIds);
  // Rows = union of the category's schema fields plus any extra attribute keys the products carry.
  const known = new Set(fields.map((f) => f.key));
  const extra = [...new Set(listings.flatMap((l) => Object.keys(l.attributes ?? {})))].filter((k) => !known.has(k));
  const rows: { key: string; label: string; unit?: string }[] = [...fields.map((f) => ({ key: f.key, label: f.label, unit: f.unit })), ...extra.map((k) => ({ key: k, label: prettify(k) }))];

  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface">
      <table className="w-full border-collapse">
        <caption className="sr-only">Product comparison</caption>
        <thead>
          <tr>
            <th scope="col" className={th}>
              <span className="sr-only">Attribute</span>
            </th>
            {listings.map((l) => (
              <th key={l.id} scope="col" className="min-w-44 px-3 py-3 text-left align-top font-normal">
                <div className="relative aspect-square w-full max-w-40 overflow-hidden rounded-lg bg-canvas">
                  <ProductImage src={l.imageUrls[0]} sizes="160px" />
                </div>
                <Link href={`/products/${l.id}`} className="mt-2 line-clamp-3 block text-sm font-semibold text-ink hover:text-brand-700 hover:underline">
                  {l.title}
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <Row
            listings={listings}
            label="Price"
            plain={listings.map((l) => String(l.pricePaise ?? MISSING))}
            values={listings.map((l) => (l.pricePaise != null ? <Money key={l.id} paise={l.pricePaise} unit={l.priceUnit} /> : <span key={l.id} className="text-muted">Price on request</span>))}
          />
          <Row listings={listings} label="Min. order" plain={listings.map((l) => moqText(l) ?? MISSING)} values={listings.map((l) => moqText(l) ?? MISSING)} />
          <Row
            listings={listings}
            label="Seller"
            values={listings.map((l) => {
              const s = sellers[l.sellerBusinessId];
              return s ? (
                <div key={l.id} className="flex flex-col gap-1.5">
                  <Link href={`/manufacturers/${s.businessId}`} className="font-medium hover:text-brand-700 hover:underline">
                    {s.name}
                  </Link>
                  <TrustBadge tier={s.verificationTier} badgeActive={s.badgeActive} />
                  {s.city ? (
                    <span className="inline-flex items-center gap-0.5 text-xs text-muted">
                      <MapPin className="size-3" aria-hidden /> {s.city}
                    </span>
                  ) : null}
                  <span className="text-xs text-muted">Trust score {s.trustScore}/100</span>
                </div>
              ) : (
                MISSING
              );
            })}
          />
          {rows.map((r) => {
            const plain = listings.map((l) => attrText(l, r));
            return <Row key={r.key} listings={listings} label={r.label} plain={plain} values={plain} />;
          })}
          <Row listings={listings} label="HSN code" plain={listings.map((l) => l.hsn ?? MISSING)} values={listings.map((l) => l.hsn ?? MISSING)} />
          {/* TODO(reviews): add a "Rating" row from getRatingSummaries(listingIds) in @cnote/reviews once it exists. */}
          <tr className="border-t border-line">
            <th scope="row" className={th}>
              Actions
            </th>
            {listings.map((l) => (
              <td key={l.id} className={td}>
                <div className="flex flex-col items-start gap-2">
                  <Link href={`/rfq/new?listing=${l.id}`} className={buttonClasses("accent", "md")}>
                    Request quote
                  </Link>
                  <div className="flex items-center gap-2">
                    <WishlistButton id={l.id} title={l.title} saved={saved.has(l.id)} onToggle={signedIn ? toggleSavedAction : undefined} className="size-10" />
                    {shared ? (
                      <Link
                        href={`/compare?ids=${ids.filter((x) => x !== l.id).join(",")}`}
                        className="inline-flex min-h-10 items-center text-xs font-medium text-muted underline hover:text-danger"
                        aria-label={`Remove ${l.title} from this comparison`}
                      >
                        Remove
                      </Link>
                    ) : (
                      <form action={removeFromCompareAction}>
                        <input type="hidden" name="listingId" value={l.id} />
                        <button type="submit" aria-label={`Remove ${l.title} from compare`} className="inline-flex min-h-10 items-center text-xs font-medium text-muted underline hover:text-danger focus-visible:outline-2 focus-visible:outline-brand-600">
                          Remove
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

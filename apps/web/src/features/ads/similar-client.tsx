"use client";
import { ProductCard } from "@cnote/ui";
import { useEffect, useState } from "react";
import { ProductImage } from "@/features/search/product-image";
import { SponsoredLabel } from "./label";
import { SponsoredLink } from "./sponsored-link";

interface Item {
  id: string;
  title: string;
  imageUrl: string | null;
  pricePaise: number | null;
  priceUnit: string | null;
  moqText: string | null;
  seller: { name: string; city: string | null; tier: number; badgeActive: boolean };
  clickHref: string;
}

export interface SimilarLabels {
  sponsored: string;
  sponsoredSr: string;
  heading: string;
  aria: string;
  note: string;
  how: string;
  howHref: string;
  priceOnRequest: string;
  minOrder: string;
}

/** Fetches after hydration so the product page itself stays static/ISR (ads are per-request and must never be frozen into the page). */
export function SponsoredSimilarClient({ listingId, locale, labels }: { listingId: string; locale: string; labels: SimilarLabels }) {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    let live = true;
    fetch(`/api/ads/similar?listingId=${encodeURIComponent(listingId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d: { items?: Item[] }) => live && setItems(d.items ?? []))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [listingId]);
  if (!items.length) return null; // empty slots collapse
  return (
    <section aria-labelledby="sponsored-similar-heading" className="mt-10 rounded-card border-2 border-dashed border-ink/40 bg-canvas p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="sponsored-similar-heading" className="text-base font-bold text-ink">
          {labels.heading}
        </h2>
        <a href={labels.howHref} className="text-sm text-brand-700 underline underline-offset-2">
          {labels.how}
        </a>
      </div>
      <p className="mt-1 text-sm text-muted">{labels.note}</p>
      <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2" aria-label={labels.aria}>
        {items.map((it) => (
          <ProductCard
            key={it.id}
            id={it.id}
            href={`${it.clickHref}?l=${locale}`}
            title={it.title}
            image={
              <>
                <ProductImage src={it.imageUrl ?? undefined} sizes="(min-width: 640px) 30vw, 90vw" />
                <SponsoredLabel label={labels.sponsored} srLabel={labels.sponsoredSr} className="absolute left-2 top-2 z-10" />
              </>
            }
            pricePaise={it.pricePaise}
            priceUnit={it.priceUnit}
            moqText={it.moqText}
            seller={it.seller}
            wishlist={<span />}
            linkComponent={SponsoredLink}
            labels={{ priceOnRequest: labels.priceOnRequest, minOrder: labels.minOrder }}
            className="border-dashed border-ink/40"
          />
        ))}
      </ul>
    </section>
  );
}

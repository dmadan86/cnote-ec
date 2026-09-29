"use client";
import { PLACEHOLDERS, placeholderOf, type ImageRef } from "@cnote/storefront/document";
import type { RenderData } from "@cnote/storefront/render";
import { Input, Field, cn } from "@cnote/ui";
import { ExternalLink } from "lucide-react";
import { useId, useState } from "react";
import type { SellerImageLite } from "./types";
import { SELLER_LISTINGS_URL } from "./types";

const tile = "relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-lg border-2 bg-canvas text-xs font-medium text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

/**
 * Picks an image. Only the seller's APPROVED listing images (from the catalogue) and built-in placeholders are offered:
 * there is no URL box, so external images cannot be entered at all.
 */
export function ImagePicker({ label, value, onChange, images, nullable = true, defaultAlt = "" }: {
  label: string; value: ImageRef | null; onChange: (v: ImageRef | null) => void; images: SellerImageLite[]; nullable?: boolean; defaultAlt?: string;
}) {
  const altId = useId();
  const isPh = value ? placeholderOf(value.src) !== null : false;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold text-ink">{label}</legend>
      <div className="grid grid-cols-3 gap-2">
        {nullable ? (
          <button type="button" aria-pressed={value === null} onClick={() => onChange(null)} className={cn(tile, value === null ? "border-brand-600" : "border-line")}>No image</button>
        ) : null}
        {images.map((im) => (
          <button key={im.id} type="button" aria-pressed={value?.src === im.url} aria-label={`Use image: ${im.alt}`} onClick={() => onChange({ src: im.url, alt: im.alt || defaultAlt })} className={cn(tile, value?.src === im.url ? "border-brand-600" : "border-line")}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={im.url} alt="" className="size-full object-cover" loading="lazy" />
          </button>
        ))}
        {PLACEHOLDERS.map((p) => (
          <button key={p} type="button" aria-pressed={value?.src === `placeholder:${p}`} aria-label={`Use ${p} placeholder illustration`} onClick={() => onChange({ src: `placeholder:${p}`, alt: "" })} className={cn(tile, value?.src === `placeholder:${p}` ? "border-brand-600" : "border-line")}>
            <span className="capitalize">{p}</span>
          </button>
        ))}
      </div>
      {images.length === 0 ? (
        <p className="text-xs text-muted">
          You have no approved images yet. Add photos to your listings in the{" "}
          <a href={SELLER_LISTINGS_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-medium text-brand-700 hover:underline">Seller portal<ExternalLink className="size-3" aria-hidden /><span className="sr-only"> (opens in a new tab)</span></a>;
          once our team approves them they appear here.
        </p>
      ) : (
        <p className="text-xs text-muted">Only your approved listing images can be used.</p>
      )}
      {value ? (
        <Field label="Alt text" htmlFor={altId} hint={isPh ? "Placeholders are decorative; leave empty. Replace with a real photo before publishing." : "Describe the image for people using screen readers."}>
          <Input id={altId} value={value.alt} maxLength={140} onChange={(e) => onChange({ ...value, alt: e.target.value })} />
        </Field>
      ) : null}
    </fieldset>
  );
}

export function ProductMultiPicker({ products, selected, onChange, max }: { products: RenderData["products"]; selected: string[]; onChange: (ids: string[]) => void; max: number }) {
  const [q, setQ] = useState("");
  const shown = products.filter((p) => p.title.toLowerCase().includes(q.trim().toLowerCase()));
  const searchId = useId();
  if (!products.length) return <p className="text-sm text-muted">You have no public listings yet. Publish listings in the Seller portal to feature them here.</p>;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold text-ink">Choose products <span className="font-normal text-muted">({selected.length}/{max})</span></legend>
      <Field label="Search your products" htmlFor={searchId}><Input id={searchId} type="search" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
      <ul className="max-h-60 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
        {shown.map((p) => {
          const on = selected.includes(p.id);
          return (
            <li key={p.id}>
              <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1 text-sm hover:bg-canvas">
                <input type="checkbox" className="size-4 accent-brand-600" checked={on} disabled={!on && selected.length >= max} onChange={() => onChange(on ? selected.filter((x) => x !== p.id) : [...selected, p.id])} />
                <span className="truncate">{p.title}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

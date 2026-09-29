import { X } from "lucide-react";
import Link from "next/link";
import { buttonClasses } from "@cnote/ui";
import { ProductImage } from "@/features/search/product-image";
import { clearCompareAction, removeFromCompareAction } from "./actions";
import { CompareTrayShell } from "./compare-tray-shell";
import { loadCompareListings, readCompareIds } from "./state";

/** Sticky compare tray, rendered by the site header on every page while the tray has products. */
export async function CompareTray() {
  const ids = await readCompareIds();
  if (!ids.length) return null;
  const listings = await loadCompareListings(ids);
  if (!listings.length) return null;
  return (
    <>
      <CompareTrayShell count={listings.length}>
        <div className="flex items-center gap-3">
          <ul className="flex flex-1 gap-2 overflow-x-auto">
            {listings.map((l) => (
              <li key={l.id} className="relative size-14 shrink-0 overflow-hidden rounded-lg border border-line bg-canvas sm:size-16">
                <ProductImage src={l.imageUrls[0]} sizes="64px" />
                <form action={removeFromCompareAction} className="absolute right-0 top-0">
                  <input type="hidden" name="listingId" value={l.id} />
                  <button type="submit" aria-label={`Remove ${l.title} from compare`} className="inline-flex size-6 items-center justify-center rounded-bl-lg bg-surface/95 text-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-brand-600">
                    <X className="size-3.5" aria-hidden />
                  </button>
                </form>
              </li>
            ))}
          </ul>
          <form action={clearCompareAction}>
            <button type="submit" className="min-h-10 px-2 text-xs font-medium text-muted underline hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-600">
              Clear
            </button>
          </form>
          {listings.length >= 2 ? (
            <Link href="/compare" className={buttonClasses("primary", "md", "shrink-0")}>
              Compare ({listings.length})
            </Link>
          ) : (
            <p className="hidden text-xs text-muted sm:block">Add one more to compare</p>
          )}
        </div>
      </CompareTrayShell>
    </>
  );
}

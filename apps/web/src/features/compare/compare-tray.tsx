"use client";
import { X } from "lucide-react";
import Link from "next/link";
import { buttonClasses } from "@cnote/ui";
import { ProductImage } from "@/features/search/product-image";
import { refreshUserState, useUserState } from "@/features/user-state/store";
import { clearCompareAction, removeFromCompareAction } from "./actions";
import { CompareTrayShell } from "./compare-tray-shell";

/**
 * Sticky compare tray shown on every page while the tray has products. Client island: the tray lives in a
 * cookie, so the static page can't know it. Content comes from the shared /api/me state.
 */
export function CompareTray() {
  const { compareItems: listings } = useUserState();
  if (!listings.length) return null;
  return (
    <CompareTrayShell count={listings.length}>
      <div className="flex items-center gap-3">
        <ul className="flex flex-1 gap-2 overflow-x-auto" aria-label="Products in your compare tray">
          {listings.map((l) => (
            <li key={l.id} className="relative size-14 shrink-0 overflow-hidden rounded-lg border border-line bg-canvas sm:size-16">
              <ProductImage src={l.image ?? undefined} sizes="64px" alt={l.title} />
              <form
                action={async (fd) => {
                  await removeFromCompareAction(fd);
                  await refreshUserState();
                }}
                className="absolute right-0 top-0"
              >
                <input type="hidden" name="listingId" value={l.id} />
                <button type="submit" aria-label={`Remove ${l.title} from compare`} className="inline-flex size-6 items-center justify-center rounded-bl-lg bg-surface/95 text-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-brand-600">
                  <X className="size-3.5" aria-hidden />
                </button>
              </form>
            </li>
          ))}
        </ul>
        <form
          action={async () => {
            await clearCompareAction();
            await refreshUserState();
          }}
        >
          <button type="submit" className="min-h-11 px-2 text-xs font-medium text-muted underline hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-600">
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
  );
}

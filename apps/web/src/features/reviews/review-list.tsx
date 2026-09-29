"use client";
import { useState } from "react";
import type { Page, PublicReview, ReviewSort } from "@cnote/reviews";
import { buttonClasses, cn } from "@cnote/ui";
import { ReviewCard } from "./review-card";

const SORTS: { value: ReviewSort; label: string }[] = [
  { value: "recent", label: "Most recent" },
  { value: "helpful", label: "Most helpful" },
  { value: "rating_high", label: "Highest rated" },
  { value: "rating_low", label: "Lowest rated" },
];

/**
 * Approved reviews. The first page (most recent) is server-rendered into the cached HTML; sorting and "more"
 * fetch public JSON pages, so the product page itself never depends on query strings and stays static.
 */
export function ReviewList({ listingId, initial }: { listingId: string; initial: Page<PublicReview> }) {
  const [sort, setSort] = useState<ReviewSort>("recent");
  const [page, setPage] = useState(initial);
  const [items, setItems] = useState(initial.items);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(nextSort: ReviewSort, cursor: string | null) {
    setBusy(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ sort: nextSort, ...(cursor ? { cursor } : {}) });
      const res = await fetch(`/api/reviews/${listingId}?${qs}`);
      if (!res.ok) throw new Error(String(res.status));
      const p = (await res.json()) as Page<PublicReview>;
      setPage(p);
      setItems((cur) => (cursor ? [...cur, ...p.items] : p.items));
      setSort(nextSort);
    } catch {
      setError("Couldn't load reviews. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!items.length) return null;
  return (
    <div>
      <div role="group" aria-label="Sort reviews" className="mb-2 flex flex-wrap gap-x-1 gap-y-1 text-sm">
        {SORTS.map((s) => (
          <button
            key={s.value}
            type="button"
            aria-pressed={s.value === sort}
            disabled={busy}
            onClick={() => void load(s.value, null)}
            className={cn("min-h-11 rounded-lg px-3 focus-visible:outline-2 focus-visible:outline-brand-600", s.value === sort ? "font-semibold text-brand-700" : "text-muted hover:text-ink")}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div aria-live="polite" aria-busy={busy}>
        {items.map((r) => (
          <ReviewCard key={r.id} review={r} listingId={listingId} />
        ))}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {page.nextCursor ? (
        <button type="button" disabled={busy} onClick={() => void load(sort, page.nextCursor)} className={buttonClasses("outline", "md", "mt-3")}>
          {busy ? "Loading…" : "More reviews"}
        </button>
      ) : null}
    </div>
  );
}

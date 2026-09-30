import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../cn";
import type { LinkComponent } from "./link";

/** Prev/next pagination; `hrefFor(page)` builds the URL so callers keep their own query params. */
export function Pagination({
  page,
  hasNext,
  hrefFor,
  linkComponent,
  className,
  labels,
}: {
  page: number;
  hasNext: boolean;
  hrefFor: (page: number) => string;
  linkComponent?: LinkComponent;
  className?: string;
  /** Translated strings; `page` uses the `{page}` placeholder. Defaults are English. */
  labels?: { nav?: string; previous?: string; next?: string; page?: string };
}) {
  const A = linkComponent ?? "a";
  const base =
    "inline-flex h-10 items-center gap-1 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";
  if (page <= 1 && !hasNext) return null;
  return (
    <nav aria-label={labels?.nav ?? "Pagination"} className={cn("flex items-center justify-center gap-3", className)}>
      {page > 1 ? (
        <A href={hrefFor(page - 1)} className={base} rel="prev">
          <ChevronLeft className="size-4" aria-hidden /> {labels?.previous ?? "Previous"}
        </A>
      ) : null}
      <span className="text-sm text-muted" aria-current="page">
        {(labels?.page ?? "Page {page}").replace("{page}", String(page))}
      </span>
      {hasNext ? (
        <A href={hrefFor(page + 1)} className={base} rel="next">
          {labels?.next ?? "Next"} <ChevronRight className="size-4" aria-hidden />
        </A>
      ) : null}
    </nav>
  );
}

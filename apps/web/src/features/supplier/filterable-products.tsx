"use client";
import { Fragment, useState, type ReactNode } from "react";
import { cn, Grid } from "@cnote/ui";

export interface FilterItem {
  id: string;
  categoryId: string;
  node: ReactNode;
}

/** Category filter chips (toggle buttons, aria-pressed) over server-rendered product cards; the count is announced politely. */
export function FilterableProducts({
  items,
  categories,
  labels,
}: {
  items: FilterItem[];
  categories: { id: string; name: string; count: number }[];
  labels: { filter: string; all: string; showing: Record<number, string> };
}) {
  const [cat, setCat] = useState<string | null>(null);
  const shown = cat ? items.filter((i) => i.categoryId === cat) : items;
  const chip = (on: boolean) =>
    cn(
      "inline-flex min-h-8 items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
      on ? "border-brand-600 bg-brand-100 text-brand-700" : "border-line bg-canvas text-ink hover:border-brand-200 hover:bg-brand-50",
    );
  return (
    <div>
      {categories.length > 1 ? (
        <div role="group" aria-label={labels.filter} className="mb-4 flex flex-wrap gap-2">
          <button type="button" aria-pressed={cat === null} onClick={() => setCat(null)} className={chip(cat === null)}>
            {labels.all} ({items.length})
          </button>
          {categories.map((c) => (
            <button key={c.id} type="button" aria-pressed={cat === c.id} onClick={() => setCat(c.id)} className={chip(cat === c.id)}>
              {c.name} ({c.count})
            </button>
          ))}
        </div>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">
        {labels.showing[shown.length] ?? ""}
      </p>
      <Grid>
        {shown.map((i) => (
          // Fragment, not a wrapper element: Grid is a <ul> and each card renders its own <li> (list semantics, axe "list").
          <Fragment key={i.id}>{i.node}</Fragment>
        ))}
      </Grid>
    </div>
  );
}

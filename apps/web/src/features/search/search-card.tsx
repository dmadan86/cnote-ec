"use client";
import { ArrowRight, Search, Sparkles } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { buttonClasses, Chip, cn } from "@cnote/ui";

const TABS = [
  { id: "ai", label: "AI Search", placeholder: "Search products, manufacturers, or ask anything..." },
  { id: "products", label: "Products", placeholder: "Search products, e.g. kraft boxes 3 ply" },
  { id: "manufacturers", label: "Manufacturers", placeholder: "Search manufacturers by name or product" },
  { id: "templates", label: "Templates", placeholder: "Search design templates" },
  { id: "services", label: "Business Services", placeholder: "Search business services" },
] as const;

/** Hero search card: tab selects the search mode, submits as GET /search?q=&tab= (works without JS for the default tab). */
export function SearchCard({ suggestions, initialTab = "ai" }: { suggestions: string[]; initialTab?: (typeof TABS)[number]["id"] }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>(initialTab);
  const current = TABS.find((t) => t.id === tab)!;
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-xl sm:p-5">
      <form action="/search" method="get" role="search">
        <input type="hidden" name="tab" value={tab} />
        <div role="group" aria-label="Search type" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={t.id === tab}
              onClick={() => setTab(t.id)}
              className={cn(
                "inline-flex min-h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
                t.id === tab ? "border-brand-100 bg-brand-100 text-brand-700" : "border-line bg-surface text-ink hover:bg-canvas",
              )}
            >
              {t.id === "ai" ? <Sparkles className="size-4" aria-hidden /> : null}
              {t.label}
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:rounded-xl sm:border sm:border-line sm:bg-surface sm:p-1.5 sm:pl-3 sm:focus-within:border-brand-500 sm:focus-within:ring-2 sm:focus-within:ring-brand-100">
          <Search className="hidden size-5 shrink-0 text-muted sm:block" aria-hidden />
          <label htmlFor="hero-q" className="sr-only">
            Search
          </label>
          <input
            id="hero-q"
            name="q"
            type="search"
            autoComplete="off"
            placeholder={current.placeholder}
            className="h-12 w-full rounded-lg border border-line bg-surface px-3 text-base text-ink placeholder:text-muted focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 sm:border-0 sm:px-0 sm:focus:ring-0"
          />
          <button type="submit" className={buttonClasses("primary", "lg", "shrink-0 rounded-lg sm:px-5")}>
            <Search className="size-4" aria-hidden /> Search <ArrowRight className="size-4" aria-hidden />
          </button>
        </div>
      </form>
      {suggestions.length ? (
        <div className="mt-4">
          <p className="text-xs text-muted" id="try-asking">
            Try asking:
          </p>
          <ul aria-labelledby="try-asking" className="mt-1.5 flex flex-wrap gap-2">
            {suggestions.slice(0, 5).map((s) => (
              <li key={s}>
                <Chip href={`/search?q=${encodeURIComponent(s)}&tab=ai`} linkComponent={Link}>
                  {s}
                </Chip>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

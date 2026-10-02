"use client";
import { Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState, type ReactNode } from "react";
import { LocaleLink } from "@/i18n/link";
import { matchesQuery } from "./articles";

export interface HelpSearchItem {
  id: string;
  href: string;
  title: string;
  summary: string;
  topicTitle: string;
}

/**
 * Landing-page search: filters the article list on the client (titles + summaries; the whole index is a few KB), so it
 * works without a request and stays usable on slow connections. While the box is empty the server-rendered `children`
 * (topic cards, popular articles) are shown; with a query they are replaced by the matches. Needs `help` messages.
 */
export function HelpSearch({ items, children }: { items: HelpSearchItem[]; children: ReactNode }) {
  const t = useTranslations("help");
  const [q, setQ] = useState("");
  const inputId = useId();
  const query = q.trim();
  const results = useMemo(() => (query ? items.filter((i) => matchesQuery(`${i.title} ${i.summary}`, query)) : []), [items, query]);

  return (
    <div>
      <form role="search" aria-label={t("searchLabel")} onSubmit={(e) => e.preventDefault()} className="mx-auto max-w-2xl">
        <label htmlFor={inputId} className="sr-only">
          {t("searchLabel")}
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted" aria-hidden />
          <input
            id={inputId}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("searchPlaceholder")}
            autoComplete="off"
            enterKeyHint="search"
            className="h-14 w-full rounded-full border border-line bg-surface pl-12 pr-14 text-base text-ink shadow-sm placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 [&::-webkit-search-cancel-button]:hidden"
          />
          {q ? (
            <button
              type="button"
              onClick={() => setQ("")}
              aria-label={t("clearSearch")}
              className="absolute right-2 top-1/2 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:bg-canvas hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-600"
            >
              <X className="size-5" aria-hidden />
            </button>
          ) : null}
        </div>
      </form>

      <p role="status" aria-live="polite" className="mt-3 text-center text-sm text-muted">
        {query ? (results.length ? t("resultsCount", { count: results.length }) : t("noResults")) : ""}
      </p>

      {query ? (
        results.length ? (
          <ul className="mx-auto mt-4 flex max-w-3xl flex-col gap-3" data-testid="help-results">
            {results.map((r) => (
              <li key={r.id}>
                <LocaleLink href={r.href} className="block rounded-card border border-line bg-surface p-4 hover:border-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">
                  <span className="block text-xs font-semibold uppercase tracking-wide text-brand-700">{r.topicTitle}</span>
                  <span className="mt-1 block text-base font-semibold text-ink">{r.title}</span>
                  <span className="mt-1 block text-sm text-muted">{r.summary}</span>
                </LocaleLink>
              </li>
            ))}
          </ul>
        ) : null
      ) : (
        children
      )}
    </div>
  );
}

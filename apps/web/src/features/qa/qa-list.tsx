"use client";
import type { PublicQuestion, QaPage } from "@cnote/reviews";
import { Alert, Badge, Button, EmptyState, Input } from "@cnote/ui";
import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { QaReactions } from "./reactions";

/**
 * Answered questions of a product. The first page arrives server-rendered (it is in the static HTML for crawlers and
 * screen-reader users without JS); search and "show more" call the public /api/qa/<id> route.
 */
export function QaList({ listingId, initial }: { listingId: string; initial: QaPage }) {
  const t = useTranslations("qa");
  const locale = useLocale();
  const [page, setPage] = useState<QaPage>(initial);
  const [items, setItems] = useState<PublicQuestion[]>(initial.items);
  const [applied, setApplied] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const searchId = useId();

  const date = (iso: string) => new Date(iso).toLocaleDateString(locale === "hi" ? "hi-IN" : "en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

  async function load(q: string, cursor: string | null) {
    setBusy(true);
    setFailed(false);
    try {
      const qs = new URLSearchParams();
      if (q) qs.set("q", q);
      if (cursor) qs.set("cursor", cursor);
      const res = await fetch(`/api/qa/${listingId}?${qs}`);
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as QaPage;
      setPage(next);
      setItems((prev) => (cursor ? [...prev, ...next.items] : next.items));
      setApplied(q);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void load(draft.trim(), null);
  };
  const clear = () => {
    setDraft("");
    void load("", null);
    document.getElementById(searchId)?.focus();
  };

  const showSearch = initial.total > 0 || applied !== "";
  return (
    <div className="space-y-4">
      {showSearch ? (
        <form role="search" onSubmit={submitSearch} className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-64">
            <label htmlFor={searchId} className="mb-1 block text-sm font-medium text-ink">{t("searchLabel")}</label>
            <Input id={searchId} type="search" name="q" value={draft} maxLength={80} onChange={(e) => setDraft(e.target.value)} placeholder={t("searchPlaceholder")} />
          </div>
          <Button type="submit" variant="outline-brand" disabled={busy}>{t("searchBtn")}</Button>
          {applied ? <Button type="button" variant="ghost" onClick={clear}>{t("clearSearch")}</Button> : null}
        </form>
      ) : null}

      <p role="status" aria-live="polite" className="text-sm text-muted">
        {busy ? t("loading") : showSearch ? (applied ? t("resultCount", { count: page.total, q: applied }) : t("count", { count: page.total })) : ""}
      </p>
      {failed ? <Alert tone="warning">{t("loadError")}</Alert> : null}

      {items.length === 0 && !busy ? (
        applied ? <EmptyState title={t("noResultsTitle", { q: applied })} description={t("noResultsDesc")} /> : <EmptyState title={t("emptyTitle")} description={t("emptyDesc")} />
      ) : (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface">
          {items.map((q) => (
            <li key={q.id} className="space-y-3 p-4">
              <article aria-label={q.body.slice(0, 80)} className="space-y-3">
                <div>
                  <p className="text-sm font-semibold text-ink"><span className="sr-only">{t("questionLabel")}: </span>{q.body}</p>
                  <p className="mt-0.5 text-xs text-muted">{t("asked", { date: date(q.askedAt) })}</p>
                </div>
                <div className="space-y-1 border-l-2 border-brand-100 pl-3">
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <Badge tone="brand">{t("sellerAnswer")}</Badge>
                    <span>{t("answerFrom", { seller: q.answer.sellerName })}</span>
                    <time dateTime={q.answer.answeredAt}>{date(q.answer.answeredAt)}</time>
                  </p>
                  <p className="whitespace-pre-wrap text-sm text-ink"><span className="sr-only">{t("answerLabel")}: </span>{q.answer.body}</p>
                </div>
                <QaReactions listingId={listingId} answerId={q.answer.id} questionId={q.id} helpfulCount={q.answer.helpfulCount} />
              </article>
            </li>
          ))}
        </ul>
      )}

      {page.nextCursor ? (
        <Button type="button" variant="outline" disabled={busy} onClick={() => void load(applied, page.nextCursor)}>{busy ? t("loading") : t("loadMore")}</Button>
      ) : null}
    </div>
  );
}

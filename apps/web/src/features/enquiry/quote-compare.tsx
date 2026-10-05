"use client";
// Side-by-side quote comparison (ADR-002 transparency: "Sent to N suppliers; you are seeing quotes from M").
// Desktop: one table row per supplier. Mobile: stacked cards in a swipeable (scroll-snap) strip. Both read the same rows,
// so sort, "best" marks and shortlist state always agree. "Best" is a word plus a star, never colour alone.
import type { ComparisonRow, DecideQuoteResult, QuoteComparison } from "@cnote/enquiry";
import type { QuoteLandedRow } from "@cnote/logistics";
import type { ActionResult } from "@cnote/next-kit";
import { Badge, Button, Money, TrustBadge, buttonClasses, cn } from "@cnote/ui";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useActionState, useId, useMemo, useRef, useState } from "react";
import { formatDate, isLocale } from "@/i18n/config";
import { quoteDecisionAction, shortlistQuoteAction } from "./actions";
import { bestByColumn, SORT_KEYS, sortRows, type BestColumn, type SortKey } from "./compare-logic";
import { LineMatrix } from "./line-matrix";
import { trustLabels } from "./trust-labels";

type T = ReturnType<typeof useTranslations>;
// WCAG 2.2 AA target size: 44px on touch layouts, the compact 32px button from md up.
const TOUCH = "min-h-11 md:min-h-8";

function Best({ show, column, t }: { show: boolean; column: string; t: T }) {
  if (!show) return null;
  return (
    <Badge tone="success" className="ml-1.5 align-middle">
      <span aria-hidden="true">★ </span>
      {t("best")}
      <span className="sr-only"> ({t("bestFor", { column })})</span>
    </Badge>
  );
}

function QuoteActions({ row, enquiryId, t }: { row: ComparisonRow; enquiryId: string; t: T }) {
  const ta = useTranslations("approvals");
  const [dec, decide, deciding] = useActionState<ActionResult<DecideQuoteResult> | null, FormData>(quoteDecisionAction, null);
  const awaiting = row.approval?.status === "pending" || (dec?.ok && dec.data.status === "pending_approval");
  const requestId = row.approval?.requestId ?? (dec?.ok ? dec.data.requestId : null);
  const [sl, shortlist, shortlisting] = useActionState<ActionResult | null, FormData>(shortlistQuoteAction, null);
  const msg = (dec && !dec.ok ? dec.error : null) ?? (sl && !sl.ok ? sl.error : null);
  const done = dec?.ok ? (dec.data.status === "pending_approval" ? ta("badge.sentForApproval") : row.decision === "won" ? t("acceptedToast") : t("declinedToast")) : null;
  const seller = row.sellerName;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {row.decision === "won" ? (
          <Badge tone="success">{t("accepted")}</Badge>
        ) : awaiting ? (
          <Badge tone="warning">
            {ta("badge.awaiting")}
            {requestId ? <Link href={`/buyer/approvals/${requestId}`} className="ms-1 underline">{ta("badge.view")}<span className="sr-only"> ({seller})</span></Link> : null}
          </Badge>
        ) : (
          <form action={decide}>
            <input type="hidden" name="enquiryId" value={enquiryId} />
            <input type="hidden" name="quoteId" value={row.quote.id} />
            <input type="hidden" name="decision" value="accept" />
            <Button type="submit" variant="accent" size="sm" className={TOUCH} disabled={deciding} aria-label={t("acceptFor", { seller })}>{t("accept")}</Button>
          </form>
        )}
        {row.decision === "lost" ? (
          <Badge tone="neutral">{t("declined")}</Badge>
        ) : row.decision === "won" ? null : (
          <form action={decide}>
            <input type="hidden" name="enquiryId" value={enquiryId} />
            <input type="hidden" name="quoteId" value={row.quote.id} />
            <input type="hidden" name="decision" value="decline" />
            <Button type="submit" variant="outline" size="sm" className={TOUCH} disabled={deciding} aria-label={t("declineFor", { seller })}>{t("decline")}</Button>
          </form>
        )}
        <form action={shortlist}>
          <input type="hidden" name="enquiryId" value={enquiryId} />
          <input type="hidden" name="quoteId" value={row.quote.id} />
          <input type="hidden" name="shortlisted" value={String(!row.quote.shortlisted)} />
          <Button type="submit" variant="outline" size="sm" className={TOUCH} disabled={shortlisting} aria-pressed={row.quote.shortlisted} aria-label={t("shortlistFor", { seller })}>
            <span aria-hidden="true">{row.quote.shortlisted ? "★ " : "☆ "}</span>
            {row.quote.shortlisted ? t("shortlisted") : t("shortlist")}
          </Button>
        </form>
        <Link href={`/conversations/${row.conversationId}`} className={buttonClasses("outline", "sm", TOUCH)} aria-label={t("messageFor", { seller })}>
          {t("message")}
        </Link>
      </div>
      <p role="status" className={cn("text-xs", msg ? "text-danger" : "text-muted")}>{msg ?? done}</p>
    </div>
  );
}

function Attachments({ row, t }: { row: ComparisonRow; t: T }) {
  if (!row.quote.attachments.length) return <span className="text-muted">{t("notStated")}</span>;
  return (
    <ul className="flex flex-col gap-1">
      {row.quote.attachments.map((a) => (
        <li key={a.id}>
          <a href={`/api/rfq-attachments/${a.id}`} className="break-all text-brand-700 underline" download>
            {a.fileName}
            <span className="sr-only"> ({t("downloadHint")})</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function Notes({ row, t, unit }: { row: ComparisonRow; t: T; unit: string }) {
  const q = row.quote;
  const bits = [
    q.notes,
    q.deliveryNote,
    q.paymentNote,
    q.moq ? t("moq", { qty: q.moq, unit: q.moqUnit ?? unit }) : null,
    q.gstIncluded === null ? null : q.gstIncluded ? t("gstIncluded") : t("gstExtra"),
    row.earlierQuotes ? t("earlier", { count: row.earlierQuotes }) : null,
  ].filter((x): x is string => !!x);
  if (!bits.length) return <span className="text-muted">{t("notStated")}</span>;
  return (
    <ul className="flex list-none flex-col gap-1">
      {bits.map((b, i) => (
        <li key={i} className="whitespace-pre-wrap break-words">{b}</li>
      ))}
    </ul>
  );
}

/** Landed cost (goods + GST + freight) with the reason for every assumption in words, never colour alone. */
function LandedCell({ l, tf }: { l: QuoteLandedRow | undefined; tf: T }) {
  if (!l) return <span className="text-muted">{tf("cmpNone")}</span>;
  const inr = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  const notes: string[] = [];
  if (l.freightSource === "quoted") notes.push(tf("cmpQuoted"));
  else if (l.freightSource === "estimated" && l.estimate) notes.push(tf("cmpEstimated", { low: inr(l.estimate.lowPaise), high: inr(l.estimate.highPaise) }));
  else notes.push(tf("cmpNone"));
  if (l.goodsGstAssumed) notes.push(tf("cmpGstAssumed"));
  if (l.gstUnknown) notes.push(tf("cmpGstUnknown"));
  return (
    <div data-testid="landed-cell">
      <p className="font-semibold text-ink">{l.lowPaise === l.highPaise ? inr(l.lowPaise) : tf("cmpRange", { low: inr(l.lowPaise), high: inr(l.highPaise) })}</p>
      <ul className="mt-1 list-none space-y-0.5 text-xs text-muted">
        {notes.map((n) => (<li key={n}>{n}</li>))}
      </ul>
    </div>
  );
}

export function QuoteCompare({ comparison, landed }: { comparison: QuoteComparison; landed?: Record<string, QuoteLandedRow> }) {
  const t = useTranslations("rfq2.compare");
  const tf = useTranslations("freight");
  const tc = useTranslations("cards");
  const tl = useTranslations("rfqLines.matrix");
  const locale = useLocale();
  const loc = isLocale(locale) ? locale : "en";
  const labels = trustLabels(tc);
  const [sort, setSort] = useState<SortKey>("rank");
  const [onlyShort, setOnlyShort] = useState(false);
  const sortId = useId();
  const strip = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => sortRows(comparison.rows, sort), [comparison.rows, sort]);
  const best = useMemo(() => bestByColumn(comparison.rows), [comparison.rows]);
  const shown = onlyShort ? rows.filter((r) => r.quote.shortlisted) : rows;
  const unit = comparison.quantityUnit ?? "";
  const date = (d: string | null) => (d ? formatDate(d, loc, { day: "numeric", month: "short", year: "numeric" }) : t("notStated"));
  const days = (n: number | null) => (n === null ? t("notStated") : t("days", { count: n }));
  const isBest = (col: BestColumn, r: ComparisonRow) => best[col].has(r.matchId);
  const col = {
    rank: t("rank"), price: t("unitPrice"), total: t("total", { qty: comparison.quantity ?? "", unit }).trim(), leadTime: t("leadTime"), tier: t("tier"),
  };
  const totalHead = (r: ComparisonRow | undefined) =>
    r?.quantityBasis === "quoted" ? t("totalQuoted", { qty: r.quantity, unit: r.quote.unit }) : t("total", { qty: comparison.quantity ?? "", unit });

  const scroll = (dir: 1 | -1) => {
    const el = strip.current;
    if (!el) return;
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <section aria-labelledby="compare-heading" className="flex flex-col gap-3">
      <h2 id="compare-heading" className="text-lg font-bold text-ink">{t("title")}</h2>
      <div className="rounded-lg border border-line bg-surface p-3 text-sm">
        <p className="font-medium text-ink" data-testid="quote-transparency">{t("transparency", { sent: comparison.sentTo, seen: comparison.quotesFrom })}</p>
        <p className="mt-1 text-xs text-muted">{t("transparencyHelp")}</p>
      </div>

      {comparison.rows.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface p-6 text-sm text-muted">
          {comparison.expiresAt ? t("empty", { date: date(comparison.expiresAt) }) : t("emptyNoDate")}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <div className="flex flex-col gap-1">
              <label htmlFor={sortId} className="text-sm font-medium text-ink">{t("sortLabel")}</label>
              <select
                id={sortId}
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="h-11 rounded-lg border border-line bg-surface px-3 text-sm text-ink sm:h-10"
              >
                {SORT_KEYS.map((k) => (
                  <option key={k} value={k}>{t(`sort.${k}`)}</option>
                ))}
              </select>
            </div>
            <label className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-10">
              <input type="checkbox" className="size-5 accent-brand-600" checked={onlyShort} onChange={(e) => setOnlyShort(e.target.checked)} />
              {t("shortlistedOnly")}
            </label>
            <p className="text-xs text-muted">{t("bestLegend")}</p>
          </div>
          <p role="status" className="sr-only">{t("sortedBy", { sort: t(`sort.${sort}`) })}</p>

          {shown.length === 0 ? <p className="text-sm text-muted" role="status">{t("noShortlisted")}</p> : null}

          {shown.length ? (
            <>
              {/* Desktop / tablet: table */}
              <div className="hidden md:block">
                <div role="region" aria-label={t("caption")} tabIndex={0} className="overflow-x-auto rounded-lg border border-line focus-visible:outline-2 focus-visible:outline-brand-600">
                  <table className="w-full min-w-[60rem] border-collapse text-left text-sm">
                    <caption className="sr-only">{t("caption")}</caption>
                    <thead className="bg-canvas text-xs text-muted">
                      <tr>
                        <th scope="col" className="px-3 py-2 font-semibold">{t("supplier")}</th>
                        <th scope="col" className="px-3 py-2 font-semibold">{t("tier")}</th>
                        <th scope="col" className="px-3 py-2 font-semibold">{t("rank")}</th>
                        <th scope="col" className="px-3 py-2 font-semibold">{t("unitPrice")}</th>
                        <th scope="col" className="px-3 py-2 font-semibold">{totalHead(shown[0])}</th>
                        {landed ? <th scope="col" className="px-3 py-2 font-semibold">{tf("cmpHead")}</th> : null}
                        <th scope="col" className="px-3 py-2 font-semibold">{t("leadTime")}</th>
                        <th scope="col" className="px-3 py-2 font-semibold">{t("validity")}</th>
                        <th scope="col" className="px-3 py-2 font-semibold">{t("payment")}</th>
                        <th scope="col" className="px-3 py-2 font-semibold">{t("attachments")}</th>
                        <th scope="col" className="px-3 py-2 font-semibold">{t("notes")}</th>
                        <th scope="col" className="px-3 py-2 font-semibold">{t("actions")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r) => (
                        <tr key={r.matchId} className="border-t border-line align-top" data-testid="quote-row">
                          <th scope="row" className="px-3 py-3 font-semibold text-ink">
                            {r.sellerName}
                            {r.quote.shortlisted ? <Badge tone="brand" className="ml-1.5">{t("shortlisted")}</Badge> : null}
                          </th>
                          <td className="px-3 py-3">
                            <TrustBadge tier={r.verificationTier} badgeActive={r.badgeActive} labels={labels} />
                            <Best show={isBest("tier", r)} column={col.tier} t={t} />
                          </td>
                          <td className="px-3 py-3">
                            {t("rankOf", { rank: r.rank, of: r.of })}
                            <Best show={isBest("rank", r)} column={col.rank} t={t} />
                          </td>
                          <td className="px-3 py-3">
                            {r.coverage ? <span>{tl("perLineQuote", { quoted: r.coverage.quoted, of: r.coverage.of })}</span> : <Money paise={r.quote.pricePaise} unit={r.quote.unit} />}
                            <Best show={isBest("price", r)} column={col.price} t={t} />
                            {r.quote.deliveryChargePaise ? <p className="text-xs text-muted">{t("delivery", { amount: `₹${(r.quote.deliveryChargePaise / 100).toLocaleString("en-IN")}` })}</p> : null}
                          </td>
                          <td className="px-3 py-3">
                            <Money paise={r.totalPaise} />
                            <Best show={isBest("total", r)} column={col.total} t={t} />
                          </td>
                          {landed ? <td className="max-w-56 px-3 py-3"><LandedCell l={landed[r.matchId]} tf={tf} /></td> : null}
                          <td className="px-3 py-3">
                            {days(r.quote.leadTimeDays)}
                            <Best show={isBest("leadTime", r)} column={col.leadTime} t={t} />
                          </td>
                          <td className="px-3 py-3">{date(r.quote.validUntil)}</td>
                          <td className="px-3 py-3">{r.quote.paymentTerms ? t(`paymentTerms.${r.quote.paymentTerms}`) : t("notStated")}</td>
                          <td className="px-3 py-3"><Attachments row={r} t={t} /></td>
                          <td className="max-w-56 px-3 py-3"><Notes row={r} t={t} unit={unit} /></td>
                          <td className="px-3 py-3"><QuoteActions row={r} enquiryId={comparison.enquiryId} t={t} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Mobile: stacked cards, swipe or use the buttons */}
              <div className="md:hidden">
                <p className="mb-2 text-xs text-muted">{t("swipeHint")}</p>
                <div
                  ref={strip}
                  role="region"
                  aria-label={t("caption")}
                  tabIndex={0}
                  className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 focus-visible:outline-2 focus-visible:outline-brand-600"
                >
                  {shown.map((r, i) => (
                    <article key={r.matchId} aria-label={t("cardOf", { n: i + 1, total: shown.length })} className="w-[85%] shrink-0 snap-center rounded-card border border-line bg-surface p-4" data-testid="quote-card">
                      <h3 className="font-semibold text-ink">
                        {r.sellerName}
                        {r.quote.shortlisted ? <Badge tone="brand" className="ml-1.5">{t("shortlisted")}</Badge> : null}
                      </h3>
                      <p className="mt-1 text-xs text-muted">{t("cardOf", { n: i + 1, total: shown.length })}</p>
                      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                        <dt className="text-muted">{t("tier")}</dt>
                        <dd><TrustBadge tier={r.verificationTier} badgeActive={r.badgeActive} labels={labels} /><Best show={isBest("tier", r)} column={col.tier} t={t} /></dd>
                        <dt className="text-muted">{t("rank")}</dt>
                        <dd>{t("rankOf", { rank: r.rank, of: r.of })}<Best show={isBest("rank", r)} column={col.rank} t={t} /></dd>
                        <dt className="text-muted">{t("unitPrice")}</dt>
                        <dd>{r.coverage ? <span>{tl("perLineQuote", { quoted: r.coverage.quoted, of: r.coverage.of })}</span> : <Money paise={r.quote.pricePaise} unit={r.quote.unit} />}<Best show={isBest("price", r)} column={col.price} t={t} /></dd>
                        <dt className="text-muted">{totalHead(r)}</dt>
                        <dd><Money paise={r.totalPaise} /><Best show={isBest("total", r)} column={col.total} t={t} /></dd>
                        {landed ? (<><dt className="text-muted">{tf("cmpHead")}</dt><dd><LandedCell l={landed[r.matchId]} tf={tf} /></dd></>) : null}
                        <dt className="text-muted">{t("leadTime")}</dt>
                        <dd>{days(r.quote.leadTimeDays)}<Best show={isBest("leadTime", r)} column={col.leadTime} t={t} /></dd>
                        <dt className="text-muted">{t("validity")}</dt>
                        <dd>{date(r.quote.validUntil)}</dd>
                        <dt className="text-muted">{t("payment")}</dt>
                        <dd>{r.quote.paymentTerms ? t(`paymentTerms.${r.quote.paymentTerms}`) : t("notStated")}</dd>
                        <dt className="text-muted">{t("attachments")}</dt>
                        <dd><Attachments row={r} t={t} /></dd>
                        <dt className="text-muted">{t("notes")}</dt>
                        <dd><Notes row={r} t={t} unit={unit} /></dd>
                      </dl>
                      <div className="mt-4"><QuoteActions row={r} enquiryId={comparison.enquiryId} t={t} /></div>
                    </article>
                  ))}
                </div>
                {shown.length > 1 ? (
                  <div className="mt-2 flex gap-2">
                    <button type="button" onClick={() => scroll(-1)} className={buttonClasses("outline", "md", "min-h-11")}>{t("prev")}</button>
                    <button type="button" onClick={() => scroll(1)} className={buttonClasses("outline", "md", "min-h-11")}>{t("next")}</button>
                  </div>
                ) : null}
              </div>
              <p className="text-xs text-muted">{t("totalNote")} {t("acceptNote")}{landed ? ` ${tf("cmpNote")}` : ""}</p>
              {comparison.lines.length > 1 && comparison.rows.some((r) => r.quote.lines?.length) ? <LineMatrix comparison={comparison} /> : null}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

"use client";
// Line-by-line quote matrix for a multi-line RFQ (docs/design/rfq-multiline.md): rows = requirement lines, columns = suppliers, the lowest
// payable per line is marked with the word "Lowest" and a star (never colour alone), and the buyer awards each line to one supplier.
// Desktop: a real table. Mobile: one card per line with the suppliers as a radio group. Both views read the same selection state and the form
// posts hidden `award` fields built from it, so the two layouts can never disagree. Amounts shown are the server-computed line totals;
// the server recomputes everything when awarding.
import type { ComparisonRow, QuoteComparison } from "@cnote/enquiry";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Badge, Button, Money } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useActionState, useId, useMemo, useState } from "react";
import { awardLinesAction } from "./actions";

type T = ReturnType<typeof useTranslations>;
type Cell = { row: ComparisonRow; line: NonNullable<ComparisonRow["quote"]["lines"]>[number] | null };

function cellOf(row: ComparisonRow, lineId: string): Cell {
  return { row, line: row.quote.lines?.find((l) => l.enquiryLineId === lineId) ?? null };
}

function CellBody({ cell, lowest, t }: { cell: Cell; lowest: boolean; t: T }) {
  const l = cell.line;
  if (!l) return <span className="text-muted">{t("skipped")}</span>;
  if (l.cantSupply || l.unitPricePaise === null) return <span className="text-muted">{t("cantSupply")}</span>;
  return (
    <span className="flex flex-col gap-0.5">
      <span>
        <Money paise={l.unitPricePaise} />
        {lowest ? (
          <Badge tone="success" className="ml-1.5 align-middle">
            <span aria-hidden="true">★ </span>
            {t("lowest")}
          </Badge>
        ) : null}
      </span>
      <span className="text-xs text-muted">{t("lineTotal", { amount: `₹${((l.lineTotalPaise ?? 0) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}` })}</span>
      {l.gstRatePct !== null ? <span className="text-xs text-muted">{t("gst", { rate: l.gstRatePct })}</span> : null}
      {l.leadTimeDays !== null ? <span className="text-xs text-muted">{t("leadDays", { count: l.leadTimeDays })}</span> : null}
      {l.notes ? <span className="text-xs text-muted">{l.notes}</span> : null}
    </span>
  );
}

export function LineMatrix({ comparison }: { comparison: QuoteComparison }) {
  const t = useTranslations("rfqLines.matrix");
  const uid = useId();
  const rows = useMemo(() => comparison.rows.filter((r) => r.quote.lines?.length), [comparison.rows]);
  const awarded = useMemo(() => new Map(comparison.awards.map((a) => [a.enquiryLineId, a])), [comparison.awards]);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [state, action, pending] = useActionState<ActionResult<{ orders: number }> | null, FormData>(awardLinesAction, null);
  const bySupplierQuote = useMemo(() => new Map(rows.map((r) => [r.quote.id, r])), [rows]);

  const selected = Object.entries(pick).filter(([lineId, qid]) => qid && !awarded.has(lineId) && bySupplierQuote.has(qid));
  const perSupplier = new Map<string, { name: string; total: number; lines: number }>();
  for (const [lineId, qid] of selected) {
    const r = bySupplierQuote.get(qid)!;
    const l = cellOf(r, lineId).line;
    const cur = perSupplier.get(qid) ?? { name: r.sellerName, total: 0, lines: 0 };
    perSupplier.set(qid, { ...cur, total: cur.total + (l?.lineTotalPaise ?? 0), lines: cur.lines + 1 });
  }
  const grand = [...perSupplier.values()].reduce((s, x) => s + x.total, 0);
  const sellerName = (qid: string) => bySupplierQuote.get(qid)?.sellerName ?? "";
  const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  const choose = (lineId: string, qid: string) => setPick((p) => ({ ...p, [lineId]: qid }));

  if (!rows.length) return null;
  // Suppliers that already hold an order can't be awarded more lines: their radios are disabled with a reason.
  const lockedQuote = (qid: string) => comparison.awards.some((a) => a.quoteId === qid);

  const radio = (view: string, lineId: string, ordinal: number, itemName: string, r: ComparisonRow) => {
    const cell = cellOf(r, lineId);
    const priced = !!cell.line && !cell.line.cantSupply && cell.line.unitPricePaise !== null;
    const done = awarded.has(lineId);
    const disabled = !priced || done || lockedQuote(r.quote.id);
    const id = `${uid}-${view}-${lineId}-${r.quote.id}`;
    return (
      <label htmlFor={id} className={`flex min-h-11 items-center gap-2 text-sm ${disabled ? "text-muted" : "text-ink"}`}>
        <input
          id={id}
          type="radio"
          name={`${uid}-${view}-${lineId}`}
          className="size-5 accent-brand-600"
          checked={pick[lineId] === r.quote.id}
          disabled={disabled}
          onChange={() => choose(lineId, r.quote.id)}
        />
        <span className="sr-only">{t("awardLineTo", { n: ordinal, item: itemName, seller: r.sellerName })}</span>
        <span aria-hidden="true">{t("award")}</span>
      </label>
    );
  };

  return (
    <section aria-labelledby={`${uid}-h`} className="flex flex-col gap-3" data-testid="line-matrix">
      <h3 id={`${uid}-h`} className="text-base font-bold text-ink">{t("title")}</h3>
      <p className="text-sm text-muted">{t("intro")}</p>

      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="enquiryId" value={comparison.enquiryId} />
        {selected.map(([lineId, qid]) => <input key={lineId} type="hidden" name="award" value={`${lineId}:${qid}`} />)}

        {/* Desktop / tablet */}
        <div className="hidden md:block">
          <div role="region" aria-label={t("caption")} tabIndex={0} className="overflow-x-auto rounded-lg border border-line focus-visible:outline-2 focus-visible:outline-brand-600">
            <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
              <caption className="sr-only">{t("caption")}</caption>
              <thead className="bg-canvas text-xs text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-semibold">{t("item")}</th>
                  {rows.map((r) => (
                    <th key={r.quote.id} scope="col" className="px-3 py-2 font-semibold">
                      {r.sellerName}
                      <span className="block font-normal">{r.coverage ? t("coverage", { quoted: r.coverage.quoted, of: r.coverage.of }) : null}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {comparison.lines.map((line) => {
                  const win = new Set(comparison.lowestByLine[line.id] ?? []);
                  const a = awarded.get(line.id);
                  return (
                    <tr key={line.id} className="border-t border-line align-top" data-testid="matrix-row">
                      <th scope="row" className="px-3 py-3 font-medium text-ink">
                        <span className="text-muted">{line.ordinal}.</span> {line.itemName}
                        <span className="block text-xs font-normal text-muted">{t("qty", { qty: line.quantity, unit: line.unit })}</span>
                        {line.spec ? <span className="block text-xs font-normal text-muted">{line.spec}</span> : null}
                        {a ? <Badge tone="success" className="mt-1">{t("awardedTo", { seller: rows.find((r) => r.quote.id === a.quoteId)?.sellerName ?? "" })}</Badge> : null}
                      </th>
                      {rows.map((r) => (
                        <td key={r.quote.id} className="px-3 py-3">
                          <CellBody cell={cellOf(r, line.id)} lowest={win.has(r.quote.id) && rows.length > 1} t={t} />
                          <div className="mt-1">{radio("d", line.id, line.ordinal, line.itemName, r)}</div>
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-canvas">
                <tr className="border-t border-line">
                  <th scope="row" className="px-3 py-2 text-xs font-semibold text-muted">{t("quoteTotal")}</th>
                  {rows.map((r) => (
                    <td key={r.quote.id} className="px-3 py-2 text-sm"><Money paise={r.quote.lineTotals?.totalPaise ?? r.totalPaise} /></td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        {/* Mobile: one card per line */}
        <ol className="flex flex-col gap-3 md:hidden">
          {comparison.lines.map((line) => {
            const win = new Set(comparison.lowestByLine[line.id] ?? []);
            const a = awarded.get(line.id);
            return (
              <li key={line.id}>
                <fieldset className="rounded-card border border-line bg-surface p-3">
                  <legend className="px-1 text-sm font-semibold text-ink">{line.ordinal}. {line.itemName}</legend>
                  <p className="text-xs text-muted">{t("qty", { qty: line.quantity, unit: line.unit })}</p>
                  {a ? <Badge tone="success" className="mt-1">{t("awardedTo", { seller: rows.find((r) => r.quote.id === a.quoteId)?.sellerName ?? "" })}</Badge> : null}
                  <ul className="mt-2 flex flex-col gap-3">
                    {rows.map((r) => (
                      <li key={r.quote.id} className="flex items-start justify-between gap-3 border-t border-line pt-2">
                        <div className="min-w-0">
                          <p className="font-medium text-ink">{r.sellerName}</p>
                          <CellBody cell={cellOf(r, line.id)} lowest={win.has(r.quote.id) && rows.length > 1} t={t} />
                        </div>
                        {radio("m", line.id, line.ordinal, line.itemName, r)}
                      </li>
                    ))}
                  </ul>
                </fieldset>
              </li>
            );
          })}
        </ol>

        <div className="rounded-lg border border-line bg-surface p-3 text-sm" aria-live="polite" data-testid="award-summary">
          {selected.length ? (
            <>
              <p className="font-medium text-ink">{t("summary", { lines: selected.length, suppliers: perSupplier.size, total: rupees(grand) })}</p>
              <ul className="mt-1 list-disc pl-5 text-muted">
                {[...perSupplier.entries()].map(([qid, s]) => <li key={qid}>{t("summaryRow", { seller: sellerName(qid), lines: s.lines, total: rupees(s.total) })}</li>)}
              </ul>
              <p className="mt-1 text-xs text-muted">{t("oneOrderEach")}</p>
            </>
          ) : (
            <p className="text-muted">{t("nothingSelected")}</p>
          )}
        </div>
        {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
        {state?.ok ? <Alert tone="success">{t("done", { count: state.data.orders })}</Alert> : null}
        <div>
          <Button type="submit" variant="accent" disabled={pending || selected.length === 0}>{pending ? t("awarding") : t("awardSelected", { count: selected.length })}</Button>
        </div>
      </form>
    </section>
  );
}

"use client";
// Per-line price inputs of a multi-line RFQ quote (docs/design/rfq-multiline.md). One card per requirement line; a line left empty is skipped
// (partial quotes are fine), "can't supply" marks it explicitly. The estimate below is only a convenience: the server computes the real totals.
import type { EnquiryLineView } from "@cnote/enquiry";
import { Field, Input, Select } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";

const GST_RATES = [0, 5, 12, 18, 28];
type Entry = { price: string; gst: string; cant: boolean };

export function LineQuoteFields({ lines }: { lines: EnquiryLineView[] }) {
  const t = useTranslations("rfqLines");
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const get = (id: string): Entry => entries[id] ?? { price: "", gst: "", cant: false };
  const set = (id: string, p: Partial<Entry>) => setEntries((s) => ({ ...s, [id]: { ...get(id), ...p } }));

  let quoted = 0;
  let totalPaise = 0;
  for (const l of lines) {
    const e = get(l.id);
    const price = Number(e.price);
    if (e.cant || !e.price.trim() || !Number.isFinite(price) || price <= 0) continue;
    quoted++;
    const gross = Math.round(price * 100) * l.quantity;
    const rate = e.gst === "" ? 0 : Number(e.gst);
    totalPaise += gross + Math.round((gross * rate) / 100); // estimate: GST on top; the server applies the quote's GST-included setting
  }

  return (
    <div className="space-y-4" data-testid="line-quote-fields">
      <input type="hidden" name="multiLine" value="1" />
      <div>
        <h3 className="text-sm font-semibold text-ink">{t("formTitle")}</h3>
        <p className="text-sm text-muted">{t("formIntro")}</p>
      </div>
      <ol className="space-y-4">
        {lines.map((l) => {
          const e = get(l.id);
          const n = l.ordinal;
          return (
            <li key={l.id}>
              <fieldset className="space-y-3 rounded-lg border border-line p-3">
                <legend className="px-1 text-sm font-semibold text-ink">{t("lineN", { n, item: l.itemName })}</legend>
                <p className="text-xs text-muted">
                  {t("lineQty", { qty: l.quantity, unit: l.unit })}
                  {l.spec ? ` · ${l.spec}` : ""}
                  {l.hsn ? ` · ${t("hsn", { hsn: l.hsn })}` : ""}
                  {l.targetPricePaise ? ` · ${t("target", { price: `₹${(l.targetPricePaise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}` })}` : ""}
                </p>
                <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
                  <input type="checkbox" name={`lc_${n}`} className="size-5 accent-brand-600" checked={e.cant} onChange={(ev) => set(l.id, { cant: ev.target.checked })} />
                  {t("cantSupply")}
                </label>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label={t("price", { unit: l.unit })} htmlFor={`lp-${n}`} hint={e.cant ? undefined : t("skipHint")}>
                    <Input id={`lp-${n}`} name={`lp_${n}`} inputMode="decimal" className="h-11" disabled={e.cant} value={e.cant ? "" : e.price} onChange={(ev) => set(l.id, { price: ev.target.value })} />
                  </Field>
                  <Field label={t("gstRate")} htmlFor={`lg-${n}`}>
                    <Select id={`lg-${n}`} name={`lg_${n}`} className="h-11" disabled={e.cant} value={e.gst} onChange={(ev) => set(l.id, { gst: ev.target.value })}>
                      <option value="">{t("gstNone")}</option>
                      {GST_RATES.map((r) => <option key={r} value={r}>{r}%</option>)}
                    </Select>
                  </Field>
                  <Field label={t("leadTime")} htmlFor={`ll-${n}`}>
                    <Input id={`ll-${n}`} name={`ll_${n}`} inputMode="numeric" className="h-11" disabled={e.cant} />
                  </Field>
                </div>
                <Field label={t("lineNote")} htmlFor={`ln-${n}`}>
                  <Input id={`ln-${n}`} name={`ln_${n}`} maxLength={300} className="h-11" />
                </Field>
              </fieldset>
            </li>
          );
        })}
      </ol>
      <div className="rounded-lg border border-line bg-canvas p-3 text-sm" aria-live="polite" data-testid="line-quote-summary">
        <p className="font-medium text-ink">{t("summary", { quoted, total: lines.length, amount: `₹${(totalPaise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}` })}</p>
        <p className="text-xs text-muted">{t("summaryHint")}</p>
      </div>
    </div>
  );
}

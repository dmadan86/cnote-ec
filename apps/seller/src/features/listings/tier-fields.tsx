"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";
import { Button, Field, Input, Textarea } from "@cnote/ui";
import type { PriceTier, TradeInfo } from "@cnote/catalogue";
import { fieldError } from "@/features/shell/form-bits";
import type { SaveResult } from "./actions";

const rupees = (paise: number) => String(paise / 100);

/** Quantity price slabs: parallel `tierMinQty` / `tierPrice` (rupees) fields, parsed by parseTierRows. */
export function TierFields({ tiers, state }: { tiers: PriceTier[]; state: SaveResult | null }) {
  const t = useTranslations("listings.editor");
  const [rows, setRows] = useState<{ key: number; qty: string; price: string }[]>(() =>
    tiers.map((x, i) => ({ key: i, qty: String(x.minQty), price: rupees(x.pricePaise) })),
  );
  const [counter, setCounter] = useState(tiers.length);
  const update = (key: number, patch: Partial<{ qty: string; price: string }>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const err = fieldError(state, "tiers");
  return (
    <fieldset className="space-y-3 rounded-card border border-line bg-surface p-4">
      <legend className="px-1 text-sm font-semibold text-ink">{t("tiersLegend")}</legend>
      <p className="text-xs text-muted">{t("tiersHint")}</p>
      {rows.map((r, i) => (
        <div key={r.key} className="flex flex-wrap items-end gap-3">
          <Field label={t("tierMinQty")} htmlFor={`tier-qty-${r.key}`} className="w-40">
            <Input id={`tier-qty-${r.key}`} name="tierMinQty" inputMode="numeric" value={r.qty} onChange={(e) => update(r.key, { qty: e.target.value })} className="h-11" />
          </Field>
          <Field label={t("tierPrice")} htmlFor={`tier-price-${r.key}`} className="w-48">
            <Input id={`tier-price-${r.key}`} name="tierPrice" inputMode="decimal" value={r.price} onChange={(e) => update(r.key, { price: e.target.value })} className="h-11" />
          </Field>
          <Button type="button" variant="ghost" size="md" aria-label={t("tierRemove", { n: i + 1 })} onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      ))}
      {err ? <p role="alert" className="text-sm text-danger">{err}</p> : null}
      <Button
        type="button"
        variant="outline"
        size="md"
        disabled={rows.length >= 8}
        onClick={() => {
          setRows((r) => [...r, { key: counter, qty: "", price: "" }]);
          setCounter((c) => c + 1);
        }}
      >
        <Plus className="size-4" aria-hidden /> {t("tierAdd")}
      </Button>
    </fieldset>
  );
}

/** Optional trade facts; field names match parseTradeFields' inputs. */
export function TradeFields({ trade, state }: { trade: TradeInfo; state: SaveResult | null }) {
  const t = useTranslations("listings.editor");
  const [sample, setSample] = useState(!!trade.sampleAvailable);
  const err = fieldError(state, "trade");
  return (
    <fieldset className="space-y-4 rounded-card border border-line bg-surface p-4">
      <legend className="px-1 text-sm font-semibold text-ink">{t("tradeLegend")}</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("leadTime")} htmlFor="leadTimeDays">
          <Input id="leadTimeDays" name="leadTimeDays" inputMode="numeric" defaultValue={trade.leadTimeDays ?? ""} className="h-11" />
        </Field>
        <Field label={t("capacity")} htmlFor="supplyCapacityPerMonth">
          <Input id="supplyCapacityPerMonth" name="supplyCapacityPerMonth" inputMode="numeric" defaultValue={trade.supplyCapacityPerMonth ?? ""} className="h-11" />
        </Field>
      </div>
      <Field label={t("packaging")} htmlFor="packaging">
        <Input id="packaging" name="packaging" defaultValue={trade.packaging ?? ""} maxLength={500} className="h-11" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
          <input type="checkbox" name="sampleAvailable" checked={sample} onChange={(e) => setSample(e.target.checked)} className="size-4" />
          {t("sampleAvailable")}
        </label>
        {sample ? (
          <Field label={t("samplePrice")} htmlFor="samplePriceRupees">
            <Input id="samplePriceRupees" name="samplePriceRupees" inputMode="decimal" defaultValue={trade.samplePricePaise != null ? rupees(trade.samplePricePaise) : ""} className="h-11" />
          </Field>
        ) : null}
      </div>
      <Field label={t("paymentTerms")} htmlFor="paymentTerms">
        <Textarea id="paymentTerms" name="paymentTerms" defaultValue={trade.paymentTerms ?? ""} maxLength={500} className="min-h-16" />
      </Field>
      <Field label={t("certifications")} htmlFor="certifications" hint={t("certificationsHint")}>
        <Input id="certifications" name="certifications" defaultValue={(trade.certifications ?? []).join(", ")} className="h-11" />
      </Field>
      {err ? <p role="alert" className="text-sm text-danger">{err}</p> : null}
    </fieldset>
  );
}

"use client";
import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, Sparkles, X } from "lucide-react";
import { Alert, Button, Field, Input, Select } from "@cnote/ui";
import type { Availability, SellerVariantView, VariantAxis } from "@cnote/catalogue";
import { SubmitButton } from "@/features/shell/form-bits";
import { saveVariantsAction, updateVariantStockAction, type VariantsResult } from "./stock-actions";
import { AVAILABILITY_OPTIONS, MAX_VARIANT_ROWS, MAX_VARIANT_TIERS, missingCombinations, rowsFromVariants, suggestSku, type VariantRow } from "./stock-form";

let counter = 0;
const newKey = () => `new-${++counter}`;

/**
 * Variant matrix: one card per variant (phone-friendly) with a value for every category axis, optional price / MOQ / quantity-tier
 * overrides, stock and an image. Two save paths: "Save variants" (working copy; new structure goes live after Submit for review) and
 * "Update stock now" (existing variants, instant, no review).
 */
export function VariantsEditor({
  listingId,
  axes,
  initial,
  images,
  skuBase,
}: {
  listingId: string;
  axes: VariantAxis[];
  initial: SellerVariantView[];
  /** the listing's own images (ids are what a variant stores) */
  images: { id: string; label: string }[];
  skuBase: string;
}) {
  const t = useTranslations("stock.variants");
  const ta = useTranslations("stock.availability");
  const [rows, setRows] = useState<VariantRow[]>(() => rowsFromVariants(initial));
  const [saveState, save] = useActionState<VariantsResult | null, FormData>(saveVariantsAction, null);
  const [stockState, stock] = useActionState<VariantsResult | null, FormData>(updateVariantStockAction, null);

  if (axes.length === 0) {
    return (
      <section id="variants" className="space-y-2 rounded-card border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold text-ink">{t("legend")}</h2>
        <p className="text-sm text-muted">{t("noAxes")}</p>
      </section>
    );
  }

  const patch = (key: string, p: Partial<VariantRow>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const room = MAX_VARIANT_ROWS - rows.length;
  const blankRow = (): VariantRow => ({ key: newKey(), sku: "", axes: {}, priceRupees: "", moq: "", tiers: [], availability: "in_stock", qty: "", leadTime: "", imageId: "" });
  const payload = JSON.stringify(rows.map((r) => ({ id: r.id, sku: r.sku, axes: r.axes, priceRupees: r.priceRupees, moq: r.moq, tiers: r.tiers, availability: r.availability, qty: r.qty, leadTime: r.leadTime, imageId: r.imageId })));
  const canGenerate = axes.some((a) => a.options?.length) && room > 0;

  return (
    <section id="variants" className="space-y-4 rounded-card border border-line bg-surface p-4" aria-labelledby="variants-h">
      <div>
        <h2 id="variants-h" className="text-sm font-semibold text-ink">{t("legend")}</h2>
        <p className="mt-1 text-xs text-muted">{t("intro")}</p>
        <p className="mt-1 text-xs text-ink" aria-live="polite">{t("count", { count: rows.length, max: MAX_VARIANT_ROWS })}</p>
      </div>

      {rows.length === 0 ? <p className="text-sm text-muted">{t("empty")}</p> : null}

      <form action={save} className="space-y-4" id="variants-form">
        <input type="hidden" name="listingId" value={listingId} />
        <input type="hidden" name="variants" value={payload} />
        <ol className="space-y-4">
          {rows.map((r, i) => {
            const n = i + 1;
            const id = `v-${r.key}`;
            return (
              <li key={r.key} className="rounded-card border border-line p-3">
                <fieldset className="space-y-3">
                  <legend className="flex w-full items-center justify-between gap-2 px-1 text-sm font-medium text-ink">
                    <span>{t("rowTitle", { n })}{r.sku ? ` · ${r.sku}` : ""}</span>
                    <Button type="button" variant="ghost" size="md" aria-label={t("remove", { n })} onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}>
                      <X className="size-4" aria-hidden />
                    </Button>
                  </legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t("sku")} htmlFor={`${id}-sku`}>
                      <Input id={`${id}-sku`} value={r.sku} maxLength={64} onChange={(e) => patch(r.key, { sku: e.target.value })} className="h-11" />
                    </Field>
                    {axes.map((a) => (
                      <Field key={a.key} label={a.label} htmlFor={`${id}-ax-${a.key}`}>
                        {a.options?.length ? (
                          <Select id={`${id}-ax-${a.key}`} value={r.axes[a.key] ?? ""} onChange={(e) => patch(r.key, { axes: { ...r.axes, [a.key]: e.target.value } })} className="h-11">
                            <option value="">{t("pickOption")}</option>
                            {a.options.map((o) => <option key={o} value={o}>{o}</option>)}
                          </Select>
                        ) : (
                          <Input id={`${id}-ax-${a.key}`} value={r.axes[a.key] ?? ""} maxLength={60} onChange={(e) => patch(r.key, { axes: { ...r.axes, [a.key]: e.target.value } })} className="h-11" />
                        )}
                      </Field>
                    ))}
                    <Field label={t("price")} htmlFor={`${id}-price`}>
                      <Input id={`${id}-price`} inputMode="decimal" value={r.priceRupees} onChange={(e) => patch(r.key, { priceRupees: e.target.value })} className="h-11" />
                    </Field>
                    <Field label={t("moq")} htmlFor={`${id}-moq`}>
                      <Input id={`${id}-moq`} inputMode="numeric" value={r.moq} onChange={(e) => patch(r.key, { moq: e.target.value })} className="h-11" />
                    </Field>
                    <Field label={t("availability")} htmlFor={`${id}-av`}>
                      <Select
                        id={`${id}-av`}
                        value={r.availability}
                        onChange={(e) => {
                          const availability = e.target.value as Availability;
                          patch(r.key, { availability, ...(availability === "out_of_stock" ? { qty: "" } : {}) });
                        }}
                        className="h-11"
                      >
                        {AVAILABILITY_OPTIONS.map((a) => <option key={a} value={a}>{ta(a)}</option>)}
                      </Select>
                    </Field>
                    <Field label={t("qty")} htmlFor={`${id}-qty`}>
                      <Input id={`${id}-qty`} inputMode="numeric" value={r.qty} disabled={r.availability === "out_of_stock"} onChange={(e) => patch(r.key, { qty: e.target.value })} className="h-11" />
                    </Field>
                    <Field label={t("leadTime")} htmlFor={`${id}-lead`}>
                      <Input id={`${id}-lead`} inputMode="numeric" value={r.leadTime} aria-required={r.availability === "made_to_order"} onChange={(e) => patch(r.key, { leadTime: e.target.value })} className="h-11" />
                    </Field>
                    {images.length ? (
                      <Field label={t("image")} htmlFor={`${id}-img`}>
                        <Select id={`${id}-img`} value={r.imageId} onChange={(e) => patch(r.key, { imageId: e.target.value })} className="h-11">
                          <option value="">{t("noImage")}</option>
                          {images.map((im) => <option key={im.id} value={im.id}>{im.label}</option>)}
                        </Select>
                      </Field>
                    ) : null}
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-ink">{t("tiers")}</p>
                    {r.tiers.map((tier, ti) => (
                      <div key={ti} className="flex flex-wrap items-end gap-3">
                        <Field label={t("tierQty")} htmlFor={`${id}-tq-${ti}`} className="w-36">
                          <Input id={`${id}-tq-${ti}`} inputMode="numeric" value={tier.minQty} onChange={(e) => patch(r.key, { tiers: r.tiers.map((x, xi) => (xi === ti ? { ...x, minQty: e.target.value } : x)) })} className="h-11" />
                        </Field>
                        <Field label={t("tierPrice")} htmlFor={`${id}-tp-${ti}`} className="w-40">
                          <Input id={`${id}-tp-${ti}`} inputMode="decimal" value={tier.price} onChange={(e) => patch(r.key, { tiers: r.tiers.map((x, xi) => (xi === ti ? { ...x, price: e.target.value } : x)) })} className="h-11" />
                        </Field>
                        <Button type="button" variant="ghost" size="md" aria-label={t("tierRemove", { n: ti + 1 })} onClick={() => patch(r.key, { tiers: r.tiers.filter((_, xi) => xi !== ti) })}>
                          <X className="size-4" aria-hidden />
                        </Button>
                      </div>
                    ))}
                    <Button type="button" variant="outline" size="md" disabled={r.tiers.length >= MAX_VARIANT_TIERS} onClick={() => patch(r.key, { tiers: [...r.tiers, { minQty: "", price: "" }] })}>
                      <Plus className="size-4" aria-hidden /> {t("tierAdd")}
                    </Button>
                  </div>
                </fieldset>
              </li>
            );
          })}
        </ol>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="md" className="min-h-11" disabled={room <= 0} onClick={() => setRows((all) => [...all, blankRow()])}>
            <Plus className="size-4" aria-hidden /> {t("add")}
          </Button>
          {canGenerate ? (
            <Button
              type="button"
              variant="outline"
              size="md"
              className="min-h-11"
              onClick={() =>
                setRows((all) => [
                  ...all,
                  ...missingCombinations(axes, all.map((r) => r.axes), MAX_VARIANT_ROWS - all.length).map((combo): VariantRow => ({ ...blankRow(), axes: combo, sku: suggestSku(skuBase, axes, combo) })),
                ])
              }
            >
              <Sparkles className="size-4" aria-hidden /> {t("generate")}
            </Button>
          ) : null}
        </div>
        {canGenerate ? <p className="text-xs text-muted">{t("generateHint", { max: MAX_VARIANT_ROWS })}</p> : null}
        {room <= 0 ? <p className="text-xs text-muted">{t("err.tooMany", { max: MAX_VARIANT_ROWS })}</p> : null}

        <div aria-live="polite" className="space-y-2">
          {saveState ? (saveState.ok ? <Alert tone="success">{saveState.data.message}</Alert> : <Alert tone="danger">{saveState.error}</Alert>) : null}
          {stockState ? (stockState.ok ? <Alert tone="success">{stockState.data.message}</Alert> : <Alert tone="danger">{stockState.error}</Alert>) : null}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <SubmitButton size="lg" pendingText={t("saving")}>{t("saveStructure")}</SubmitButton>
          <SubmitButton size="lg" variant="outline" formAction={stock} pendingText={t("saving")} disabled={!rows.some((r) => r.id)}>{t("updateStock")}</SubmitButton>
        </div>
        <p className="text-xs text-muted">{t("saveHint")}</p>
        <p className="text-xs text-muted">{t("stockHint")}</p>
      </form>
    </section>
  );
}

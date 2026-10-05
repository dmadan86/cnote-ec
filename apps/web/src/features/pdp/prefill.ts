export interface RfqPrefill {
  quantity?: number | null;
  unit?: string | null;
  /** slab unit price for that quantity, integer paise */
  pricePaise?: number | null;
  /** the variant the buyer chose on the product page (sku + readable name), carried into the requirement text */
  variantSku?: string | null;
  variantLabel?: string | null;
}

/** `/rfq/new?listing=…` plus the buyer's chosen quantity (and the slab price it implies), so the form opens pre-filled. Other destinations are untouched. */
export function withRfqPrefill(next: string, prefill: RfqPrefill | undefined): string {
  if (!prefill?.quantity || !next.startsWith("/rfq/new")) return next;
  const [path, query = ""] = next.split("?");
  const qs = new URLSearchParams(query);
  qs.set("qty", String(prefill.quantity));
  if (prefill.unit) qs.set("unit", prefill.unit);
  if (prefill.pricePaise != null) qs.set("price", String(prefill.pricePaise));
  if (prefill.variantSku) {
    qs.set("variant", prefill.variantSku.slice(0, 64));
    if (prefill.variantLabel) qs.set("vlabel", prefill.variantLabel.slice(0, 140));
  }
  return `${path}?${qs}`;
}

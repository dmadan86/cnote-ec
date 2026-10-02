export interface RfqPrefill {
  quantity?: number | null;
  unit?: string | null;
  /** slab unit price for that quantity, integer paise */
  pricePaise?: number | null;
}

/** `/rfq/new?listing=…` plus the buyer's chosen quantity (and the slab price it implies), so the form opens pre-filled. Other destinations are untouched. */
export function withRfqPrefill(next: string, prefill: RfqPrefill | undefined): string {
  if (!prefill?.quantity || !next.startsWith("/rfq/new")) return next;
  const [path, query = ""] = next.split("?");
  const qs = new URLSearchParams(query);
  qs.set("qty", String(prefill.quantity));
  if (prefill.unit) qs.set("unit", prefill.unit);
  if (prefill.pricePaise != null) qs.set("price", String(prefill.pricePaise));
  return `${path}?${qs}`;
}

"use client";
// Shared selection state for the product page islands (gallery, selector, price panel). The page itself stays static (ISR): the
// chosen variant is read from `?v=<sku>` on the client after hydration (no useSearchParams, which would make the page dynamic) and
// written back with history.replaceState, so the link is shareable and survives a reload. Unknown skus are ignored.
import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { findVariant, picksOf, resolveChoice, variantBySku, type Availability, type Picks, type PdpAxis, type PdpVariant } from "./variants";

export interface ListingStockInfo {
  availability: Availability;
  availableQty: number | null;
  /** ISO time the seller last set the stock, or null */
  stockUpdatedAt: string | null;
}

interface Ctx {
  axes: PdpAxis[];
  variants: PdpVariant[];
  stock: ListingStockInfo;
  picks: Picks;
  selected: PdpVariant | null;
  choose: (axis: string, value: string) => void;
  clear: () => void;
}

const VariantCtx = createContext<Ctx>({
  axes: [],
  variants: [],
  stock: { availability: "in_stock", availableQty: null, stockUpdatedAt: null },
  picks: {},
  selected: null,
  choose: () => undefined,
  clear: () => undefined,
});

export const useVariantSelection = () => useContext(VariantCtx);

const subscribeNever = () => () => undefined;

function writeUrl(sku: string | null) {
  try {
    const u = new URL(window.location.href);
    if (sku) u.searchParams.set("v", sku);
    else u.searchParams.delete("v");
    window.history.replaceState(window.history.state, "", u);
  } catch {
    /* no history API (tests, embedded view): the selection just is not shareable */
  }
}

export function VariantProvider({ axes, variants, stock, children }: { axes: PdpAxis[]; variants: PdpVariant[]; stock: ListingStockInfo; children: ReactNode }) {
  // null = the buyer has not chosen yet, so the `?v=` of the loaded URL (read after hydration; "" on the server) decides
  const [chosen, setChosen] = useState<Picks | null>(null);
  const search = useSyncExternalStore(subscribeNever, () => window.location.search, () => "");
  const fromUrl = useMemo(() => picksOf(variantBySku(variants, new URLSearchParams(search).get("v"))), [variants, search]);
  const picks = chosen ?? fromUrl;

  const selected = useMemo(() => findVariant(variants, axes, picks) ?? null, [variants, axes, picks]);

  const choose = useCallback(
    (axis: string, value: string) => {
      const next = resolveChoice(variants, picks, axis, value);
      setChosen(next);
      writeUrl(findVariant(variants, axes, next)?.sku ?? null);
    },
    [variants, axes, picks],
  );
  const clear = useCallback(() => {
    setChosen({});
    writeUrl(null);
  }, []);

  const value = useMemo(() => ({ axes, variants, stock, picks, selected, choose, clear }), [axes, variants, stock, picks, selected, choose, clear]);
  return <VariantCtx.Provider value={value}>{children}</VariantCtx.Provider>;
}

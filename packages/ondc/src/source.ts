// Catalogue read port (ADR-006): the adapter reads listings only through @cnote/catalogue's public functions.
import type { ListingView } from "@cnote/catalogue";

export interface CatalogSource {
  /** live (published + approved) listings of a seller, as buyers see them */
  live(sellerBusinessId: string): Promise<ListingView[]>;
  /** the seller's own working copies (any status), for the opt-in UI */
  working(sellerBusinessId: string): Promise<ListingView[]>;
}

export const catalogueSource: CatalogSource = {
  async live(id) {
    return (await import("@cnote/catalogue")).listPublicSellerListings(id);
  },
  async working(id) {
    return (await import("@cnote/catalogue")).listSellerListings(id);
  },
};

let source: CatalogSource = catalogueSource;
export const getSource = (): CatalogSource => source;
/** Tests: inject fixture listings. */
export function setCatalogSource(s: CatalogSource | undefined): void {
  source = s ?? catalogueSource;
}

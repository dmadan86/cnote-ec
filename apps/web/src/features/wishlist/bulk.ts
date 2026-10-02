// Pure helpers for "Request quotes for selected" (unit-tested in test/wishlist-bulk.test.ts).
// One enquiry per supplier: the enquiry module does the matching and credit rules (ADR-002/005), we only shape its input.

export const MAX_BULK_PRODUCTS = 20;
export const MAX_BULK_SUPPLIERS = 5;

export interface BulkListing {
  id: string;
  title: string;
  sellerBusinessId: string;
  category: { slug: string };
  moq: number | null;
  moqUnit: string | null;
}

export interface SupplierGroup {
  sellerBusinessId: string;
  listings: BulkListing[];
}

/** Groups by supplier, keeping the order products were selected in. */
export function groupBySupplier(listings: readonly BulkListing[]): SupplierGroup[] {
  const groups = new Map<string, SupplierGroup>();
  for (const l of listings) {
    const g = groups.get(l.sellerBusinessId) ?? { sellerBusinessId: l.sellerBusinessId, listings: [] };
    g.listings.push(l);
    groups.set(l.sellerBusinessId, g);
  }
  return [...groups.values()];
}

/** Title (5..140 chars) for one supplier's enquiry. */
export function enquiryTitle(g: SupplierGroup): string {
  const first = g.listings[0]!.title;
  const rest = g.listings.length - 1;
  const raw = rest > 0 ? `Quote request: ${first} +${rest} more` : `Quote request: ${first}`;
  return raw.length > 140 ? `${raw.slice(0, 137)}...` : raw;
}

/** Requirement text: one line per product with its minimum order. Private list notes are NOT included. */
export function enquiryRequirement(g: SupplierGroup): string {
  const lines = g.listings.map((l) => `- ${l.title}${l.moq != null ? ` (minimum order ${l.moq}${l.moqUnit ? ` ${l.moqUnit}` : ""})` : ""}`);
  return `Please share your best price, lead time and delivery terms for these products:\n${lines.join("\n")}`.slice(0, 4000);
}

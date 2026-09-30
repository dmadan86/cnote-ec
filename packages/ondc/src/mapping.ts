// Platform listing -> Beckn catalogue mapping (ADR-017). Pure functions; no I/O.
// Category ids come from configuration (never hard-coded per vertical, ADR-011): ONDC_CATEGORY_MAP maps a platform
// category slug to an ONDC category id, with a per-listing override on OndcListingOptIn and a global fallback.
import { createHash } from "node:crypto";
import type { ListingView } from "@cnote/catalogue";

export const FALLBACK_CATEGORY_ID = "Others";
export const FULFILLMENT_ID = "F1";
export const LOCATION_ID = "L1";
export const MIN_VERIFICATION_TIER = 1;

/** paise -> "84.50" (Beckn prices are decimal strings). */
export function paiseToDecimal(paise: number): string {
  const p = Math.round(paise);
  return `${Math.trunc(p / 100)}.${String(Math.abs(p) % 100).padStart(2, "0")}`;
}
/** "84.50" -> 8450 paise; null when malformed. */
export function decimalToPaise(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  return Number(w) * 100 + Number(f.padEnd(2, "0"));
}

export type IneligibleReason = "not_published" | "not_approved" | "seller_unverified" | "no_price" | "not_opted_in";

/** Only live, moderation-approved listings of verification tier >= 1 sellers with a price are publishable. */
export function ineligibleReason(l: ListingView, optedIn: boolean): IneligibleReason | null {
  if (!optedIn) return "not_opted_in";
  if (l.status !== "published") return "not_published";
  if (l.moderationStatus !== "approved") return "not_approved";
  if ((l.seller?.verificationTier ?? 0) < MIN_VERIFICATION_TIER) return "seller_unverified";
  if (l.pricePaise === null || l.pricePaise <= 0) return "no_price";
  return null;
}

export function categoryIdFor(l: Pick<ListingView, "category">, map: Record<string, string>, override?: string | null): string {
  return override || map[l.category.slug] || FALLBACK_CATEGORY_ID;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface BecknItem {
  id: string;
  descriptor: { name: string; short_desc: string; long_desc: string; images: string[]; code?: string };
  price: { currency: "INR"; value: string; maximum_value: string };
  quantity: { unitized: { measure: { unit: string; value: string } }; minimum?: { count: string } };
  category_id: string;
  fulfillment_id: string;
  location_id: string;
  matched: boolean;
  tags: { code: string; list: { code: string; value: string }[] }[];
}

export function listingToItem(l: ListingView, opts: { categoryId: string }): BecknItem {
  const unit = l.priceUnit ?? "unit";
  const tags: BecknItem["tags"] = [{ code: "b2b", list: [
    ...(l.hsn ? [{ code: "hsn", value: l.hsn }] : []),
    ...(l.moq ? [{ code: "moq", value: String(l.moq) }, { code: "moq_unit", value: l.moqUnit ?? unit }] : []),
    { code: "made_to_order", value: "true" },
    { code: "language", value: l.language },
  ] }];
  const attrs = Object.entries(l.attributes).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ({ code: k, value: String(v) }));
  if (attrs.length) tags.push({ code: "attributes", list: attrs });
  return {
    id: l.id,
    descriptor: { name: clip(l.title, 200), short_desc: clip(l.description, 160), long_desc: clip(l.description, 2000), images: l.imageUrls.slice(0, 8), ...(l.hsn ? { code: `HSN:${l.hsn}` } : {}) },
    price: { currency: "INR", value: paiseToDecimal(l.pricePaise ?? 0), maximum_value: paiseToDecimal(l.pricePaise ?? 0) },
    quantity: { unitized: { measure: { unit, value: "1" } }, ...(l.moq ? { minimum: { count: String(l.moq) } } : {}) },
    category_id: opts.categoryId,
    fulfillment_id: FULFILLMENT_ID,
    location_id: LOCATION_ID,
    matched: true,
    tags,
  };
}

export interface BecknProvider {
  id: string;
  descriptor: { name: string };
  locations: { id: string; city?: { name: string }; state?: { name: string } }[];
  fulfillments: { id: string; type: "Delivery" }[];
  items: BecknItem[];
  tags: { code: string; list: { code: string; value: string }[] }[];
  ttl: string;
}

export interface ProviderInput {
  sellerBusinessId: string;
  listings: ListingView[];
  /** listingId -> category override (opt-in row); presence of a key means opted in */
  optIns: Map<string, string | null>;
  categoryMap: Record<string, string>;
  ttl?: string;
}

/** Builds the provider node; returns null when no listing is publishable. */
export function buildProvider(i: ProviderInput): BecknProvider | null {
  const eligible = i.listings.filter((l) => ineligibleReason(l, i.optIns.has(l.id)) === null);
  if (eligible.length === 0) return null;
  const seller = eligible[0]!.seller;
  const tier = Math.min(...eligible.map((l) => l.seller?.verificationTier ?? 0));
  return {
    id: i.sellerBusinessId,
    descriptor: { name: seller?.name ?? "Seller" },
    locations: [{ id: LOCATION_ID, ...(seller?.city ? { city: { name: seller.city } } : {}), ...(seller?.state ? { state: { name: seller.state } } : {}) }],
    fulfillments: [{ id: FULFILLMENT_ID, type: "Delivery" }],
    items: eligible.map((l) => listingToItem(l, { categoryId: categoryIdFor(l, i.categoryMap, i.optIns.get(l.id)) })),
    tags: [{ code: "verification", list: [{ code: "tier", value: String(tier) }] }],
    ttl: i.ttl ?? "P1D",
  };
}

export function buildCatalog(bppName: string, providers: BecknProvider[]) {
  return { "bpp/descriptor": { name: bppName }, "bpp/providers": providers };
}

/** Stable content hash of a provider projection; unchanged hash => nothing new to publish. */
export function providerHash(p: BecknProvider | null): string {
  return createHash("sha256").update(JSON.stringify(p ?? null)).digest("hex");
}

export interface SearchIntent { text?: string; categoryId?: string; providerId?: string }

/** Filters provider items by an intent (name/description text, category id). Providers with no match are dropped. */
export function applyIntent(providers: BecknProvider[], intent: SearchIntent): BecknProvider[] {
  const q = intent.text?.trim().toLowerCase();
  const words = q ? q.split(/\s+/).filter(Boolean) : [];
  return providers
    .filter((p) => !intent.providerId || p.id === intent.providerId)
    .map((p) => ({
      ...p,
      items: p.items.filter((it) => {
        if (intent.categoryId && it.category_id !== intent.categoryId) return false;
        if (!words.length) return true;
        const hay = `${it.descriptor.name} ${it.descriptor.short_desc}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      }),
    }))
    .filter((p) => p.items.length > 0);
}

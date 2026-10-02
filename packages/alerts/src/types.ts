export const ALERT_TYPES = ["price_drop", "back_in_stock", "followed_digest", "saved_search"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** Per-person opt-ins. `saved_search` is per search (its frequency), so it is not a setting here. */
export interface AlertSettingsView {
  priceDrop: boolean;
  backInStock: boolean;
  followedDigest: boolean;
}

export const SEARCH_FREQUENCIES = ["off", "daily", "weekly"] as const;
export type SearchFrequency = (typeof SEARCH_FREQUENCIES)[number];

export const MAX_FOLLOWS_PER_PERSON = 200;
export const MAX_SAVED_SEARCHES_PER_PERSON = 20;
export const MAX_SEEN_IDS = 300;
export const WRITES_PER_MINUTE = 30;

export interface SavedSearchView {
  id: string;
  name: string;
  query: string;
  filters: Record<string, unknown>;
  sort: string;
  frequency: SearchFrequency;
  lastRunAt: string | null;
  createdAt: string;
}

export interface FollowedSupplierView {
  businessId: string;
  name: string;
  city: string | null;
  state: string | null;
  verificationTier: number;
  badgeActive: boolean;
  followedAt: string;
  /** Newest live listings first (publishing order). */
  latestListings: { id: string; title: string; pricePaise: number | null; priceUnit: string | null; publishedAt: string }[];
}

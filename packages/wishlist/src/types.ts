import type { ListingView } from "@cnote/catalogue";

export interface WishlistSummary {
  id: string;
  name: string;
  isDefault: boolean;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WishlistItemView {
  id: string;
  listingId: string;
  note: string | null;
  /** Price (paise) when the item was saved; null if the listing had no price then. */
  savedPricePaise: number | null;
  /** Current listing price, null if none or the listing is gone. */
  currentPricePaise: number | null;
  /** True when the current price is lower than the price at save time. */
  priceDropped: boolean;
  createdAt: string;
  /** Null when the listing was archived, unpublished or removed since it was saved. */
  listing: ListingView | null;
}

export interface WishlistDetail extends WishlistSummary {
  items: WishlistItemView[];
}

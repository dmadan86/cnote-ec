// @cnote/wishlist — buyers' saved products in named lists (B2B: one list per project) plus the
// cookie-based compare tray helpers. Framework-free.
// PUBLIC CONTRACT — apps depend on these signatures. Extend, don't break.
export type { WishlistSummary, WishlistDetail, WishlistItemView } from "./types";
export { DEFAULT_LIST_NAME, MAX_LISTS_PER_PERSON, MAX_ITEMS_PER_LIST, MAX_NOTE_LENGTH, MAX_NAME_LENGTH } from "./constants";
export {
  getOrCreateDefaultList, listLists, getList, createList, renameList, deleteList,
  addItem, removeItem, removeFromAll, moveItem, updateNote, isSaved, listSavedListingIds, countSaved, savedCountFor, erasePersonWishlists,
} from "./lists";
export {
  COMPARE_COOKIE, COMPARE_MAX, COMPARE_COOKIE_MAX_AGE, parseCompareIds, serializeCompareIds, addToCompare, type CompareAddResult,
} from "./compare";
export { worker } from "./worker";
export * from "./retention";
export { getShare, createShare, revokeShare, getSharedWishlist, type WishlistShareView, type SharedWishlistView } from "./share";

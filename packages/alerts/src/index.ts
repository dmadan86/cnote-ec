// @cnote/alerts — buyer retention: followed suppliers, saved searches and opt-in alerts (price drop, back in stock, digests).
// Decides WHAT is new and emits BuyerAlertTriggered; @cnote/notifications delivers it (preferences, consent, unsubscribe).
// None of this ever changes ranking (ADR-000/009). PUBLIC CONTRACT. Extend, don't break.
export {
  ALERT_TYPES, SEARCH_FREQUENCIES, MAX_FOLLOWS_PER_PERSON, MAX_SAVED_SEARCHES_PER_PERSON,
  type AlertType, type AlertSettingsView, type SearchFrequency, type SavedSearchView, type FollowedSupplierView,
} from "./types";
export { followSupplier, unfollowSupplier, isFollowing, listFollowedSuppliers, countFollowers } from "./follows";
export { createSavedSearch, listSavedSearches, setSearchFrequency, deleteSavedSearch, type SaveSearchInput } from "./saved-searches";
export { getAlertSettings, setAlertSetting, unsubscribeByToken } from "./settings";
export { alertUnsubscribeUrl, signUnsubscribeToken, verifyUnsubscribeToken } from "./token";
export { runSavedSearchDigests, runFollowedDigests } from "./digests";
export { onListingPriceChanged, onListingPublished } from "./listing-alerts";
export { exportAlertsData, exportPersonalData, eraseAlertsData, purgeOldDispatches } from "./privacy";
export { worker } from "./worker";

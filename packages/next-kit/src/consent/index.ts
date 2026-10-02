// Shared cookie-consent UI (banner, preferences dialog, cookie table, consent record, settings button) for every app that shows a
// consent banner (buyer web, seller). Client components only: the logic is @cnote/consent, the receipts route is
// @cnote/next-kit/consent-route. Messages come from the consuming app's `consent` namespace (docs/design/cookie-consent.md).
export { ConsentManager, type ConsentManagerProps } from "./manager";
export { ConsentBannerView, BANNER_BUTTON_CLASS } from "./banner";
export { PreferencesDialog } from "./preferences-dialog";
export { CookieTable, durationText } from "./cookie-table";
export { ConsentRecord, useConsentId } from "./consent-record";
export { CookieSettingsButton } from "./settings-button";
export { Switch } from "./switch";

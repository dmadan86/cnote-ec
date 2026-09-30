// @cnote/promotions: editorial promotions, seller offers, coupons, referrals (ADR-025).
// PUBLIC CONTRACT. The editorial side has no path to a wallet, price or invoice (firewall with @cnote/ads, ADR-024).
export { promotionsEnabled } from "./config";
export { setListingLookup, setGstinLookup, type ListingFacts, type ListingLookup, type GstinLookup } from "./ports";
export { promoTags } from "./tags";
export * from "./promotions";
export * from "./offers";
export * from "./honour";
export * from "./coupons";
export * from "./referrals";
export { worker } from "./worker";

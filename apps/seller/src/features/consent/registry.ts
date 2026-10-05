// Single source of truth for every cookie / browser-storage key the SELLER app sets (docs/design/cookie-consent.md, "Other apps").
// Cookies are host-scoped, so the seller app has its own consent record (`seller_consent`), registry and policy version, separate
// from the buyer web's. The preferences dialog, the withdrawal cleanup and test/consent-registry.test.ts all read this list; the
// test fails when seller code writes a `seller_*` / `cnote_seller_*` key that is missing here, or a storage API appears that is
// not accounted for.
//
// Categories:
//   necessary  sign-in/security, and things the seller explicitly did (language, "skip this step", "finished onboarding").
//   analytics  first-party onboarding timing: when the business was created (`seller_onb_t0`), used only to measure how long onboarding
//              takes (ADR-004 metric). Written only with `analytics` granted.
//   marketing  the referral code from a `?ref=` link (ADR-025), remembered until the business is created so the referrer can be
//              credited. It attributes a visit to a campaign, so it is optional. Written only with `marketing` granted.
// No third-party cookies: Cloudflare Turnstile (bot check on sign-in/sign-up) and Sentry are documented in the design doc.
import { firstParty, type StorageEntry } from "@cnote/consent";

export const SELLER_CONSENT_COOKIE = "seller_consent";
/** Bump when a NEW optional purpose/provider is added or an existing one changes materially: everybody is asked again. */
export const SELLER_POLICY_VERSION = 2;
/** Update together with SELLER_POLICY_VERSION. v2 (2026-10-06): the banner and dialog link to the new /cookies policy page; new necessary key seller_consent_sync (account sync). */
export const SELLER_POLICY_UPDATED = "2026-10-06";

export const SELLER_STORAGE_REGISTRY: readonly StorageEntry[] = [
  // --- strictly necessary -------------------------------------------------------------------------------------------
  firstParty("seller_consent", "necessary", "cookie", "consent", { unit: "months", n: 12 }),
  // The consent record itself (DPDP s.6(10) proof): the receipt not yet acknowledged by the server, resent on the next load
  // until it gets a 200, then deleted.
  firstParty("seller_consent_pending", "necessary", "localStorage", "consentPending", { unit: "persistent" }),
  // Account sync (v2): remembers, for this visit only, that the cookie choice was checked against the signed-in seller's consent ledger.
  firstParty("seller_consent_sync", "necessary", "sessionStorage", "consentSync", { unit: "session" }),
  // Auth cookies carry a `__Host-` prefix in production (packages/identity cookieNames). httpOnly, set by the server.
  firstParty("cnote_seller_at", "necessary", "cookie", "auth", { unit: "minutes", n: 15 }, true),
  firstParty("cnote_seller_rt", "necessary", "cookie", "session", { unit: "days", n: 30 }, true),
  firstParty("cnote_seller_oauth", "necessary", "cookie", "oauth", { unit: "minutes", n: 10 }, true),
  firstParty("cnote_seller_mfa", "necessary", "cookie", "mfa", { unit: "minutes", n: 5 }, true),
  // The language the seller chose (or, at onboarding, the first business language they entered).
  firstParty("seller_locale", "necessary", "cookie", "locale", { unit: "years", n: 1 }, true),
  // Onboarding progress the seller caused: "I finished" and "skip this step". Without them onboarding would re-ask.
  firstParty("seller_onb_done", "necessary", "cookie", "onboardingDone", { unit: "years", n: 1 }, true),
  firstParty("seller_onb_skip_gst", "necessary", "cookie", "onboardingSkip", { unit: "years", n: 1 }, true),
  firstParty("seller_onb_skip_listing", "necessary", "cookie", "onboardingSkip", { unit: "years", n: 1 }, true),
  // The seller's own action "I submitted my first listing" (and when): lets onboarding show the outcome for two minutes and not count
  // the first listing twice. It is state of something the seller did, not measurement, so it is necessary (like `skip` / `done`).
  firstParty("seller_onb_t1", "necessary", "cookie", "onboardingFirstListing", { unit: "years", n: 1 }, true),
  // --- analytics: onboarding timing (first party) ------------------------------------------------------------------------
  firstParty("seller_onb_t0", "analytics", "cookie", "onboardingStart", { unit: "years", n: 1 }, true),
  // --- marketing: referral attribution (first party) --------------------------------------------------------------------
  firstParty("seller_ref", "marketing", "cookie", "referral", { unit: "days", n: 30 }, true),
];

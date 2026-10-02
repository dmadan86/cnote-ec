// Every cookie / browser-storage key the STUDIO (storefront editor) app sets. Studio signs sellers in through the seller realm
// (CNOTE_AUTH_REALM "seller", own host, so its cookies are separate from the seller app's), and everything it stores is strictly
// necessary sign-in/security state, so this app shows NO cookie banner (DPDP s.7; ePrivacy Art 5(3) exemption;
// docs/design/cookie-consent.md, "Other apps"). It has no consent record, no analytics or marketing storage, no third-party script,
// and Sentry stores nothing in the browser. The editor keeps its draft on the server, not in localStorage.
//
// test/storage-registry.test.ts fails when the registry holds anything optional, when source mentions an unregistered
// `cnote_seller_*` key, or when a cookie / web-storage write, a third-party script or a third-party iframe appears.
import { firstParty, type StorageEntry } from "@cnote/consent";

export const STUDIO_STORAGE_REGISTRY: readonly StorageEntry[] = [
  // Written by @cnote/next-kit (realm "seller"); `__Host-` prefix in production. httpOnly, host-scoped.
  firstParty("cnote_seller_at", "necessary", "cookie", "auth", { unit: "minutes", n: 15 }, true),
  firstParty("cnote_seller_rt", "necessary", "cookie", "session", { unit: "days", n: 30 }, true),
  firstParty("cnote_seller_oauth", "necessary", "cookie", "oauth", { unit: "minutes", n: 10 }, true),
  firstParty("cnote_seller_mfa", "necessary", "cookie", "mfa", { unit: "minutes", n: 5 }, true),
];

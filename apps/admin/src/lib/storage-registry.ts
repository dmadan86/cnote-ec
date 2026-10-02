// Every cookie / browser-storage key the ADMIN (back-office) app sets. All of it is strictly necessary (staff sign-in and its
// security), so this app shows NO cookie banner (DPDP s.7; ePrivacy Art 5(3) exemption; docs/design/cookie-consent.md, "Other apps").
// There is no consent record, no analytics, no marketing storage, no third-party script, and Sentry stores nothing in the browser.
//
// This list exists so that a future optional key cannot slip in unnoticed: test/storage-registry.test.ts fails when the registry
// holds anything optional, when source mentions an unregistered `cnote_admin_*` key, or when a cookie / web-storage write, a
// third-party script or a third-party iframe appears. The fix then is a banner (copy apps/seller/src/features/consent), a gated
// write and a policy version, not an edit of this test.
import { firstParty, type StorageEntry } from "@cnote/consent";

export const ADMIN_STORAGE_REGISTRY: readonly StorageEntry[] = [
  // Written by @cnote/next-kit (realm "admin"); `__Host-` prefix in production. httpOnly, host-scoped.
  firstParty("cnote_admin_at", "necessary", "cookie", "auth", { unit: "minutes", n: 5 }, true),
  // The refresh cookie never outlives the session's 12 h absolute cap (packages/identity REALM_POLICY.admin).
  firstParty("cnote_admin_rt", "necessary", "cookie", "session", { unit: "minutes", n: 720 }, true),
  firstParty("cnote_admin_oauth", "necessary", "cookie", "oauth", { unit: "minutes", n: 10 }, true),
  firstParty("cnote_admin_mfa", "necessary", "cookie", "mfa", { unit: "minutes", n: 5 }, true),
];

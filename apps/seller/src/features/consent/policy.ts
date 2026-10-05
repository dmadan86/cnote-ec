// Policy version snapshots for the seller app (DPDP s.6(10): proof of WHAT the seller was shown). Same mechanism as the buyer web
// (apps/web/src/features/consent/policy.ts): one committed, immutable snapshot per SELLER_POLICY_VERSION holding the registry and
// the en/hi notice strings; receipts store its sha256 as `registryHash`. test/consent-policy-snapshot.test.ts fails when the live
// registry or notice strings drift from the snapshot of the current version: bump the version, add a snapshot, never edit an old one.
import * as core from "@cnote/consent/policy";
import v1 from "./policy-snapshots/v1.json";
import v2 from "./policy-snapshots/v2.json";
import { SELLER_POLICY_UPDATED, SELLER_POLICY_VERSION, SELLER_STORAGE_REGISTRY } from "./registry";

/** `consent.*` message keys the seller reads in the banner and dialog. */
export const SELLER_NOTICE_KEYS = [
  "bannerText", "acceptAll", "rejectAll", "customise", "dialogTitle", "dialogIntro", "saveChoices", "alwaysActive", "on", "off", "gpcNote",
  "necessaryTitle", "necessaryDesc", "analyticsTitle", "analyticsDesc", "marketingTitle", "marketingDesc",
  "kind", "provider", "duration", "purpose",
  "policyTitle", // v2: the link text to the cookie policy page shown in the banner and dialog
] as const;
export const SELLER_SNAPSHOT_LOCALES = ["en", "hi"] as const;

export { hashSnapshot, stableStringify } from "@cnote/consent/policy";

/** The snapshot the live code would produce right now. */
export const buildSellerSnapshot = (messages: Record<(typeof SELLER_SNAPSHOT_LOCALES)[number], Record<string, unknown>>) =>
  core.buildSnapshot({ version: SELLER_POLICY_VERSION, updated: SELLER_POLICY_UPDATED, registry: SELLER_STORAGE_REGISTRY, noticeKeys: SELLER_NOTICE_KEYS, locales: SELLER_SNAPSHOT_LOCALES, messages });

/** Committed snapshots by policy version. Add the new file here when bumping SELLER_POLICY_VERSION; never edit an old one. */
export const SELLER_POLICY_SNAPSHOTS: Readonly<Record<number, unknown>> = { 1: v1, 2: v2 };

export const sellerRegistryHashFor = (version: number): string | null => core.registryHashFor(SELLER_POLICY_SNAPSHOTS, version);

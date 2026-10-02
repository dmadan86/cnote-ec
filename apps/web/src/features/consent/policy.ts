// Policy version snapshots (DPDP s.6(10) proof of WHAT the visitor was shown; EDPB 05/2020 "demonstrate consent").
//
// Each CONSENT_POLICY_VERSION has one committed, immutable snapshot in policy-snapshots/v<N>.json holding the storage
// registry and the en/hi notice + category strings. Every receipt records `registryHash` = sha256 of that snapshot, so a
// dispute years later can be answered with the exact text the visitor saw. test/consent-policy-snapshot.test.ts fails when
// the live registry or notice strings drift from the snapshot of the current version: bump the version, add a snapshot.
import * as core from "@cnote/consent/policy";
import type { StorageEntry } from "./registry";
import v1 from "./policy-snapshots/v1.json";
import v3 from "./policy-snapshots/v3.json";
import v4 from "./policy-snapshots/v4.json";
import { CONSENT_POLICY_UPDATED, CONSENT_POLICY_VERSION } from "./state";

/** `consent.*` message keys that make up the notice a visitor reads: banner, dialog, category copy, tables, proof text. */
export const NOTICE_KEYS = [
  "bannerText", "acceptAll", "rejectAll", "customise", "dialogTitle", "dialogIntro", "saveChoices", "alwaysActive", "on", "off", "gpcNote",
  "necessaryTitle", "necessaryDesc", "analyticsTitle", "analyticsDesc", "marketingTitle", "marketingDesc", "functionalTitle", "functionalDesc",
  "kind", "provider", "duration", "purpose", "proofBody", "embedsNote",
] as const;
export const SNAPSHOT_LOCALES = ["en", "hi"] as const;

export { hashSnapshot, stableStringify } from "@cnote/consent/policy";

export type PolicySnapshot = core.PolicySnapshot<(typeof SNAPSHOT_LOCALES)[number]>;

/** The notice subset of a locale's `consent` message namespace, key order independent. */
export const noticeOf = (consentMessages: Record<string, unknown>) => core.noticeOf(consentMessages, NOTICE_KEYS);

/** The snapshot the live code would produce right now. */
export const buildSnapshot = (registry: readonly StorageEntry[], messages: Record<(typeof SNAPSHOT_LOCALES)[number], Record<string, unknown>>): PolicySnapshot =>
  core.buildSnapshot({ version: CONSENT_POLICY_VERSION, updated: CONSENT_POLICY_UPDATED, registry, noticeKeys: NOTICE_KEYS, locales: SNAPSHOT_LOCALES, messages });

/** Committed snapshots by policy version. Add the new file here when bumping CONSENT_POLICY_VERSION; never edit an old one. */
export const POLICY_SNAPSHOTS: Readonly<Record<number, unknown>> = { 1: v1, 3: v3, 4: v4 };

/** sha256 of the committed snapshot of `version`, or null when that version has none (a client claiming an unknown version). */
export const registryHashFor = (version: number): string | null => core.registryHashFor(POLICY_SNAPSHOTS, version);

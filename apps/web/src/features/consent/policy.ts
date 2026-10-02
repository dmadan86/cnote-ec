// Policy version snapshots (DPDP s.6(10) proof of WHAT the visitor was shown; EDPB 05/2020 "demonstrate consent").
//
// Each CONSENT_POLICY_VERSION has one committed, immutable snapshot in policy-snapshots/v<N>.json holding the storage
// registry and the en/hi notice + category strings. Every receipt records `registryHash` = sha256 of that snapshot, so a
// dispute years later can be answered with the exact text the visitor saw. test/consent-policy-snapshot.test.ts fails when
// the live registry or notice strings drift from the snapshot of the current version: bump the version, add a snapshot.
import { createHash } from "node:crypto";
import v1 from "./policy-snapshots/v1.json";
import v2 from "./policy-snapshots/v2.json";
import type { StorageEntry } from "./registry";
import { CONSENT_POLICY_UPDATED, CONSENT_POLICY_VERSION } from "./state";

/** `consent.*` message keys that make up the notice a visitor reads: banner, dialog, category copy, tables, proof text. */
export const NOTICE_KEYS = [
  "bannerText", "acceptAll", "rejectAll", "customise", "dialogTitle", "dialogIntro", "saveChoices", "alwaysActive", "on", "off", "gpcNote",
  "necessaryTitle", "necessaryDesc", "analyticsTitle", "analyticsDesc", "marketingTitle", "marketingDesc",
  "kind", "provider", "duration", "purpose", "proofBody",
] as const;
export const SNAPSHOT_LOCALES = ["en", "hi"] as const;

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface PolicySnapshot {
  version: number;
  updated: string;
  registry: readonly StorageEntry[];
  notice: Record<(typeof SNAPSHOT_LOCALES)[number], Record<string, Json>>;
}

/** The notice subset of a locale's `consent` message namespace, key order independent. */
export function noticeOf(consentMessages: Record<string, unknown>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const k of NOTICE_KEYS) out[k] = (consentMessages[k] ?? null) as Json;
  return out;
}

/** The snapshot the live code would produce right now. */
export function buildSnapshot(registry: readonly StorageEntry[], messages: Record<(typeof SNAPSHOT_LOCALES)[number], Record<string, unknown>>): PolicySnapshot {
  return {
    version: CONSENT_POLICY_VERSION,
    updated: CONSENT_POLICY_UPDATED,
    registry,
    notice: { en: noticeOf(messages.en), hi: noticeOf(messages.hi) },
  };
}

/** JSON with object keys sorted, so the hash does not depend on key order or file formatting. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const hashSnapshot = (snapshot: unknown): string => createHash("sha256").update(stableStringify(snapshot)).digest("hex");

/** Committed snapshots by policy version. Add the new file here when bumping CONSENT_POLICY_VERSION; never edit an old one. */
export const POLICY_SNAPSHOTS: Readonly<Record<number, unknown>> = { 1: v1, 2: v2 };

/** sha256 of the committed snapshot of `version`, or null when that version has none (a client claiming an unknown version). */
export function registryHashFor(version: number): string | null {
  const snap = POLICY_SNAPSHOTS[version];
  return snap ? hashSnapshot(snap) : null;
}

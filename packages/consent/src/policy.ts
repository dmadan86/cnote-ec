// Policy version snapshots (DPDP s.6(10) proof of WHAT the visitor was shown; EDPB 05/2020 "demonstrate consent").
//
// Each app commits, for every CONSENT_POLICY_VERSION, an immutable snapshot holding its storage registry and the notice strings.
// A receipt records `registryHash` = sha256 of that snapshot, so a dispute years later can be answered with the exact text the
// visitor saw. Server / test side only (node:crypto): import from "@cnote/consent/policy", never from client code.
import { createHash } from "node:crypto";
import type { StorageEntry } from "./registry";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface PolicySnapshot<L extends string = string> {
  version: number;
  updated: string;
  registry: readonly StorageEntry[];
  notice: Record<L, Record<string, Json>>;
}

/** The notice subset of one locale's `consent` message namespace (`keys` = the `consent.*` keys the visitor reads), key order independent. */
export function noticeOf(consentMessages: Record<string, unknown>, keys: readonly string[]): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const k of keys) out[k] = (consentMessages[k] ?? null) as Json;
  return out;
}

/** The snapshot the live code would produce right now. */
export function buildSnapshot<L extends string>(o: {
  version: number;
  updated: string;
  registry: readonly StorageEntry[];
  noticeKeys: readonly string[];
  locales: readonly L[];
  messages: Record<L, Record<string, unknown>>;
}): PolicySnapshot<L> {
  const notice = {} as Record<L, Record<string, Json>>;
  for (const l of o.locales) notice[l] = noticeOf(o.messages[l], o.noticeKeys);
  return { version: o.version, updated: o.updated, registry: o.registry, notice };
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

/** sha256 of the committed snapshot of `version`, or null when that version has none (a client claiming an unknown version). */
export function registryHashFor(snapshots: Readonly<Record<number, unknown>>, version: number): string | null {
  const snap = snapshots[version];
  return snap ? hashSnapshot(snap) : null;
}

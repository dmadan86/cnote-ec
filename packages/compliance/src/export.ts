// DPDP right of access (s.11; ADR-010; security audit M10): one export aggregating EVERY module's personal data.
//
// Mirrors the retention registry (retention.ts): each source is a thin wrapper around an `exportPersonalData(personId, ctx)` function
// EXPORTED BY THE OWNING MODULE, so this package never reads another module's tables. Adding a module that stores personal data means
// adding its exporter here (and its purge to RETENTION_POLICIES): the registry test lists both.
//
// Bounded and streamed: every module caps its collections (EXPORT_ROW_CAP, flagged `truncated`), and the response is written section by
// section as JSON with a total byte budget, so one account can never make the server buffer an unbounded document.
import { exportAlertsData } from "@cnote/alerts";
import { exportPersonalData as catalogueExport } from "@cnote/catalogue";
import { EXPORT_TAKE, exportCollection, type PersonalExport, type PersonalExporter } from "@cnote/core";
import { prisma } from "@cnote/db";
import { exportPersonalData as disputesExport } from "@cnote/disputes";
import { exportPersonalData as enquiryExport } from "@cnote/enquiry";
import { exportPersonalData as identityExport, listPersonBusinessIds } from "@cnote/identity";
import { exportPersonalData as leadgenExport } from "@cnote/leadgen";
import { exportPersonalData as notificationsExport } from "@cnote/notifications";
import { exportPersonalData as reviewsExport } from "@cnote/reviews";
import { exportPersonalData as wishlistExport } from "@cnote/wishlist";
import { exportNomineeData } from "./nominee";

export interface ExportSource {
  /** unique, stable: the JSON key of the section (unless `flatten`) */
  module: string;
  description: string;
  /** keep this module's keys at the top level of the document (the original /account/export shape: identity + alerts) */
  flatten?: boolean;
  export: PersonalExporter;
}

/** Cookie-consent receipts linked to the person (the consent ledger itself is exported by identity). */
export async function exportCookieConsentReceipts(personId: string): Promise<PersonalExport> {
  const rows = await prisma.cookieConsentReceipt.findMany({
    where: { personId },
    orderBy: { createdAt: "asc" },
    take: EXPORT_TAKE,
    select: { app: true, policyVersion: true, analytics: true, marketing: true, functional: true, gpc: true, action: true, locale: true, createdAt: true },
  });
  const notices = await prisma.inactivityErasureNotice.findMany({
    where: { personId },
    orderBy: { noticedAt: "asc" },
    take: EXPORT_TAKE,
    select: { noticedAt: true, eraseAfter: true, status: true, resolution: true, resolvedAt: true },
  });
  return { cookieConsentReceipts: exportCollection(rows), inactivityErasureNotices: exportCollection(notices), ...(await exportNomineeData(personId)) };
}

export const EXPORT_SOURCES: readonly ExportSource[] = [
  { module: "identity", flatten: true, description: "Profile, businesses, delivery addresses, consent ledger, login sessions and identities", export: (id) => identityExport(id) },
  { module: "alerts", flatten: true, description: "Followed suppliers, saved searches, alert opt-ins", export: (id) => exportAlertsData(id) },
  { module: "enquiry", description: "Requirements, messages, quotes, orders, deal reports, attachment metadata (incl. scan results and blocked uploads)", export: enquiryExport },
  { module: "reviews", description: "Reviews, comments, product Q&A and reactions", export: (id) => reviewsExport(id) },
  { module: "wishlist", description: "Saved-product lists", export: (id) => wishlistExport(id) },
  { module: "notifications", description: "In-app notifications and channel preferences", export: (id) => notificationsExport(id) },
  { module: "catalogue", description: "Voice-note metadata and transcripts", export: (id) => catalogueExport(id) },
  { module: "leadgen", description: "Lead-capture funnel rows", export: (id) => leadgenExport(id) },
  { module: "disputes", description: "Disputes, evidence statements, messages and appeals", export: disputesExport },
  { module: "compliance", description: "Cookie-consent receipts, inactivity-erasure notices, nominees (decrypted for you) and requests made about your account", export: (id) => exportCookieConsentReceipts(id) },
];

/** JSON.stringify replacer: money is BigInt paise (stringified, exact), everything else is plain data. */
export const jsonReplacer = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);

export interface ExportOptions {
  /** Total size budget in bytes (default EXPORT_MAX_BYTES env, 25 MiB). Sections that would exceed it are left out and listed in `_omitted`. */
  maxBytes?: number;
  sources?: readonly ExportSource[];
  now?: Date;
}

export const DEFAULT_EXPORT_MAX_BYTES = 25 * 1024 * 1024;

export function exportMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.EXPORT_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_EXPORT_MAX_BYTES;
}

/**
 * Async generator of JSON text chunks that, concatenated, form one valid JSON document. Sections are produced one at a time, so memory
 * stays at one module's capped result. A module that throws is reported in `_errors` (the rest of the export still succeeds).
 * Returns nothing for an unknown/erased person (`{}`), like the identity export always did.
 */
export async function* streamPersonalExport(personId: string, opts: ExportOptions = {}): AsyncGenerator<string> {
  const sources = opts.sources ?? EXPORT_SOURCES;
  const budget = opts.maxBytes ?? exportMaxBytes();
  const businessIds = await listPersonBusinessIds(personId);
  const ctx = { businessIds };

  let used = 0;
  let first = true;
  const emit = (key: string, value: unknown, force = false): string | null => {
    const text = `${JSON.stringify(key)}:${JSON.stringify(value, jsonReplacer)}`;
    const bytes = Buffer.byteLength(text) + 1;
    if (!force && used + bytes > budget) return null; // the small `_omitted` / `_errors` markers are always written
    used += bytes;
    const out = `${first ? "" : ","}${text}`;
    first = false;
    return out;
  };

  yield "{";
  const head = emit("exportedAt", (opts.now ?? new Date()).toISOString());
  if (head) yield head;
  const omitted: string[] = [];
  const errors: string[] = [];
  let identityFound = true;
  for (const src of sources) {
    let section: PersonalExport;
    try {
      section = await src.export(personId, ctx);
    } catch (e) {
      console.error(`[compliance] export section ${src.module} failed`, e);
      errors.push(src.module);
      continue;
    }
    if (src.module === "identity" && Object.keys(section).length === 0) {
      identityFound = false;
      break; // unknown or erased person: nothing else to disclose
    }
    const chunks = src.flatten ? Object.entries(section) : [[src.module, section] as const];
    for (const [key, value] of chunks) {
      const text = emit(key, value);
      if (text === null) omitted.push(key);
      else yield text;
    }
  }
  if (!identityFound) {
    yield "}";
    return;
  }
  if (omitted.length) {
    const t = emit("_omitted", omitted, true);
    if (t) yield t;
  }
  if (errors.length) {
    const t = emit("_errors", errors, true);
    if (t) yield t;
  }
  yield "}";
}

/** The same document as a web `ReadableStream` (a Response body). Pulls lazily, so a slow client back-pressures the queries. */
export function personalExportStream(personId: string, opts: ExportOptions = {}): ReadableStream<Uint8Array> {
  const it = streamPersonalExport(personId, opts);
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await it.next();
        if (done) controller.close();
        else controller.enqueue(enc.encode(value));
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      await it.return(undefined);
    },
  });
}

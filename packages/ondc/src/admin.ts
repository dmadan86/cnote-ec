// Back-office reads/actions (ADR-017): participant status (no secrets), redacted message log, failed callbacks + replay.
import { prisma } from "@cnote/db";
import { configStatus, loadConfig, type ConfigStatus } from "./config";
import { replayCallback } from "./outbound";

const PII_KEYS = /^(phone|email|address|gps|tax_number|contact|billing|end|customer|person|name)$/i;

/** Deep-copies a Beckn body, masking buyer contact/address/billing. Keeps ids, items, prices and states. */
export function redactBody(v: unknown, depth = 0, parentKey = ""): unknown {
  if (depth > 12) return "[truncated]";
  if (Array.isArray(v)) return v.map((x) => redactBody(x, depth + 1, parentKey));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) =>
      // provider/item/descriptor names are catalogue data, not personal data
      [k, PII_KEYS.test(k) && !(k.toLowerCase() === "name" && /^(descriptor|provider|item|city|state|country|bpp\/descriptor)$/i.test(parentKey)) ? "[redacted]" : redactBody(x, depth + 1, k)]));
  }
  return v;
}

export interface MessageLogRow {
  id: string; direction: string; action: string; transactionId: string; messageId: string; counterpartyId: string | null;
  status: string; httpStatus: number | null; error: string | null; attempts: number; createdAt: string; body: unknown;
}

export async function listMessages(opts: { direction?: "inbound" | "outbound"; status?: string; limit?: number } = {}): Promise<MessageLogRow[]> {
  const rows = await prisma.ondcMessage.findMany({
    where: { ...(opts.direction ? { direction: opts.direction } : {}), ...(opts.status ? { status: opts.status } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: Math.min(200, opts.limit ?? 50),
  });
  return rows.map((r) => ({ id: r.id, direction: r.direction, action: r.action, transactionId: r.transactionId, messageId: r.messageId, counterpartyId: r.counterpartyId,
    status: r.status, httpStatus: r.httpStatus, error: r.error, attempts: r.attempts, createdAt: r.createdAt.toISOString(), body: redactBody(r.body) }));
}

export const listFailedCallbacks = async (limit = 50): Promise<MessageLogRow[]> =>
  (await listMessages({ direction: "outbound", status: "failed", limit }));

export { replayCallback };

export interface AdminOverview {
  config: ConfigStatus;
  connectedSellers: number;
  optedInListings: number;
  orders: { total: number; created: number };
  failedCallbacks: number;
  failedInbound: number;
}

export async function adminOverview(): Promise<AdminOverview> {
  const [connectedSellers, optedInListings, total, created, failedCallbacks, failedInbound] = await Promise.all([
    prisma.ondcSeller.count({ where: { enabled: true } }),
    prisma.ondcListingOptIn.count(),
    prisma.ondcOrder.count(),
    prisma.ondcOrder.count({ where: { status: "created" } }),
    prisma.ondcMessage.count({ where: { direction: "outbound", status: "failed" } }),
    prisma.ondcMessage.count({ where: { direction: "inbound", status: "failed" } }),
  ]);
  return { config: configStatus(loadConfig()), connectedSellers, optedInListings, orders: { total, created }, failedCallbacks, failedInbound };
}

/** Retention (DPDP, ADR-010): protocol messages carry buyer contact details; keep them 90 days by default. */
export async function purgeOldMessages(olderThanDays = 90, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanDays * 86_400_000);
  return (await prisma.ondcMessage.deleteMany({ where: { createdAt: { lt: cutoff } } })).count;
}

const TERMINAL_ONDC = ["completed", "cancelled"];
type Payload = { context?: unknown; message?: { order?: Record<string, unknown> }; redactedAt?: string };

/**
 * Retention (DPDP, ADR-010): a finished ONDC order's confirm payload holds the network buyer's billing and delivery contact
 * details. After the window, keep the Beckn context and items (needed for callbacks, reconciliation and disputes) and drop
 * billing, fulfilment contact/address and payment blocks. Idempotent (redactedAt marker). Dry-run counts only.
 */
export async function purgeOndcOrderPayloads(before: Date, opts: { dryRun?: boolean; batch?: number } = {}): Promise<number> {
  let cursor: string | undefined;
  let n = 0;
  for (;;) {
    const rows = await prisma.ondcOrder.findMany({
      where: { status: { in: TERMINAL_ONDC }, updatedAt: { lt: before }, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, payload: true }, orderBy: { id: "asc" }, take: opts.batch ?? 500,
    });
    if (rows.length === 0) return n;
    cursor = rows[rows.length - 1]!.id;
    for (const r of rows) {
      const p = (r.payload ?? {}) as Payload;
      if (p.redactedAt) continue;
      n++;
      if (opts.dryRun) continue;
      const order = p.message?.order ?? {};
      const minimal = { context: p.context, message: { order: { id: order.id, items: order.items, provider: order.provider, quote: order.quote } }, redactedAt: new Date().toISOString() };
      await prisma.ondcOrder.update({ where: { id: r.id }, data: { payload: minimal as object } });
    }
  }
}

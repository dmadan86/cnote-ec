// Cookie-consent receipts (ADR-010; DPDP Act 2023 s.6(10): the Data Fiduciary bears the burden of proving that notice was
// given and consent obtained; GDPR Art 7(1)). Written by POST /api/consent of every app that shows a cookie banner (buyer web,
// seller; the `app` column says which: cookies are host-scoped, so each app has its own consent, registry and policy version).
//
// Data minimisation: the receipt holds the random consent id from the browser's cookie, policy version, the per-category
// choices, the Global Privacy Control flag, the action, the language, the browser's timestamp and the sha256 of the policy
// snapshot (registry + notice strings) that was live. NEVER an IP address or user agent.
// Append-only; purged after 3 years by RETENTION_POLICIES ("compliance.cookie_consent_receipts").
//
// Erasure (DPDP s.12(3)/s.8(7)): the receipt carries no direct identifier, so when a person is erased we only NULL its
// `person_id` (anonymizeCookieConsentReceipts) and keep the anonymous proof of what the browser was told and chose.
import { DomainError } from "@cnote/core";
import { prisma, Prisma, withPurge } from "@cnote/db";
import { z } from "zod";
import { isUuid, parse } from "./util";

export const COOKIE_CONSENT_ACTIONS = ["accept_all", "reject_all", "custom", "withdraw"] as const;
/** Apps that can show a cookie banner (mirrors CONSENT_APPS of @cnote/consent; compliance may not depend on it). Set by the server, never by the browser. */
export const COOKIE_CONSENT_APPS = ["web", "seller", "studio", "admin"] as const;
export type CookieConsentApp = (typeof COOKIE_CONSENT_APPS)[number];
export type CookieConsentAction = (typeof COOKIE_CONSENT_ACTIONS)[number];
/** Catalogue locales (apps/web ALL_LOCALES). A receipt records the language the notice was shown in. */
export const CONSENT_LOCALES = ["en", "hi", "kn", "ta", "te", "mr", "gu", "bn"] as const;

export const cookieConsentSchema = z
  .object({
    consentId: z.string().regex(/^[a-f0-9]{32}$/, "consentId must be 32 lowercase hex characters"),
    policyVersion: z.number().int().min(1).max(10_000),
    analytics: z.boolean(),
    marketing: z.boolean(),
    /** Preferences & personalisation. Optional so a receipt queued by an older browser build (no such field) still validates as false. */
    functional: z.boolean().default(false),
    gpc: z.boolean(),
    action: z.enum(COOKIE_CONSENT_ACTIONS),
    locale: z.enum(CONSENT_LOCALES),
    /** unix seconds the browser stamped on the choice; with consentId it makes the write idempotent (a resend is a no-op) */
    at: z.number().int().min(1).max(4_102_444_800).optional(),
  })
  .strict()
  .refine((v) => v.action !== "accept_all" || v.analytics, { message: "accept_all must include analytics", path: ["action"] })
  .refine((v) => v.action !== "reject_all" || (!v.analytics && !v.marketing && !v.functional), { message: "reject_all must not grant anything", path: ["action"] });

export type CookieConsentInput = z.input<typeof cookieConsentSchema>;

export interface CookieConsentReceiptView {
  id: string;
  /** the app whose notice the visitor saw */
  app: CookieConsentApp;
  consentId: string;
  policyVersion: number;
  analytics: boolean;
  marketing: boolean;
  functional: boolean;
  gpc: boolean;
  action: CookieConsentAction;
  locale: string;
  personId: string | null;
  /** the browser's timestamp (unix seconds); null on rows written before idempotent receipts */
  clientAt: number | null;
  /** sha256 of the policy snapshot the visitor saw; null on older rows */
  registryHash: string | null;
  createdAt: string;
}

type ReceiptRow = Prisma.CookieConsentReceiptGetPayload<object>;
const toView = (r: ReceiptRow): CookieConsentReceiptView => ({
  id: r.id,
  app: (COOKIE_CONSENT_APPS as readonly string[]).includes(r.app) ? (r.app as CookieConsentApp) : "web",
  consentId: r.consentId,
  policyVersion: r.policyVersion,
  analytics: r.analytics,
  marketing: r.marketing,
  functional: r.functional,
  gpc: r.gpc,
  action: r.action as CookieConsentAction,
  locale: r.locale,
  personId: r.personId,
  clientAt: r.clientAt,
  registryHash: r.registryHash,
  createdAt: r.createdAt.toISOString(),
});

const HASH_RE = /^[a-f0-9]{64}$/;

/**
 * Validates strictly (unknown keys rejected, DomainError "validation") and appends one receipt. Idempotent on
 * (consentId, at): a resend of an already stored receipt (offline retry, double click) inserts nothing and answers with
 * the stored row (`duplicate: true`).
 * `registryHash` is computed by the caller from the committed policy snapshot of `policyVersion`.
 */
export async function recordCookieConsent(
  input: unknown,
  ctx: { personId?: string | null; registryHash?: string | null; /** which app showed the notice; default "web" */ app?: CookieConsentApp } = {},
): Promise<{ id: string; createdAt: string; duplicate: boolean }> {
  const v = parse(cookieConsentSchema, input);
  const personId = ctx.personId && isUuid(ctx.personId) ? ctx.personId : null;
  const registryHash = ctx.registryHash && HASH_RE.test(ctx.registryHash) ? ctx.registryHash : null;
  const clientAt = v.at ?? null;
  const app = ctx.app && (COOKIE_CONSENT_APPS as readonly string[]).includes(ctx.app) ? ctx.app : "web";
  const data = { app, consentId: v.consentId, policyVersion: v.policyVersion, analytics: v.analytics, marketing: v.marketing, functional: v.functional, gpc: v.gpc, action: v.action, locale: v.locale, personId, clientAt, registryHash };
  if (clientAt === null) {
    const row = await prisma.cookieConsentReceipt.create({ data });
    return { id: row.id, createdAt: row.createdAt.toISOString(), duplicate: false };
  }
  // INSERT ... ON CONFLICT DO NOTHING (createMany + skipDuplicates), then read back whichever row won.
  const { count } = await prisma.cookieConsentReceipt.createMany({ data: [data], skipDuplicates: true });
  const row = await prisma.cookieConsentReceipt.findFirst({ where: { consentId: v.consentId, clientAt } });
  if (!row) throw new DomainError("conflict", "Consent receipt could not be stored");
  return { id: row.id, createdAt: row.createdAt.toISOString(), duplicate: count === 0 };
}

/** Every receipt of one browser consent id, oldest first (evidence lookup for a grievance / the Data Protection Board). */
export async function listCookieConsentReceipts(consentId: string): Promise<CookieConsentReceiptView[]> {
  const rows = await prisma.cookieConsentReceipt.findMany({ where: { consentId }, orderBy: { createdAt: "asc" }, take: 500 });
  return rows.map(toView);
}

// --- staff search (admin consent log) --------------------------------------------------------------------------------

export interface CookieConsentSearch {
  /** free text: a 32-hex consent id or a person uuid (anything else matches nothing) */
  q?: string;
  consentId?: string;
  personId?: string;
  from?: Date;
  /** exclusive upper bound */
  to?: Date;
  policyVersion?: number;
  action?: CookieConsentAction;
  /** only receipts from this app (policy versions are per app) */
  app?: CookieConsentApp;
}

const searchWhere = (f: CookieConsentSearch): Prisma.CookieConsentReceiptWhereInput => {
  const where: Prisma.CookieConsentReceiptWhereInput = {};
  const q = f.q?.trim().toLowerCase();
  let consentId = f.consentId?.trim().toLowerCase();
  let personId = f.personId?.trim().toLowerCase();
  if (q) {
    if (/^[a-f0-9]{32}$/.test(q)) consentId = q;
    else if (isUuid(q)) personId = q;
    else return { id: "00000000-0000-0000-0000-000000000000" }; // an unparseable query matches nothing, never everything
  }
  if (consentId) where.consentId = consentId;
  if (personId) where.personId = isUuid(personId) ? personId : "00000000-0000-0000-0000-000000000000";
  if (f.from || f.to) where.createdAt = { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) };
  if (f.policyVersion !== undefined) where.policyVersion = f.policyVersion;
  if (f.action) where.action = f.action;
  if (f.app) where.app = f.app;
  return where;
};

const encodeCursor = (r: Pick<ReceiptRow, "createdAt" | "id">) => Buffer.from(`${r.createdAt.getTime()}.${r.id}`).toString("base64url");
function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [ms, id] = Buffer.from(cursor, "base64url").toString().split(".");
  if (!ms || !id || !/^\d{1,15}$/.test(ms) || !isUuid(id)) throw new DomainError("validation", "Invalid cursor", { field: "cursor" });
  return { createdAt: new Date(Number(ms)), id };
}

async function page(f: CookieConsentSearch, limit: number, cursor?: string | null): Promise<{ rows: ReceiptRow[]; nextCursor: string | null }> {
  const where = searchWhere(f);
  const c = cursor ? decodeCursor(cursor) : null;
  const rows = await prisma.cookieConsentReceipt.findMany({
    where: c ? { AND: [where, { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] }] } : where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const items = rows.slice(0, limit);
  return { rows: items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]!) : null };
}

/**
 * Newest first, keyset-paginated on (created_at, id) so deep pages stay cheap on a large append-only table.
 * Staff only: call inside admin.audited(ctx, "compliance.consent", ...), as it can return a person id.
 */
export async function searchCookieConsentReceipts(f: CookieConsentSearch & { limit?: number; cursor?: string | null } = {}): Promise<{ items: CookieConsentReceiptView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? 50), 1), 200);
  const { rows, nextCursor } = await page(f, limit, f.cursor);
  return { items: rows.map(toView), nextCursor };
}

/** Streams every matching receipt, newest first, in keyset pages (CSV export). Stops after `maxRows`. */
export async function* iterateCookieConsentReceipts(f: CookieConsentSearch = {}, opts: { pageSize?: number; maxRows?: number } = {}): AsyncGenerator<CookieConsentReceiptView> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 1000, 1), 5000);
  const maxRows = opts.maxRows ?? 500_000;
  let cursor: string | null = null;
  let sent = 0;
  do {
    const { rows, nextCursor }: { rows: ReceiptRow[]; nextCursor: string | null } = await page(f, Math.min(pageSize, maxRows - sent), cursor);
    for (const r of rows) {
      yield toView(r);
      sent++;
    }
    cursor = sent >= maxRows ? null : nextCursor;
  } while (cursor);
}

// --- summary metrics --------------------------------------------------------------------------------------------------

export interface CookieConsentStats {
  from: string;
  to: string;
  total: number;
  /** one row per IST calendar day with at least one receipt, oldest first */
  daily: { day: string; accept_all: number; reject_all: number; custom: number; withdraw: number; total: number }[];
  byLocale: { locale: string; accept_all: number; reject_all: number; custom: number; withdraw: number; total: number }[];
  gpc: { total: number; withGpc: number; /** 0..1, 0 when there are no receipts */ share: number };
  /** receipts whose choice had each category on (a receipt is a choice event, not a person) */
  granted: { analytics: number; marketing: number; functional: number };
}

const DAY_MS = 86_400_000;

/** Pure fold of (day, locale, action, gpc, n) rows into the stats shape (exported for tests). */
export function foldConsentStats(rows: { day: string; locale: string; action: string; gpc: boolean; n: number; analytics?: number; marketing?: number; functional?: number }[], range: { from: Date; to: Date }): CookieConsentStats {
  const blank = () => ({ accept_all: 0, reject_all: 0, custom: 0, withdraw: 0, total: 0 });
  const days = new Map<string, ReturnType<typeof blank>>();
  const locales = new Map<string, ReturnType<typeof blank>>();
  let total = 0;
  let withGpc = 0;
  const granted = { analytics: 0, marketing: 0, functional: 0 };
  for (const r of rows) {
    if (!(COOKIE_CONSENT_ACTIONS as readonly string[]).includes(r.action)) continue;
    const a = r.action as CookieConsentAction;
    const d = days.get(r.day) ?? blank();
    const l = locales.get(r.locale) ?? blank();
    d[a] += r.n; d.total += r.n;
    l[a] += r.n; l.total += r.n;
    days.set(r.day, d);
    locales.set(r.locale, l);
    total += r.n;
    if (r.gpc) withGpc += r.n;
    granted.analytics += r.analytics ?? 0;
    granted.marketing += r.marketing ?? 0;
    granted.functional += r.functional ?? 0;
  }
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    total,
    daily: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, c]) => ({ day, ...c })),
    byLocale: [...locales].sort(([, a], [, b]) => b.total - a.total).map(([locale, c]) => ({ locale, ...c })),
    gpc: { total, withGpc, share: total ? withGpc / total : 0 },
    granted,
  };
}

/**
 * Action mix per day and per language, and the Global Privacy Control share, over [from, to) (default: last 30 days,
 * at most 366). Aggregates only (no ids), so `compliance.read` could see them; the admin page still gates on
 * `compliance.consent`. Days are Asia/Kolkata calendar days.
 */
export async function cookieConsentStats(o: { from?: Date; to?: Date; policyVersion?: number } = {}, now = new Date()): Promise<CookieConsentStats> {
  const to = o.to ?? new Date(now.getTime() + 1);
  const from = o.from ?? new Date(to.getTime() - 30 * DAY_MS);
  if (from >= to) throw new DomainError("validation", "The start date must be before the end date", { field: "from" });
  if (to.getTime() - from.getTime() > 366 * DAY_MS) throw new DomainError("validation", "Choose a range of at most 366 days", { field: "from" });
  const version = o.policyVersion !== undefined ? Prisma.sql`AND policy_version = ${o.policyVersion}` : Prisma.empty;
  const rows = await prisma.$queryRaw<{ day: string; locale: string; action: string; gpc: boolean; n: number; analytics: number; marketing: number; functional: number }[]>(Prisma.sql`
    SELECT to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day, locale, action, gpc, count(*)::int AS n,
           count(*) FILTER (WHERE analytics)::int AS analytics, count(*) FILTER (WHERE marketing)::int AS marketing, count(*) FILTER (WHERE functional)::int AS functional
    FROM cookie_consent_receipts
    WHERE created_at >= ${from} AND created_at < ${to} ${version}
    GROUP BY 1, 2, 3, 4`);
  return foldConsentStats(rows, { from, to });
}

// --- erasure + retention ----------------------------------------------------------------------------------------------

/**
 * DPDP erasure: detach receipts from a person (`person_id` -> NULL) and keep the rest. The remaining row identifies only a
 * browser (random consent id) and is the anonymous proof of notice and choice that s.6(10) and s.8(7) let us retain.
 * Returns how many receipts were detached. Idempotent.
 */
export async function anonymizeCookieConsentReceipts(personId: string, tx: Pick<typeof prisma, "cookieConsentReceipt"> = prisma): Promise<number> {
  if (!isUuid(personId)) return 0;
  return (await tx.cookieConsentReceipt.updateMany({ where: { personId }, data: { personId: null } })).count;
}

/** Retention purge (storage limitation, DPDP s.8(7)): receipts older than `before`. `dryRun` only counts. */
export async function purgeCookieConsentReceipts(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const where = { createdAt: { lt: before } };
  if (opts.dryRun) return prisma.cookieConsentReceipt.count({ where });
  // The table is append-only at the DB level (trigger); the retention purge is the one sanctioned DELETE.
  return withPurge(async (tx) => (await tx.cookieConsentReceipt.deleteMany({ where })).count);
}

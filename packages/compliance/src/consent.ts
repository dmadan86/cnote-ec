// Cookie-consent receipts (ADR-010; DPDP Act 2023 s.6(10): the Data Fiduciary bears the burden of proving that notice was
// given and consent obtained; GDPR Art 7(1)). Written by the buyer web's POST /api/consent after each choice.
//
// Data minimisation: the receipt holds the random consent id from the browser's cookie, policy version, the per-category
// choices, the Global Privacy Control flag, the action, the language and the time. NEVER an IP address or user agent.
// Append-only; purged after 3 years by RETENTION_POLICIES ("compliance.cookie_consent_receipts").
import { prisma } from "@cnote/db";
import { z } from "zod";
import { isUuid, parse } from "./util";

export const COOKIE_CONSENT_ACTIONS = ["accept_all", "reject_all", "custom", "withdraw"] as const;
export type CookieConsentAction = (typeof COOKIE_CONSENT_ACTIONS)[number];
/** Catalogue locales (apps/web ALL_LOCALES). A receipt records the language the notice was shown in. */
export const CONSENT_LOCALES = ["en", "hi", "kn", "ta", "te", "mr", "gu", "bn"] as const;

export const cookieConsentSchema = z
  .object({
    consentId: z.string().regex(/^[a-f0-9]{32}$/, "consentId must be 32 lowercase hex characters"),
    policyVersion: z.number().int().min(1).max(10_000),
    analytics: z.boolean(),
    marketing: z.boolean(),
    gpc: z.boolean(),
    action: z.enum(COOKIE_CONSENT_ACTIONS),
    locale: z.enum(CONSENT_LOCALES),
  })
  .strict()
  .refine((v) => v.action !== "accept_all" || v.analytics, { message: "accept_all must include analytics", path: ["action"] })
  .refine((v) => v.action !== "reject_all" || (!v.analytics && !v.marketing), { message: "reject_all must not grant anything", path: ["action"] });

export type CookieConsentInput = z.input<typeof cookieConsentSchema>;

export interface CookieConsentReceiptView {
  id: string;
  consentId: string;
  policyVersion: number;
  analytics: boolean;
  marketing: boolean;
  gpc: boolean;
  action: CookieConsentAction;
  locale: string;
  personId: string | null;
  createdAt: string;
}

/** Validates strictly (unknown keys rejected, DomainError "validation") and appends one receipt. */
export async function recordCookieConsent(input: unknown, ctx: { personId?: string | null } = {}): Promise<{ id: string; createdAt: string }> {
  const v = parse(cookieConsentSchema, input);
  const personId = ctx.personId && isUuid(ctx.personId) ? ctx.personId : null;
  const row = await prisma.cookieConsentReceipt.create({
    data: { consentId: v.consentId, policyVersion: v.policyVersion, analytics: v.analytics, marketing: v.marketing, gpc: v.gpc, action: v.action, locale: v.locale, personId },
  });
  return { id: row.id, createdAt: row.createdAt.toISOString() };
}

/** Every receipt of one browser consent id, oldest first (evidence lookup for a grievance / the Data Protection Board). */
export async function listCookieConsentReceipts(consentId: string): Promise<CookieConsentReceiptView[]> {
  const rows = await prisma.cookieConsentReceipt.findMany({ where: { consentId }, orderBy: { createdAt: "asc" }, take: 500 });
  return rows.map((r) => ({ id: r.id, consentId: r.consentId, policyVersion: r.policyVersion, analytics: r.analytics, marketing: r.marketing, gpc: r.gpc, action: r.action as CookieConsentAction, locale: r.locale, personId: r.personId, createdAt: r.createdAt.toISOString() }));
}

/** Retention purge (storage limitation, DPDP s.8(7)): receipts older than `before`. `dryRun` only counts. */
export async function purgeCookieConsentReceipts(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const where = { createdAt: { lt: before } };
  if (opts.dryRun) return prisma.cookieConsentReceipt.count({ where });
  return (await prisma.cookieConsentReceipt.deleteMany({ where })).count;
}

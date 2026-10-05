// Retention framework (ADR-010; DPDP Act 2023 s.8(7) storage limitation: erase personal data once the purpose is
// served unless retention is required by law; DPDP Rules 2025 r.8/Third Schedule and the 1-year log retention rule).
//
// Every policy is a thin wrapper around a purge function EXPORTED BY THE OWNING MODULE, so this package never touches
// another module's tables. Each run writes a RetentionRun row (evidence for storage limitation). Windows come from env
// (`RETENTION_<KEY>_DAYS`) with the safe defaults below. Consent ledger rows and admin audit logs are never purged.
import { prisma } from "@cnote/db";
import * as catalogue from "@cnote/catalogue";
import { purgeAttachmentQuarantine, purgeEndedEnquiryAttachments, purgeEnquirySignals, purgeGoodsReceiptPhotos, purgeInactiveConversationMessages, purgePurchaseOrderDocuments, purgeRateContracts } from "@cnote/enquiry";
import { purgeAuditPhotos, purgeErasedPersonResiduals, purgeExpiredAuthSessions, purgeKycDocuments } from "@cnote/identity";
import { purgeAbandonedCaptures } from "@cnote/leadgen";
import { purgeReadNotifications } from "@cnote/notifications";
import { purgeRejectedUgc } from "@cnote/reviews";
import { purgeClosedSamplePersonalData } from "@cnote/samples";
import * as whatsapp from "@cnote/whatsapp";
import { purgeOldDispatches } from "@cnote/alerts";
import { purgeEndedDelegations, purgeResolvedRequests } from "@cnote/approvals";
import { purgeOldInvites } from "@cnote/identity";
import { purgeStaleEmptyWishlists } from "@cnote/wishlist";
import { purgeClosedCreditData } from "@cnote/credit";
import { purgeResolvedDisputeEvidence } from "@cnote/disputes";
import { purgeOldMessages, purgeOndcOrderPayloads } from "@cnote/ondc";
import { purgeOldQualityMedia } from "@cnote/quality";
import { numFromEnv } from "./config";
import { purgeCookieConsentReceipts } from "./consent";
import { INACTIVITY_DEFAULT_DAYS, runInactivityErasure } from "./inactivity";
import { purgeDecidedNomineeRequests } from "./nominee";

const DAY = 86_400_000;

export interface RetentionPolicy {
  /** unique, stable: written to RetentionRun.policy */
  name: string;
  module: string;
  description: string;
  legalBasis: string;
  /** env override: RETENTION_<envKey>_DAYS */
  envKey: string;
  defaultDays: number;
  /** false when the owning purge cannot count without deleting (dry-run then reports 0 and does nothing) */
  supportsDryRun: boolean;
  /** purge everything older than `before`; returns rows affected (dry-run: rows that WOULD be affected) */
  run(before: Date, opts: { dryRun: boolean; now?: Date; windowDays?: number }): Promise<number>;
}

export const windowDays = (p: Pick<RetentionPolicy, "envKey" | "defaultDays">, env: NodeJS.ProcessEnv = process.env): number =>
  numFromEnv(env[`RETENTION_${p.envKey}_DAYS`], p.defaultDays);

/** Normalise the unknown return type of a guarded optional purge (number, or an object with a count-like field). */
export function toCount(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object") {
    for (const k of ["purged", "count", "deleted", "removed"]) {
      const n = (v as Record<string, unknown>)[k];
      if (typeof n === "number") return n;
    }
  }
  return 0;
}

/** Calls an export that another workstream may not have shipped yet; 0 when absent so the build never breaks. */
export async function optionalPurge(ns: unknown, fn: string, args: unknown[], dryRun: boolean): Promise<number> {
  const f = (ns as Record<string, unknown>)[fn];
  if (typeof f !== "function" || dryRun) return 0;
  return toCount(await (f as (...a: unknown[]) => Promise<unknown>)(...args));
}

export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
  {
    name: "enquiry.message_bodies_inactive_24m", module: "enquiry", envKey: "ENQUIRY_MESSAGES", defaultDays: 730, supportsDryRun: true,
    description: "Message bodies in conversations inactive for the window are tombstoned; metadata and events are kept.",
    legalBasis: "DPDP s.8(7) storage limitation; commercial-dispute limitation period (3 years) bounds the outer limit",
    run: (before, { dryRun }) => purgeInactiveConversationMessages(before, { dryRun }),
  },
  {
    name: "identity.auth_sessions_expired_90d", module: "identity", envKey: "AUTH_SESSIONS", defaultDays: 90, supportsDryRun: true,
    description: "Revoked or expired login sessions (IP, user agent) are deleted. The consent ledger is never deleted.",
    legalBasis: "DPDP s.8(7); security logs of the last 90 days kept for incident response",
    run: (before, { dryRun }) => purgeExpiredAuthSessions(before, { dryRun }),
  },
  {
    name: "identity.erased_person_residuals_30d", module: "identity", envKey: "ERASED_RESIDUALS", defaultDays: 30, supportsDryRun: true,
    description: "Residual session rows of persons who exercised the right to erasure.",
    legalBasis: "DPDP s.12(3) right to erasure; s.8(7)",
    run: (before, { dryRun }) => purgeErasedPersonResiduals(before, { dryRun }),
  },
  {
    name: "catalogue.soft_deleted_images_30d", module: "catalogue", envKey: "DELETED_IMAGES", defaultDays: 30, supportsDryRun: true,
    description: "Bytes and rows of listing images the seller deleted. Listing versions are audit history and are kept.",
    legalBasis: "DPDP s.8(7); seller-initiated deletion",
    run: (before, { dryRun }) => catalogue.purgeSoftDeletedImages(before, { dryRun }),
  },
  {
    name: "catalogue.voice_notes_expired", module: "catalogue", envKey: "VOICE_NOTES", defaultDays: 1, supportsDryRun: true,
    description: "Seller voice notes past their per-note purge date (24h without voice_retention consent, 180d with it).",
    legalBasis: "DPDP s.6 consent (purpose-scoped voice_retention); ADR-004/010",
    // Each note carries its own purgeAfter (set from the consent snapshot), so the policy window is not used here.
    run: (_before, { dryRun }) => catalogue.purgeExpiredVoiceNotes(new Date(), { dryRun }),
  },
  {
    name: "whatsapp.message_bodies_retention", module: "whatsapp", envKey: "WHATSAPP_MESSAGES", defaultDays: 30, supportsDryRun: false,
    description: "WhatsApp message bodies and media keys past the retention window.",
    legalBasis: "DPDP s.8(7); message bodies are not stored beyond the window (ADR-004)",
    run: async (before, { dryRun }) => (dryRun ? 0 : whatsapp.purgeWhatsAppMessages(before)),
  },
  {
    name: "identity.kyc_documents_90d", module: "identity", envKey: "KYC_DOCUMENTS", defaultDays: 90, supportsDryRun: true,
    description: "KYC document images 90 days after the session is decided (or expired); masked fields, verdicts and checks are kept as the verification record.",
    legalBasis: "DPDP s.8(7) storage limitation; ADR-003 verification evidence is retained in minimised form",
    run: (before, { dryRun }) => purgeKycDocuments(before, { dryRun }),
  },
  // trust_verif (ADR-002/003)
  {
    name: "identity.audit_photos_365d", module: "identity", envKey: "AUDIT_PHOTOS", defaultDays: 365, supportsDryRun: true,
    description: "Geotagged site photos submitted by T3 audit partners, one year after the audit is decided; the checklist, summary, flags and result are kept as the audit record.",
    legalBasis: "DPDP s.8(7) storage limitation; ADR-003 audit evidence retained in minimised form for the validity period plus a year",
    run: (before, { dryRun }) => purgeAuditPhotos(before, { dryRun }),
  },
  {
    name: "enquiry.fake_lead_signals_90d", module: "enquiry", envKey: "ENQUIRY_SIGNALS", defaultDays: 90, supportsDryRun: true,
    description: "The keyed hash of the buyer's network prefix on fake-lead signals. The risk score, coarse user-agent family, velocity counts and ops label stay for precision/recall.",
    legalBasis: "DPDP s.8(7) storage limitation; the hash is only needed for the 24-hour velocity window (ADR-002)",
    run: (before, { dryRun }) => purgeEnquirySignals(before, { dryRun }),
  },
  {
    name: "disputes.evidence_after_resolution", module: "disputes", envKey: "DISPUTE_EVIDENCE", defaultDays: 1095, supportsDryRun: false,
    description: "Dispute evidence files and statements after the dispute is resolved or withdrawn; decisions and the AI brief summary are kept.",
    legalBasis: "DPDP s.8(7); 3 years covers the limitation period for contract claims (Limitation Act art. 55) pending counsel review (ADR-013)",
    run: async (before, { dryRun }) => (dryRun ? 0 : purgeResolvedDisputeEvidence(before)),
  },
  {
    name: "credit.closed_loan_mirror", module: "credit", envKey: "CREDIT_CLOSED", defaultDays: 2920, supportsDryRun: false,
    description: "Our mirror of closed credit applications and loans (offers, partner shares, repayments, assignments) after the loan closed; the NBFC is lender of record and keeps its own books.",
    legalBasis: "DPDP s.8(7); 8 years covers accounting/tax record keeping (Companies Act s.128) and PMLA pending counsel review (ADR-019)",
    run: async (before, { dryRun }) => (dryRun ? 0 : Object.values(await purgeClosedCreditData(before)).reduce((a, n) => a + (typeof n === "number" ? n : 0), 0)),
  },
  {
    name: "quality.dispatch_photos", module: "quality", envKey: "QUALITY_MEDIA", defaultDays: 180, supportsDryRun: true,
    description: "Pre-dispatch quality-check photos; verdicts, per-check results and staff labels are kept as advisory evidence.",
    legalBasis: "DPDP s.8(7); advisory evidence for disputes raised within the escrow and dispute windows (ADR-015)",
    run: (before, { dryRun }) => purgeOldQualityMedia(before, { dryRun }),
  },
  {
    name: "ondc.protocol_messages", module: "ondc", envKey: "ONDC_MESSAGES", defaultDays: 90, supportsDryRun: false,
    description: "Raw inbound/outbound ONDC protocol messages (may carry network buyer contact details).",
    legalBasis: "DPDP s.8(7); protocol logs kept only for troubleshooting and callback replay (ADR-017)",
    run: async (before, { dryRun }) => (dryRun ? 0 : purgeOldMessages(0, before)),
  },
  {
    name: "ondc.order_buyer_contact", module: "ondc", envKey: "ONDC_ORDER_PAYLOADS", defaultDays: 365, supportsDryRun: true,
    description: "Network buyer billing/delivery contact and payment blocks in finished ONDC orders; context, items and totals are kept.",
    legalBasis: "DPDP s.8(7); order records themselves are kept for tax/accounting (ADR-017)",
    run: (before, { dryRun }) => purgeOndcOrderPayloads(before, { dryRun }),
  },
  {
    name: "samples.closed_request_personal_data", module: "samples", envKey: "SAMPLE_PERSONAL_DATA", defaultDays: 365, supportsDryRun: true,
    description: "Ship-to details, buyer notes and evaluation photos of sample requests that reached a final status; statuses, reasons and amounts are kept (trust record).",
    legalBasis: "DPDP s.8(7); the address is needed only to send the sample, photos only as quality evidence for the bulk order that follows (docs/design/samples.md)",
    run: (before, { dryRun }) => purgeClosedSamplePersonalData(before, { dryRun }),
  },
  {
    name: "leadgen.abandoned_captures_90d", module: "leadgen", envKey: "ABANDONED_CAPTURES", defaultDays: 90, supportsDryRun: true,
    description: "Lead captures that never verified (started, otp_sent, abandoned).",
    legalBasis: "DPDP s.8(7); data minimisation for unconverted funnel data",
    run: (before, { dryRun }) => purgeAbandonedCaptures(before, { dryRun }),
  },
  {
    name: "compliance.cookie_consent_receipts", module: "compliance", envKey: "COOKIE_CONSENT_RECEIPTS", defaultDays: 1095, supportsDryRun: true,
    description: "Cookie-consent receipts (random consent id, policy version, per-category choices, GPC flag, action, language, time; no IP or user agent).",
    legalBasis: "DPDP s.6(10) burden of proof on the Data Fiduciary + s.8(7); 3 years matches the general limitation period (Limitation Act 1963, art. 113) within which a consent dispute could be raised, pending counsel review",
    run: (before, { dryRun }) => purgeCookieConsentReceipts(before, { dryRun }),
  },
  {
    name: "identity.inactive_accounts_erasure", module: "compliance", envKey: "INACTIVE_ACCOUNTS", defaultDays: INACTIVITY_DEFAULT_DAYS, supportsDryRun: true,
    description: "Buyer-side personal accounts with no sign-in for the window are noticed by e-mail at least 48 hours ahead, then erased unless the person came back. Off until INACTIVITY_ERASURE_ENABLED=true.",
    legalBasis: "DPDP Act s.8(7); DPDP Rules 2025 r.8 and Third Schedule (3 years for e-commerce entities above the user threshold; 48-hour prior notice)",
    run: async (_before, { dryRun, now = new Date(), windowDays: days = INACTIVITY_DEFAULT_DAYS }) => {
      const r = await runInactivityErasure({ now, windowMs: days * DAY, dryRun });
      return r.noticed + r.erased + r.cancelled;
    },
  },
  {
    name: "compliance.nominee_requests_decided", module: "compliance", envKey: "NOMINEE_REQUESTS", defaultDays: 1095, supportsDryRun: true,
    description: "Completed or rejected nominee requests (encrypted requester name, contact and message) after the window; revoked nominations are deleted with them.",
    legalBasis: "DPDP s.8(7); 3 years covers the limitation period within which a decision on a deceased or incapacitated principal's data could be challenged, pending counsel review",
    run: (before, { dryRun }) => purgeDecidedNomineeRequests(before, { dryRun }),
  },
  {
    name: "notifications.read_90d", module: "notifications", envKey: "READ_NOTIFICATIONS", defaultDays: 90, supportsDryRun: true,
    description: "In-app notifications the person has read. Unread notifications are kept.",
    legalBasis: "DPDP s.8(7)",
    run: (before, { dryRun }) => purgeReadNotifications(before, { dryRun }),
  },
  {
    name: "reviews.rejected_ugc_12m", module: "reviews", envKey: "REJECTED_UGC", defaultDays: 365, supportsDryRun: true,
    description: "Rejected reviews and comments (never public), after the appeal window.",
    legalBasis: "DPDP s.8(7); IT Rules 2021 appeal window",
    run: (before, { dryRun }) => purgeRejectedUgc(before, { dryRun }),
  },
  {
    name: "wishlist.empty_lists_24m", module: "wishlist", envKey: "EMPTY_WISHLISTS", defaultDays: 730, supportsDryRun: true,
    description: "Empty, non-default wishlists untouched for the window.",
    legalBasis: "DPDP s.8(7)",
    run: (before, { dryRun }) => purgeStaleEmptyWishlists(before, { dryRun }),
  },
  {
    name: "alerts.dispatch_ledger_90d", module: "alerts", envKey: "ALERT_DISPATCHES", defaultDays: 90, supportsDryRun: true,
    description: "Alert dedupe ledger rows (no content); they only need to outlive event redelivery.",
    legalBasis: "DPDP s.8(7)",
    run: (before, { dryRun }) => purgeOldDispatches(before, { dryRun }),
  },
  // ai_ops: RFQ / quote attachments
  {
    name: "enquiry.attachments_after_close_365d", module: "enquiry", envKey: "ENQUIRY_ATTACHMENTS", defaultDays: 365, supportsDryRun: true,
    description: "RFQ drawings/specs and quote attachments (bytes and rows) 365 days after the requirement's quote deadline (or, for legacy rows, once it ended). Requirements that became an order keep theirs 2 more years for disputes.",
    legalBasis: "DPDP s.8(7) storage limitation; one year covers follow-up quotes and repeat orders, and orders keep their drawings for the 3-year limitation period (ADR-013)",
    run: (before, { dryRun }) => purgeEndedEnquiryAttachments(before, { dryRun }),
  },
  {
    name: "enquiry.attachment_quarantine_30d", module: "enquiry", envKey: "ATTACHMENT_QUARANTINE", defaultDays: 30, supportsDryRun: true,
    description: "Bytes of uploads the malware scanner flagged; the record (who, when, signature) stays as the audit trail.",
    legalBasis: "DPDP s.8(7); infected files are kept only long enough for security review",
    run: (before, { dryRun }) => purgeAttachmentQuarantine(before, { dryRun }),
  },
  // --- buyer approvals + team (docs/design/buyer-approvals.md) ---
  {
    name: "approvals.resolved_requests", module: "approvals", envKey: "APPROVAL_RECORDS", defaultDays: 2920, supportsDryRun: true,
    description: "Resolved approval requests and their append-only decision log. Business records: kept 8 years by default, then purged (pending requests are never purged).",
    legalBasis: "Companies Act 2013 s.128 / GST records horizon; DPDP s.8(7)",
    run: (before, { dryRun }) => purgeResolvedRequests(before, { dryRun }),
  },
  {
    name: "approvals.ended_delegations_12m", module: "approvals", envKey: "APPROVAL_DELEGATIONS", defaultDays: 365, supportsDryRun: true,
    description: "Out-of-office delegations that ended or were revoked.",
    legalBasis: "DPDP s.8(7)",
    run: (before, { dryRun }) => purgeEndedDelegations(before, { dryRun }),
  },
  {
    name: "identity.team_invites_30d", module: "identity", envKey: "TEAM_INVITES", defaultDays: 30, supportsDryRun: true,
    description: "Used, revoked and expired team invitations (they hold the invitee's email address).",
    legalBasis: "DPDP s.8(7)",
    run: (before, { dryRun }) => purgeOldInvites(before, { dryRun }),
  },
  // purchase orders / supplier invoices (docs/design/purchase-orders.md)
  {
    name: "enquiry.po_documents_7y", module: "enquiry", envKey: "PO_DOCUMENTS", defaultDays: 2555, supportsDryRun: true,
    description: "Closed purchase orders (cancelled, or on a completed or cancelled order) and settled supplier invoices: delivery contact name/phone are blanked and the stored PDF / uploaded invoice copies are deleted. Numbers, amounts, versions, e-invoice references and payment records are kept.",
    legalBasis: "DPDP s.8(7); the monetary record stays for GST s.36 / Income Tax Act record keeping, so only the personal data and document files go after 7 years",
    run: (before, { dryRun }) => purgePurchaseOrderDocuments(before, { dryRun }),
  },
  // goods receipt notes (docs/design/grn-returns.md)
  {
    name: "enquiry.grn_photos_7y", module: "enquiry", envKey: "GRN_PHOTOS", defaultDays: 2555, supportsDryRun: true,
    description: "Goods receipt notes on completed or cancelled orders: delivery / damage photos are deleted and the receiver's name is erased. Quantities, reason codes, numbers and dates are kept.",
    legalBasis: "DPDP s.8(7); the quantity record stays for GST / Income Tax record keeping, so only the personal data and photos go after 7 years",
    run: (before, { dryRun }) => purgeGoodsReceiptPhotos(before, { dryRun }),
  },
  // rate contracts (docs/design/rate-contracts.md)
  {
    name: "enquiry.rate_contracts_7y", module: "enquiry", envKey: "RATE_CONTRACTS", defaultDays: 2555, supportsDryRun: true,
    description: "Expired or terminated rate contracts: the person who proposed, accepted or placed each step is cleared and notes, change notes, decline reasons and the termination reason are blanked. Numbers, parties, dates, prices, quantities and call-offs are kept.",
    legalBasis: "DPDP s.8(7); the commercial record stays because the orders, purchase orders and invoices it backs are kept for GST / Income Tax record keeping",
    run: (before, { dryRun }) => purgeRateContracts(before, { dryRun }),
  },
];

export interface RetentionResult {
  policy: string;
  module: string;
  dryRun: boolean;
  before: string;
  purged: number;
  error: string | null;
}

export interface RunOptions {
  policies?: readonly RetentionPolicy[];
  dryRun?: boolean;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

/** Runs the given policies (default: all), recording one RetentionRun per policy. A failing policy never stops the rest. */
export async function runRetention(opts: RunOptions = {}): Promise<RetentionResult[]> {
  const { policies = RETENTION_POLICIES, dryRun = false, env = process.env } = opts;
  const now = opts.now ?? new Date();
  const results: RetentionResult[] = [];
  for (const p of policies) {
    const before = new Date(now.getTime() - windowDays(p, env) * DAY);
    const startedAt = new Date();
    let purged = 0;
    let error: string | null = null;
    try {
      purged = await p.run(before, { dryRun, now, windowDays: windowDays(p, env) });
    } catch (e) {
      error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      console.error(`[compliance] retention ${p.name} failed`, e);
    }
    await prisma.retentionRun.create({
      data: { policy: dryRun ? `${p.name} (dry-run)` : p.name, module: p.module, purged, startedAt, finishedAt: new Date(), error },
    });
    results.push({ policy: p.name, module: p.module, dryRun, before: before.toISOString(), purged, error });
  }
  return results;
}

const RUN_EVERY_MS = 23 * 3_600_000;

/**
 * Scheduled tick (call hourly): runs policies whose last real run is older than ~23h, at most `maxPerTick` at a time,
 * so the daily work is staggered across the day instead of hitting the database at once.
 */
export async function runDueRetention(opts: { now?: Date; maxPerTick?: number; dryRun?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<RetentionResult[]> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  if (env.RETENTION_ENABLED === "false") return [];
  const dryRun = opts.dryRun ?? env.RETENTION_DRY_RUN === "true";
  const recent = await prisma.retentionRun.findMany({
    where: { startedAt: { gt: new Date(now.getTime() - RUN_EVERY_MS) }, error: null },
    select: { policy: true },
  });
  const ran = new Set(recent.map((r) => r.policy));
  const due = RETENTION_POLICIES.filter((p) => !ran.has(dryRun ? `${p.name} (dry-run)` : p.name)).slice(0, opts.maxPerTick ?? 2);
  return runRetention({ policies: due, dryRun, now, env });
}

export interface RetentionRunView {
  id: string;
  policy: string;
  module: string;
  purged: number;
  startedAt: string;
  finishedAt: string;
  error: string | null;
}

export async function listRetentionRuns(limit = 100): Promise<RetentionRunView[]> {
  const rows = await prisma.retentionRun.findMany({ orderBy: { startedAt: "desc" }, take: Math.min(Math.max(limit, 1), 500) });
  return rows.map((r) => ({ id: r.id, policy: r.policy, module: r.module, purged: r.purged, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt.toISOString(), error: r.error }));
}

/** Registry for the admin schedule table: policy metadata with the effective window. */
export function describePolicies(env: NodeJS.ProcessEnv = process.env) {
  return RETENTION_POLICIES.map((p) => ({ name: p.name, module: p.module, description: p.description, legalBasis: p.legalBasis, windowDays: windowDays(p, env), supportsDryRun: p.supportsDryRun }));
}

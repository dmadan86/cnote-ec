// Staff RBAC (ADR-010: least privilege on personal data; every privileged action is audited).
// Role → privilege mapping lives in code so it is code-reviewed and versioned. StaffMember.roles
// stores only role codes; privileges are derived at check time, so tightening a role here takes
// effect immediately for everyone holding it. Unknown role codes in the DB grant nothing.

export const PRIVILEGES = [
  "reviews.read", // see the AI human-in-the-loop queue (ADR-008)
  "reviews.resolve", // approve/reject queue items
  "listings.moderate", // final moderation decision on a listing
  "enquiries.review", // release/reject enquiries held for low intent-confidence
  "businesses.read", // seller/business directory, trust profiles, verification records
  "businesses.verify", // manual verification actions (ADR-003)
  "businesses.suspend", // FUTURE: suspend a business; reserved, no UI yet
  "billing.read", // credit balance + ledger
  "billing.adjust", // FUTURE: manual credit adjustments; reserved, no UI yet
  "staff.read", // list staff and their roles
  "staff.manage", // grant / change roles / deactivate staff
  "audit.read", // read the admin audit log
  "ai.decisions.read", // inspect AI decisions (may contain redacted personal data)
  "ugc.read", // see the user-generated content moderation queue (reviews, comments, seller replies)
  "ugc.moderate", // approve/reject user-generated content
  "images.moderate", // approve/reject seller product images (never public before approval)
  "templates.read", // view email/notification templates and layouts
  "templates.manage", // edit drafts, upload template images, send test emails
  "templates.publish", // publish/rollback a template or layout version (goes live to users)
  "api_keys.read", // see users' API keys metadata (never secrets) and usage
  "api_keys.revoke", // revoke a user's API key (abuse/security)
  "queues.read", // inspect job queues and dead letters
  "queues.replay", // replay dead-lettered jobs
  "storefronts.review", // approve/reject flagged storefront versions; suspend storefronts
  "storefronts.templates", // curate the Studio template gallery
  "leadgen.read", // lead-capture funnel analytics (no raw phone numbers)
  "metrics.read", // Phase-1 gate scorecard + metric alerts (aggregates only; resolving an alert is audited)
  "compliance.read", // grievance + appeal queues, retention run log, residency status (contacts are masked)
  "compliance.manage", // respond to grievances, decide appeals, trigger retention dry-runs (all audited)
  "ads.read",
  "ads.review",
  "ads.suspend",
  "ads.fraud.review",
  "ads.settings",
  "promotions.read",
  "promotions.manage",
  "promotions.publish",
  "offers.review",
  "coupons.read",
  "coupons.manage",
  "referrals.review",
  "payments.read",
  "payments.refund",
  "kyc.review",
  "audits.manage",
  // Phase 2 (ADR-012..017), all behind feature flags
  "escrow.read", // escrow agreements, milestones, ledger journal, reconciliation reports
  "escrow.manage", // manual release/refund after reconciliation mismatch; partner webhook replay
  "disputes.read", // dispute cases + AI briefs + evidence (personal data: least privilege)
  "disputes.adjudicate", // decide a dispute (freezes/releases escrow through the outcome)
  "quality.review", // label CV quality-check results (golden set for the >90% accuracy gate)
  "verticals.manage", // vertical playbooks and stage transitions (ADR-016)
  "ondc.manage", // ONDC adapter config, catalogue publish, inbound order log (ADR-017)
] as const;
export type Privilege = (typeof PRIVILEGES)[number];

export const ROLES = ["super_admin", "ops_moderator", "verification_officer", "support", "finance", "marketing", "adjudicator", "viewer"] as const;
export type Role = (typeof ROLES)[number];

const READ_ONLY: readonly Privilege[] = ["reviews.read", "businesses.read", "ai.decisions.read", "ugc.read", "metrics.read", "compliance.read"];

export const ROLE_PRIVILEGES: Record<Role, readonly Privilege[]> = {
  /** Everything, including staff management. Keep the number of holders small (min. 1 enforced). */
  super_admin: PRIVILEGES,
  /** Runs the review queue and content (listing + UGC) moderation. No money, no staff, no audit log. */
  ops_moderator: [
    "reviews.read", "reviews.resolve", "listings.moderate", "enquiries.review", "businesses.read", "ai.decisions.read",
    "ugc.read", "ugc.moderate", "images.moderate", "api_keys.read", "api_keys.revoke", "queues.read",
    "storefronts.review", "metrics.read", "compliance.read", "compliance.manage",
    "ads.read", "ads.review", "ads.suspend", "ads.fraud.review", "offers.review", "promotions.read", "kyc.review",
    "disputes.read", "quality.review", "verticals.manage", "ondc.manage",
  ],
  /** Business verification (ADR-003). Sees the queue read-only for context. */
  verification_officer: ["businesses.read", "businesses.verify", "reviews.read", "kyc.review", "audits.manage"],
  /** Customer support: look up businesses and their credit ledger; cannot change anything. */
  support: ["businesses.read", "billing.read", "reviews.read", "ugc.read", "api_keys.read", "templates.read", "queues.read", "compliance.read", "ads.read", "promotions.read", "coupons.read", "referrals.review", "payments.read"],
  /** Marketing/CRM: owns email + notification copy and layouts (publishing goes live to users). */
  marketing: ["templates.read", "templates.manage", "templates.publish", "businesses.read", "storefronts.templates", "leadgen.read", "metrics.read", "promotions.read", "promotions.manage", "promotions.publish", "coupons.read", "coupons.manage", "ads.read"],
  /** Finance: ledger visibility and (future) credit adjustments, plus audit visibility for reconciliation. */
  finance: ["billing.read", "billing.adjust", "businesses.read", "audit.read", "metrics.read", "ads.read", "ads.fraud.review", "coupons.read", "payments.read", "payments.refund", "escrow.read", "escrow.manage", "disputes.read"],
  /** Dispute adjudication (ADR-013): decides cases using the AI brief; sees escrow state but cannot move money directly. */
  adjudicator: ["disputes.read", "disputes.adjudicate", "escrow.read", "businesses.read", "quality.review", "ai.decisions.read"],
  /** Read-only observer: queue, directory, AI decisions. No billing, staff or audit data. */
  viewer: READ_ONLY,
};

export function isRole(code: string): code is Role {
  return (ROLES as readonly string[]).includes(code);
}

/** Union of privileges for the given role codes (unknown codes ignored). */
export function privilegesFor(roles: readonly string[]): Set<Privilege> {
  const out = new Set<Privilege>();
  for (const r of roles) if (isRole(r)) for (const p of ROLE_PRIVILEGES[r]) out.add(p);
  return out;
}

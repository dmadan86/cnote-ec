// Registry of ADR success metrics. Every metric is computed per IST day from the append-only
// DomainEvent log (ADR-007) by `compute.ts`; the declarative `spec` is turned into aggregate SQL by
// `sql.ts`. Full prose definitions live in docs/design/metrics.md.
//
// Cohort semantics: a metric "of day D" is anchored on the cohort event that occurred on D (e.g.
// leads matched on D). The follow-up event may occur up to `windowDays` later, so the value of a
// day keeps changing until D + windowDays has passed ("matured"). Alerts and the scorecard's
// "latest" only use matured days; the daily job recomputes the trailing 31 days for that reason.

export type MetricUnit = "ratio" | "minutes" | "count" | "per_enquiry";
export type MetricKind = "rate" | "median" | "count" | "average";

export interface MetricTarget {
  value: number;
  /** at_least: value >= target is good. below: value < target is good. */
  direction: "at_least" | "below";
}
export interface MetricAlertRule {
  threshold: number;
  /** "below": raise when value < threshold. "above": raise when value > threshold. */
  direction: "below" | "above";
  /** Minimum denominator (cohort size / sample) before an alert may fire. */
  minSample: number;
}

/** SQL fragments are constants from this file only (never user input). `key` is an SQL expression. */
interface CohortSpec {
  mode: "cohort";
  cohort: { types: string[]; where?: string; key: string; latest?: boolean; flag?: string };
  follow?: { types: string[]; where?: string; key: string; count?: boolean };
  /** payload field on the cohort event holding an enquiryId, used to look up the category */
  categoryViaEnquiry?: boolean;
  /** cohort event itself carries payload.categoryId */
  categoryOwn?: boolean;
  /** median of minutes(cohort -> first follow event) instead of a rate */
  medianMinutes?: boolean;
}
export type MetricSpec =
  | CohortSpec
  | { mode: "median_response" }
  | { mode: "count"; types: string[] }
  | { mode: "snapshot_t1" };

export interface MetricDefinition {
  id: string;
  title: string;
  /** ADR reference, e.g. "ADR-002" */
  adr: string;
  description: string;
  /** exact formula in words */
  formula: string;
  unit: MetricUnit;
  kind: MetricKind;
  /** follow-up window; a day is "matured" once day end + windowDays has passed */
  windowDays: number;
  target?: MetricTarget;
  alert?: MetricAlertRule;
  /** part of the Phase-1 gate scorecard (ADR-v0.1 phase gates) */
  gate: boolean;
  /** available breakdowns beyond overall */
  dimensions: readonly "category"[];
  spec: MetricSpec;
}

const rate = (d: Omit<MetricDefinition, "kind" | "unit" | "dimensions"> & { dimensions?: readonly "category"[] }): MetricDefinition => ({
  kind: "rate",
  unit: "ratio",
  dimensions: [],
  ...d,
});

const alertFromTarget = (t: MetricTarget, minSample: number): MetricAlertRule => ({
  threshold: t.value,
  direction: t.direction === "at_least" ? "below" : "above",
  minSample,
});

const T = {
  leadToConv: { value: 0.6, direction: "at_least" } as MetricTarget,
  convToDeal: { value: 0.15, direction: "at_least" } as MetricTarget,
  refund: { value: 0.1, direction: "below" } as MetricTarget,
  t1: { value: 0.8, direction: "at_least" } as MetricTarget,
  falseBadge: { value: 0.005, direction: "below" } as MetricTarget,
  firstListing: { value: 15, direction: "below" } as MetricTarget,
  onboarding: { value: 0.6, direction: "at_least" } as MetricTarget,
};

const count = (id: string, title: string, adr: string, types: string[], description: string): MetricDefinition => ({
  id,
  title,
  adr,
  description,
  formula: `count of ${types.join(" + ")} events on the day`,
  unit: "count",
  kind: "count",
  windowDays: 0,
  gate: false,
  dimensions: [],
  spec: { mode: "count", types },
});

export const METRICS: readonly MetricDefinition[] = [
  rate({
    id: "lead_to_conversation_rate",
    title: "Lead to first conversation",
    adr: "ADR-002",
    description: "Share of leads matched on the day that started a conversation within 7 days of being matched.",
    formula: "distinct matchId with ConversationStarted within 7d of LeadMatched / distinct matchId with LeadMatched on day",
    windowDays: 7,
    target: T.leadToConv,
    alert: alertFromTarget(T.leadToConv, 20),
    gate: true,
    dimensions: ["category"],
    spec: {
      mode: "cohort",
      cohort: { types: ["LeadMatched"], key: "payload->>'matchId'" },
      follow: { types: ["ConversationStarted"], key: "payload->>'matchId'" },
      categoryViaEnquiry: true,
    },
  }),
  rate({
    id: "conversation_to_deal_rate",
    title: "Conversation to deal (self-reported)",
    adr: "ADR-002",
    description: "Share of conversations started on the day whose match was reported won off-platform within 30 days.",
    formula: "distinct matchId with DealReportedOffPlatform(outcome=won) within 30d / distinct matchId with ConversationStarted on day",
    windowDays: 30,
    target: T.convToDeal,
    alert: alertFromTarget(T.convToDeal, 20),
    gate: true,
    spec: {
      mode: "cohort",
      cohort: { types: ["ConversationStarted"], key: "payload->>'matchId'" },
      follow: { types: ["DealReportedOffPlatform"], where: "payload->>'outcome' = 'won'", key: "payload->>'matchId'" },
    },
  }),
  rate({
    id: "auto_refund_rate",
    title: "Auto-refund rate",
    adr: "ADR-002",
    description: "Share of leads accepted on the day that were refunded within 14 days (unreachable / fake buyer, rejected enquiry).",
    formula: "distinct matchId with LeadRefunded within 14d / distinct matchId with LeadAccepted on day",
    windowDays: 14,
    target: T.refund,
    alert: alertFromTarget(T.refund, 20),
    gate: true,
    dimensions: ["category"],
    spec: {
      mode: "cohort",
      cohort: { types: ["LeadAccepted"], key: "payload->>'matchId'" },
      follow: { types: ["LeadRefunded"], key: "payload->>'matchId'" },
      categoryViaEnquiry: true,
    },
  }),
  {
    id: "leads_per_enquiry",
    title: "Leads per enquiry",
    adr: "ADR-002",
    description: "Average number of sellers an enquiry created on the day is matched to (within 2 days). The ADR caps fan-out to keep leads scarce.",
    formula: "count of LeadMatched within 2d for enquiries created on day / distinct enquiries created on day",
    unit: "per_enquiry",
    kind: "average",
    windowDays: 2,
    gate: false,
    dimensions: ["category"],
    spec: {
      mode: "cohort",
      cohort: { types: ["EnquiryCreated"], key: "payload->>'enquiryId'" },
      follow: { types: ["LeadMatched"], key: "payload->>'enquiryId'", count: true },
      categoryOwn: true,
    },
  },
  {
    id: "median_lead_response_minutes",
    title: "Median lead response time",
    adr: "ADR-002",
    description: "Median time from lead delivery to seller acceptance for leads accepted on the day. SLO: 120 minutes.",
    formula: "median(LeadAccepted.responseMs) / 60000 over LeadAccepted on day",
    unit: "minutes",
    kind: "median",
    windowDays: 0,
    alert: { threshold: 120, direction: "above", minSample: 5 },
    gate: false,
    dimensions: [],
    spec: { mode: "median_response" },
  },
  rate({
    id: "enquiry_review_hold_rate",
    title: "Enquiries held for review",
    adr: "ADR-002",
    description: "Share of enquiries scored on the day that the intent model held for human review (fake-lead precision/recall need labelled data and are not derivable from events).",
    formula: "distinct enquiryId with latest EnquiryScored.needsReview = true / distinct enquiryId with EnquiryScored on day",
    windowDays: 0,
    gate: false,
    dimensions: ["category"],
    spec: {
      mode: "cohort",
      cohort: { types: ["EnquiryScored"], key: "payload->>'enquiryId'", latest: true, flag: "(payload->>'needsReview')::boolean" },
      categoryViaEnquiry: true,
    },
  }),
  rate({
    id: "t1_plus_seller_share",
    title: "Sellers at T1+ (cumulative)",
    adr: "ADR-003",
    description: "Snapshot at end of day: share of all sellers created so far that hold a verification of tier 1 or higher. Approximates 'active sellers at T1+ within 90 days' (no activity or age filter).",
    formula: "distinct businessId with BusinessVerified(tier>=1) / distinct businessId with BusinessCreated(isSeller), both up to end of day",
    windowDays: 0,
    target: T.t1,
    gate: true,
    spec: { mode: "snapshot_t1" },
  }),
  rate({
    id: "false_badge_proxy",
    title: "False-badge proxy (badge revoked <90d)",
    adr: "ADR-003",
    description: "Proxy for false-badge rate: share of businesses verified (tier >= 1) on the day whose trust badge was later switched off within 90 days. Revocation is not always fraud, so this over-estimates.",
    formula: "distinct businessId with TrustScoreChanged(badgeActive=false) within 90d of BusinessVerified / distinct businessId with BusinessVerified(tier>=1) on day",
    windowDays: 90,
    target: T.falseBadge,
    alert: alertFromTarget(T.falseBadge, 50),
    gate: true,
    spec: {
      mode: "cohort",
      cohort: { types: ["BusinessVerified"], where: "(payload->>'tier')::int >= 1", key: "payload->>'businessId'" },
      follow: { types: ["TrustScoreChanged"], where: "(payload->>'badgeActive')::boolean = false", key: "payload->>'businessId'" },
    },
  }),
  {
    id: "time_to_first_listing_median_minutes",
    title: "Time to first listing (median)",
    adr: "ADR-004",
    description: "Median minutes from a seller business being created to its first published listing, for sellers created on the day that published within 30 days. Sellers who never publish are excluded (see onboarding completion).",
    formula: "median(first ListingVersionPublished|ListingPublished - BusinessCreated(isSeller)) in minutes, for sellers created on day publishing within 30d",
    unit: "minutes",
    kind: "median",
    windowDays: 30,
    target: T.firstListing,
    alert: alertFromTarget(T.firstListing, 10),
    gate: true,
    dimensions: [],
    spec: {
      mode: "cohort",
      cohort: { types: ["BusinessCreated"], where: "(payload->>'isSeller')::boolean", key: "payload->>'businessId'" },
      follow: { types: ["ListingVersionPublished", "ListingPublished"], key: "payload->>'sellerBusinessId'" },
      medianMinutes: true,
    },
  },
  rate({
    id: "onboarding_completion_rate",
    title: "Seller onboarding completion",
    adr: "ADR-004",
    description: "Share of sellers created on the day with a published listing within 7 days.",
    formula: "distinct sellers with a listing published within 7d / distinct BusinessCreated(isSeller) on day",
    windowDays: 7,
    target: T.onboarding,
    alert: alertFromTarget(T.onboarding, 10),
    gate: true,
    spec: {
      mode: "cohort",
      cohort: { types: ["BusinessCreated"], where: "(payload->>'isSeller')::boolean", key: "payload->>'businessId'" },
      follow: { types: ["ListingVersionPublished", "ListingPublished"], key: "payload->>'sellerBusinessId'" },
    },
  }),
  rate({
    id: "listing_moderation_reject_rate",
    title: "Listing moderation reject rate",
    adr: "ADR-004",
    description: "Share of listing moderation decisions on the day that rejected the listing or version.",
    formula: "(ListingModerated + ListingVersionReviewed with status=rejected) / (all ListingModerated + ListingVersionReviewed) on day",
    windowDays: 0,
    gate: false,
    spec: {
      mode: "cohort",
      cohort: { types: ["ListingModerated", "ListingVersionReviewed"], key: "id", flag: "payload->>'status' = 'rejected'" },
    },
  }),
  rate({
    id: "ugc_approval_rate",
    title: "UGC approval rate",
    adr: "ADR-008",
    description: "Share of review and comment moderation decisions on the day that approved the content.",
    formula: "(ReviewModerated + CommentModerated with status=approved) / (all ReviewModerated + CommentModerated) on day",
    windowDays: 0,
    gate: false,
    spec: {
      mode: "cohort",
      cohort: { types: ["ReviewModerated", "CommentModerated"], key: "id", flag: "payload->>'status' = 'approved'" },
    },
  }),
  rate({
    id: "leadgen_verified_to_enquiry_rate",
    title: "Lead capture: verified to enquiry",
    adr: "ADR-002",
    description: "Share of OTP-verified lead captures on the day that converted into an enquiry within 7 days. (OTP-sent is not an event; see leadgen.funnelByTriggerDay for start to verified.)",
    formula: "distinct captureId with LeadCaptureConverted within 7d / distinct captureId with LeadCaptureVerified on day",
    windowDays: 7,
    gate: false,
    spec: {
      mode: "cohort",
      cohort: { types: ["LeadCaptureVerified"], key: "payload->>'captureId'" },
      follow: { types: ["LeadCaptureConverted"], key: "payload->>'captureId'" },
    },
  }),
  count("leads_accepted", "Leads accepted", "ADR-002", ["LeadAccepted"], "Leads accepted by sellers (volume context for the rates)."),
  count("enquiries_created", "Enquiries created", "ADR-002", ["EnquiryCreated"], "Enquiries created by buyers."),
  count("orders_recorded", "Orders recorded", "ADR-007", ["OrderRecorded"], "Orders recorded against a match (off-platform in Phase 1)."),
  count("subscription_starts", "Subscription starts", "ADR-005", ["SubscriptionStarted"], "Plan subscriptions started."),
  count("subscription_cancels", "Subscription cancels", "ADR-005", ["SubscriptionCancelled"], "Plan subscriptions cancelled."),
  count("credits_consumed", "Credits consumed", "ADR-005", ["CreditConsumed"], "Credit ledger consumptions (lead unlocks)."),
  count("credits_refunded", "Credits refunded", "ADR-005", ["CreditRefunded"], "Credit ledger refunds."),
  // ---- Phase 2 (flagged modules; these stay empty until the flags are on) ----
  rate({
    id: "escrow_dispute_refund_rate",
    title: "Escrow orders refunded after a dispute",
    adr: "ADR-012",
    description: "Share of escrows funded on the day that were (partly) refunded to the buyer by a dispute decision within 60 days. Proxy for the escrow-order fraud rate (target < 0.5%).",
    formula: "distinct escrowId with EscrowRefunded(cause=dispute_resolution) within 60d / distinct escrowId with EscrowFunded on day",
    windowDays: 60,
    target: { value: 0.005, direction: "below" },
    alert: { threshold: 0.005, direction: "above", minSample: 50 },
    gate: false,
    spec: {
      mode: "cohort",
      cohort: { types: ["EscrowFunded"], key: "payload->>'escrowId'" },
      follow: { types: ["EscrowRefunded"], where: "payload->>'cause' = 'dispute_resolution'", key: "payload->>'escrowId'" },
    },
  }),
  {
    id: "escrow_payout_minutes",
    title: "Escrow payout latency",
    adr: "ADR-012",
    description: "Median minutes from escrow release to the seller payout settling, for releases on the day. Target: under 1 business day.",
    formula: "median(first PayoutSettled - EscrowReleased) in minutes, per escrowId released on day, within 7d",
    unit: "minutes",
    kind: "median",
    windowDays: 7,
    target: { value: 1440, direction: "below" },
    alert: { threshold: 1440, direction: "above", minSample: 5 },
    gate: false,
    dimensions: [],
    spec: {
      mode: "cohort",
      cohort: { types: ["EscrowReleased"], key: "payload->>'escrowId'" },
      follow: { types: ["PayoutSettled"], key: "payload->>'escrowId'" },
      medianMinutes: true,
    },
  },
  {
    id: "dispute_resolution_minutes",
    title: "Dispute time to resolution",
    adr: "ADR-013",
    description: "Median minutes from a dispute being opened to its resolution, for disputes opened on the day. SLA: 7 days median.",
    formula: "median(DisputeResolved - DisputeOpened) in minutes, per disputeId opened on day, within 30d",
    unit: "minutes",
    kind: "median",
    windowDays: 30,
    target: { value: 10_080, direction: "below" },
    alert: { threshold: 10_080, direction: "above", minSample: 5 },
    gate: false,
    dimensions: [],
    spec: {
      mode: "cohort",
      cohort: { types: ["DisputeOpened"], key: "payload->>'disputeId'" },
      follow: { types: ["DisputeResolved"], key: "payload->>'disputeId'" },
      medianMinutes: true,
    },
  },
  rate({
    id: "quote_draft_approval_rate",
    title: "Quote-assist drafts approved",
    adr: "ADR-014",
    description: "Share of AI quote drafts generated on the day that the seller approved (edited or not) within 7 days.",
    formula: "distinct draftId with QuoteDraftApproved within 7d / distinct draftId with QuoteDraftGenerated on day",
    windowDays: 7,
    gate: false,
    spec: {
      mode: "cohort",
      cohort: { types: ["QuoteDraftGenerated"], key: "payload->>'draftId'" },
      follow: { types: ["QuoteDraftApproved"], key: "payload->>'draftId'" },
    },
  }),
  rate({
    id: "credit_npa_rate_proxy",
    title: "Credit loans reaching 90+ DPD (GNPA proxy)",
    adr: "ADR-019",
    description: "Count-based proxy for partner GNPA on the Platform-originated book: share of loans disbursed on the day that crossed into the 90+ days-past-due bucket within 180 days. The true GNPA is outstanding-weighted (needs per-loan outstanding, see docs/ops/monitoring.md) and lives in @cnote/credit (computeGnpa). Loans later repaid are not netted out, so this over-estimates.",
    formula: "distinct loanId with CreditOverdue(dpd>=90) within 180d / distinct loanId with CreditDisbursed on day",
    windowDays: 180,
    target: { value: 0.02, direction: "below" },
    alert: { threshold: 0.02, direction: "above", minSample: 50 },
    gate: false,
    spec: {
      mode: "cohort",
      cohort: { types: ["CreditDisbursed"], key: "payload->>'loanId'" },
      follow: { types: ["CreditOverdue"], where: "(payload->>'dpd')::int >= 90", key: "payload->>'loanId'" },
    },
  }),
  rate({
    id: "credit_attached_order_share",
    title: "Escrowed orders with credit attached",
    adr: "ADR-019",
    description: "Order-count proxy for 'credit-attached orders >= 15% of escrowed GMV': share of orders whose escrow was funded on the day that had a loan disbursed within 30 days. GMV-weighted share needs escrow amounts joined to loan amounts (@cnote/credit creditAttachedGmvShare).",
    formula: "distinct orderId with CreditDisbursed within 30d / distinct orderId with EscrowFunded on day",
    windowDays: 30,
    target: { value: 0.15, direction: "at_least" },
    alert: { threshold: 0.15, direction: "below", minSample: 50 },
    gate: false,
    spec: {
      mode: "cohort",
      cohort: { types: ["EscrowFunded"], key: "payload->>'orderId'" },
      follow: { types: ["CreditDisbursed"], key: "payload->>'orderId'" },
    },
  }),
  rate({
    id: "dispute_auto_resolution_rate",
    title: "Disputes auto-resolved",
    adr: "ADR-013",
    description: "Share of disputes opened on the day that were resolved automatically (clear, low-value, high-confidence) within 30 days. Context for the 7-day SLA; no target in the ADR.",
    formula: "distinct disputeId with DisputeResolved(decidedBy=auto) within 30d / distinct disputeId with DisputeOpened on day",
    windowDays: 30,
    gate: false,
    spec: {
      mode: "cohort",
      cohort: { types: ["DisputeOpened"], key: "payload->>'disputeId'" },
      follow: { types: ["DisputeResolved"], where: "payload->>'decidedBy' = 'auto'", key: "payload->>'disputeId'" },
    },
  }),
  rate({
    id: "escrow_conversion_rate",
    title: "Accepted leads converted to escrowed orders",
    adr: "ADR-012",
    description: "Share of leads accepted on the day whose order was funded through escrow within 60 days. Phase-2 target: at least 20%.",
    formula: "distinct matchId with EscrowFunded(v2, matchId) within 60d / distinct matchId with LeadAccepted on day",
    windowDays: 60,
    target: { value: 0.2, direction: "at_least" },
    alert: { threshold: 0.2, direction: "below", minSample: 50 },
    gate: false,
    spec: {
      mode: "cohort",
      cohort: { types: ["LeadAccepted"], key: "payload->>'matchId'" },
      follow: { types: ["EscrowFunded"], where: "payload->>'matchId' IS NOT NULL", key: "payload->>'matchId'" },
    },
  }),
  count("escrows_funded", "Escrows funded", "ADR-012", ["EscrowFunded"], "Orders whose buyer funded escrow through the PA partner."),
  count("ondc_orders_received", "ONDC orders received", "ADR-017", ["OndcOrderReceived"], "Orders received from the ONDC network."),
  count("ondc_issues_received", "ONDC issues received", "ADR-021", ["OndcIssueReceived"], "Network (IGM) issues received; each opens a dispute."),
  count("credit_disbursals", "Credit disbursals", "ADR-019", ["CreditDisbursed"], "Loans disbursed by the NBFC partner on escrowed orders (GNPA and attached-GMV share: credit admin page)."),
  count("credit_overdue_events", "Credit loans entering a new DPD bucket", "ADR-019", ["CreditOverdue"], "Loans crossing into a higher days-past-due bucket (1/30/60/90)."),
  count("agent_negotiations_closed", "Agent negotiations closed", "ADR-020", ["AgentNegotiationClosed"], "Structured agent negotiations that ended (accepted, rejected, expired or withdrawn)."),
  count("price_benchmark_runs", "Price benchmark publications", "ADR-022", ["PriceBenchmarkPublished"], "Nightly k-anonymous price benchmark publications."),
];

export const METRIC_BY_ID: ReadonlyMap<string, MetricDefinition> = new Map(METRICS.map((m) => [m.id, m]));

export function getDefinition(id: string): MetricDefinition | undefined {
  return METRIC_BY_ID.get(id);
}

/** Evaluate a value against the ADR target. */
export function meetsTarget(t: MetricTarget, value: number): boolean {
  return t.direction === "at_least" ? value >= t.value : value < t.value;
}

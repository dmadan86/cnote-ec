// Applications -> offers -> explicit acceptance (ADR-019). Nothing is ever auto-accepted; the KFS is shown first and its
// version must be acknowledged. Partner calls happen outside DB transactions; every state change + event is one transaction.
import { DomainError, emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { coolingOffQuotesFor, type CoolingOffQuote } from "./cooling";
import { assertCreditEnabled, creditConfig, creditEnabled } from "./config";
import { actorHasCreditConsent, hasActiveCreditConsent } from "./consent";
import { DEFAULT_TENOR_DAYS, TENORS, assessEligibility, maxAmount, type Eligibility } from "./eligibility";
import { buildKfs, interestPaise, totalRepayablePaise } from "./kfs";
import { type CreditFeatures } from "./model";
import { getCreditPartner, type PartnerApplicationRequest, type PartnerOffer } from "./partner";
import { ports } from "./ports";
import { computeAndStoreScore, gatherFeatures, getLatestScore, listScoreHistory } from "./score";
import { ACTIVE_APPLICATION_STATUSES, type Actor, type ApplicationView, type LoanView, type Product, type ScoreView } from "./types";
import { toApplicationViews, toLoanView } from "./views";

const UUID = /^[0-9a-f-]{36}$/i;

/** The exact keys (never raw GST returns, GSTIN or contact data) that reach the partner. */
export function minimalFeatures(f: CreditFeatures): Record<string, number | boolean | null> {
  return {
    gstVerified: f.gstVerified, gstActive: f.gstActive, gstVerifiedAgeDays: f.gstVerifiedAgeDays,
    gstFilingsFiledRatio: f.gstFilingsTotal > 0 ? Math.round((f.gstFilingsFiled / f.gstFilingsTotal) * 100) / 100 : null,
    escrowCompleted: f.escrowCompleted, escrowVolumePaise: f.escrowVolumePaise, escrowCleanRatio: f.escrowCompleted > 0 ? Math.round((f.escrowClean / f.escrowCompleted) * 100) / 100 : null,
    escrowRefunded: f.escrowRefunded, disputesLost: f.disputesLost, disputesOpen: f.disputesOpen, trustScore: f.trustScore, badgeActive: f.badgeActive,
  };
}

export function buildPartnerRequest(a: { applicationId: string; product: Product; amountPaise: number; tenorDays: number; businessId: string; escrowId: string; orderId: string; orderAmountPaise: number }, score: ScoreView, features: CreditFeatures): PartnerApplicationRequest {
  return {
    applicationRef: a.applicationId, product: a.product, amountPaise: a.amountPaise, tenorDays: a.tenorDays, borrowerRef: a.businessId,
    score: { value: score.score, band: score.band, modelVersion: score.modelVersion, reasonCodes: score.reasons.filter((r) => r.direction === "negative").map((r) => r.code) },
    features: minimalFeatures(features),
    collateral: { kind: "escrow", escrowRef: a.escrowId, orderRef: a.orderId, orderAmountPaise: a.orderAmountPaise },
  };
}

export interface ApplyInput { product: Product; escrowId: string; amountPaise?: number; tenorDays?: number }

async function assess(actor: Actor, input: ApplyInput, score: ScoreView, features: CreditFeatures, requested?: number) {
  const facts = await ports().escrowFacts(input.escrowId);
  if (!facts) throw new DomainError("not_found", "Escrow not found.", undefined, "credit.escrowNotFound");
  const net = ports().sellerNetPaise(facts.amountPaise);
  const e = assessEligibility({ product: input.product, businessId: actor.businessId, escrow: facts, score, features, sellerNetPaise: net, requestedAmountPaise: requested });
  return { facts, net, e };
}

const REASON_TEXT: Record<string, string> = {
  not_your_order: "This order is not yours to finance.", gst_not_verified: "Verify your GST registration first.", gst_inactive: "Your GST registration is not active.",
  score_too_low: "Your credit score is below the lender's minimum for this product.", escrow_frozen: "A dispute is open on this order.",
  escrow_not_funded: "The buyer has not funded the escrow yet.", escrow_already_funded: "This escrow is already funded.", escrow_closed: "This escrow is closed.",
  amount_too_small: "The amount is below the minimum.", amount_exceeds_limit: "The amount is above your limit for this order.", no_consent: "Consent is required.",
};

export async function applyForFinancing(actor: Actor, input: ApplyInput): Promise<ApplicationView> {
  assertCreditEnabled();
  if (!UUID.test(input.escrowId)) throw new DomainError("not_found", "Escrow not found.", undefined, "credit.escrowNotFound");
  if (!(await actorHasCreditConsent(actor))) throw new DomainError("forbidden", "Consent to credit underwriting is required before you can apply.");
  const tenorDays = input.tenorDays ?? DEFAULT_TENOR_DAYS;
  if (!TENORS[input.product].includes(tenorDays)) throw new DomainError("validation", "Choose one of the offered repayment periods.");
  const score = await computeAndStoreScore(actor.businessId, "application");
  if (!score) throw new DomainError("forbidden", "Consent to credit underwriting is required before you can apply.");
  const features = await gatherFeatures(actor.businessId);
  const first = await assess(actor, input, score, features);
  const amountPaise = input.amountPaise ?? first.e.maxAmountPaise;
  const { facts, e } = await assess(actor, input, score, features, amountPaise);
  if (!e.eligible) throw new DomainError("conflict", REASON_TEXT[e.reasons[0]!] ?? "Not eligible.", { reasons: e.reasons });

  const partner = getCreditPartner();
  const req0 = { product: input.product, amountPaise, tenorDays, businessId: actor.businessId, escrowId: facts.escrowId, orderId: facts.orderId, orderAmountPaise: facts.amountPaise };
  const app = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`credit:${input.product}:${facts.escrowId}`}, 0))`;
    const dup = await tx.creditApplication.findFirst({ where: { product: input.product, escrowId: facts.escrowId, status: { in: [...ACTIVE_APPLICATION_STATUSES] } } });
    if (dup) throw new DomainError("conflict", "There is already an active credit application for this order.");
    const row = await tx.creditApplication.create({
      data: {
        businessId: actor.businessId, product: input.product, escrowId: facts.escrowId, orderId: facts.orderId,
        counterpartyBusinessId: input.product === "bnpl" ? facts.sellerBusinessId : facts.buyerBusinessId,
        orderAmountPaise: BigInt(facts.amountPaise), amountPaise: BigInt(amountPaise), tenorDays, partner: partner.name, status: "submitted", scoreId: score.id,
      },
    });
    const request = buildPartnerRequest({ applicationId: row.id, ...req0 }, score, features);
    await tx.creditPartnerShare.create({ data: { businessId: actor.businessId, applicationId: row.id, partner: partner.name, fields: Object.keys({ ...request.features, score: 1, band: 1, collateral: 1 }) as never } });
    await emit(tx, "CreditApplicationSubmitted", { type: "credit_application", id: row.id }, {
      applicationId: row.id, businessId: actor.businessId, product: input.product, amountPaise, partner: partner.name, orderId: facts.orderId,
    });
    return { row, request };
  });

  let result;
  try {
    result = await partner.submitApplication(app.request);
  } catch (err) {
    console.error("[credit] partner submit failed", err);
    await prisma.creditApplication.update({ where: { id: app.row.id }, data: { status: "failed", reason: "partner_unavailable", closedAt: new Date() } });
    throw new DomainError("conflict", "Our lending partner is unavailable right now. Please try again later.");
  }
  await storeSubmitResult(app.row.id, input.product, partner.lender, result);
  const [view] = await toApplicationViews([(await prisma.creditApplication.findUniqueOrThrow({ where: { id: app.row.id } }))]);
  return view!;
}

/** Persist partner offers with their KFS (used by the synchronous submit path and the application.offered webhook). */
export async function storeOffers(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], applicationId: string, product: Product, lender: { name: string; grievance: { name: string; email: string; phone: string } }, offers: PartnerOffer[], now = new Date()): Promise<number> {
  const cfg = creditConfig();
  let stored = 0;
  for (const o of offers) {
    const terms = { principalPaise: o.amountPaise, aprBps: o.aprBps, tenorDays: o.tenorDays, processingFeePaise: o.processingFeePaise, otherFeesPaise: o.otherFeesPaise };
    const expiresAt = new Date(Math.min(o.expiresAt?.getTime() ?? Infinity, now.getTime() + cfg.offerTtlHours * 3_600_000));
    const made = await tx.creditOffer.createMany({
      skipDuplicates: true,
      data: [{
        applicationId, partnerOfferRef: o.offerRef, amountPaise: BigInt(o.amountPaise), aprBps: o.aprBps, tenorDays: o.tenorDays, processingFeePaise: BigInt(o.processingFeePaise), otherFeesPaise: BigInt(o.otherFeesPaise),
        interestPaise: BigInt(interestPaise(o.amountPaise, o.aprBps, o.tenorDays)), totalRepayablePaise: BigInt(totalRepayablePaise(terms)), kfs: buildKfs(product, terms, lender) as never, status: "open", expiresAt,
      }],
    });
    if (made.count === 0) continue;
    const row = await tx.creditOffer.findUniqueOrThrow({ where: { applicationId_partnerOfferRef: { applicationId, partnerOfferRef: o.offerRef } } });
    await emit(tx, "CreditOfferReceived", { type: "credit_application", id: applicationId }, { applicationId, offerId: row.id, amountPaise: o.amountPaise, aprBps: o.aprBps, tenorDays: o.tenorDays });
    stored += 1;
  }
  return stored;
}

async function storeSubmitResult(applicationId: string, product: Product, lender: Parameters<typeof storeOffers>[3], r: { partnerRef: string; status: string; offers: PartnerOffer[]; reason?: string }): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (r.status === "rejected") {
      await tx.creditApplication.update({ where: { id: applicationId }, data: { partnerRef: r.partnerRef, status: "rejected", reason: r.reason ?? "rejected_by_partner", closedAt: new Date() } });
      return;
    }
    await tx.creditApplication.update({ where: { id: applicationId }, data: { partnerRef: r.partnerRef, status: r.status === "offered" && r.offers.length ? "offered" : "submitted" } });
    if (r.offers.length) await storeOffers(tx, applicationId, product, lender, r.offers);
  });
}

export interface AcceptInput { offerId: string; /** the borrower confirms they have read the Key Fact Statement */ acknowledgedKfs: boolean; kfsVersion: string }

/** Explicit acceptance. Requires the KFS acknowledgement, a live offer, active consent and (invoice financing) a still-funded, unfrozen escrow. */
export async function acceptOffer(actor: Actor, input: AcceptInput): Promise<ApplicationView> {
  assertCreditEnabled();
  if (!UUID.test(input.offerId)) throw new DomainError("not_found", "Offer not found.");
  if (input.acknowledgedKfs !== true) throw new DomainError("validation", "Please confirm that you have read the Key Fact Statement.");
  const offer = await prisma.creditOffer.findUnique({ where: { id: input.offerId } });
  const app = offer ? await prisma.creditApplication.findUnique({ where: { id: offer.applicationId } }) : null;
  if (!offer || !app || app.businessId !== actor.businessId) throw new DomainError("not_found", "Offer not found.");
  const kfs = offer.kfs as { version?: string };
  if (kfs.version !== input.kfsVersion) throw new DomainError("validation", "The terms have changed. Please review the Key Fact Statement again.");
  if (offer.status !== "open" || app.status !== "offered") throw new DomainError("conflict", "This offer is no longer open.");
  if (offer.expiresAt.getTime() <= Date.now()) throw new DomainError("conflict", "This offer has expired.");
  if (!(await actorHasCreditConsent(actor))) throw new DomainError("forbidden", "Consent to credit underwriting is required.");
  const facts = await ports().escrowFacts(app.escrowId);
  const okEscrow = !!facts && !facts.frozen && (app.product === "invoice_financing" ? facts.status === "funded" : facts.status === "created" || facts.status === "awaiting_funding");
  if (!okEscrow) throw new DomainError("conflict", "The escrow for this order has changed, so this offer can no longer be accepted.", undefined, "credit.escrowOrderChangedOfferNo");
  const partner = getCreditPartner(app.partner);
  const acceptedAt = new Date();
  const claim = await prisma.$transaction(async (tx) => {
    const c = await tx.creditOffer.updateMany({ where: { id: offer.id, status: "open" }, data: { status: "accepted", acceptedAt, acceptedByPersonId: actor.personId } });
    if (c.count === 0) return false;
    await tx.creditApplication.update({ where: { id: app.id }, data: { status: "accepted", acceptedOfferId: offer.id } });
    return true;
  });
  if (!claim) throw new DomainError("conflict", "This offer is no longer open.");
  try {
    const r = await partner.acceptOffer(app.partnerRef ?? "", offer.partnerOfferRef, { acceptedAt, personRef: actor.personId });
    if (r.status !== "accepted") throw new Error(r.reason ?? "partner refused");
  } catch (err) {
    console.error("[credit] partner accept failed", err);
    await prisma.$transaction(async (tx) => {
      await tx.creditOffer.update({ where: { id: offer.id }, data: { status: "open", acceptedAt: null, acceptedByPersonId: null } });
      await tx.creditApplication.update({ where: { id: app.id }, data: { status: "offered", acceptedOfferId: null } });
    });
    throw new DomainError("conflict", "Our lending partner could not confirm your acceptance. Nothing was charged. Please try again.", undefined, "credit.lendingPartnerCouldNotConfirm");
  }
  return getApplication(actor, app.id);
}

export async function declineOffer(actor: Actor, offerId: string): Promise<ApplicationView> {
  if (!UUID.test(offerId)) throw new DomainError("not_found", "Offer not found.");
  const offer = await prisma.creditOffer.findUnique({ where: { id: offerId } });
  const app = offer ? await prisma.creditApplication.findUnique({ where: { id: offer.applicationId } }) : null;
  if (!offer || !app || app.businessId !== actor.businessId) throw new DomainError("not_found", "Offer not found.");
  if (offer.status !== "open") throw new DomainError("conflict", "This offer is no longer open.");
  await prisma.$transaction(async (tx) => {
    await tx.creditOffer.updateMany({ where: { applicationId: app.id, status: "open" }, data: { status: "declined" } });
    await tx.creditApplication.update({ where: { id: app.id }, data: { status: "declined", reason: "declined_by_borrower", closedAt: new Date() } });
  });
  return getApplication(actor, app.id);
}

export async function getApplication(actor: Actor, id: string): Promise<ApplicationView> {
  const a = UUID.test(id) ? await prisma.creditApplication.findUnique({ where: { id } }) : null;
  if (!a || a.businessId !== actor.businessId) throw new DomainError("not_found", "Application not found.", undefined, "credit.applicationNotFound");
  return (await toApplicationViews([a]))[0]!;
}

export async function listApplications(actor: Actor, opts: { limit?: number } = {}): Promise<ApplicationView[]> {
  const rows = await prisma.creditApplication.findMany({ where: { businessId: actor.businessId }, orderBy: { createdAt: "desc" }, take: Math.min(opts.limit ?? 50, 100) });
  return toApplicationViews(rows);
}

export async function listLoans(actor: Actor, opts: { limit?: number } = {}): Promise<LoanView[]> {
  const rows = await prisma.creditLoan.findMany({ where: { businessId: actor.businessId }, orderBy: { disbursedAt: "desc" }, take: Math.min(opts.limit ?? 50, 100) });
  const reps = await prisma.creditRepayment.findMany({ where: { loanId: { in: rows.map((l) => l.id) } }, orderBy: { paidAt: "asc" } });
  return rows.map((l) => toLoanView(l, reps.filter((r) => r.loanId === l.id)));
}

export interface EligibleOrder { escrowId: string; orderId: string; amountPaise: number; sellerNetPaise: number; maxAdvancePaise: number; applied: boolean }
export interface CreditOverview {
  enabled: boolean;
  consented: boolean;
  score: ScoreView | null;
  history: ScoreView[];
  /** reasons the seller currently cannot use invoice financing (empty when eligible orders exist or none are funded) */
  blockers: string[];
  eligible: EligibleOrder[];
  applications: ApplicationView[];
  loans: LoanView[];
  lender: { name: string; grievance: { name: string; email: string; phone: string } };
  coolingOffDays: number;
  /** loans that can still exit inside the cooling-off period, with the exact amount owed today (keyed by loan id) */
  exitQuotes: Record<string, CoolingOffQuote>;
}

/** Seller-portal snapshot. Score-derived parts are empty without consent. */
export async function getCreditOverview(actor: Actor): Promise<CreditOverview> {
  const cfg = creditConfig();
  const consented = await actorHasCreditConsent(actor);
  const score = consented ? (await computeAndStoreScore(actor.businessId, "portal_view")) ?? (await getLatestScore(actor.businessId)) : null;
  const [applications, loans, history] = await Promise.all([listApplications(actor), listLoans(actor), consented ? listScoreHistory(actor.businessId, 6) : Promise.resolve([])]);
  const eligible: EligibleOrder[] = [];
  const blockers = new Set<string>();
  if (consented && score) {
    const features = await gatherFeatures(actor.businessId);
    const funded = await ports().fundedEscrowsForSeller(actor.businessId);
    for (const facts of funded) {
      const net = ports().sellerNetPaise(facts.amountPaise);
      const e: Eligibility = assessEligibility({ product: "invoice_financing", businessId: actor.businessId, escrow: facts, score, features, sellerNetPaise: net });
      const applied = applications.some((a) => a.escrowId === facts.escrowId && a.product === "invoice_financing" && (ACTIVE_APPLICATION_STATUSES as readonly string[]).includes(a.status));
      if (e.eligible) eligible.push({ escrowId: facts.escrowId, orderId: facts.orderId, amountPaise: facts.amountPaise, sellerNetPaise: net, maxAdvancePaise: maxAmount("invoice_financing", score.band, facts, net), applied });
      else e.reasons.forEach((r) => blockers.add(r));
    }
    if (funded.length === 0) blockers.clear();
  }
  const lender = getCreditPartner().lender;
  return { enabled: creditEnabled(), consented, score, history, blockers: [...blockers], eligible, applications, loans, lender, coolingOffDays: cfg.coolingOffDays, exitQuotes: await coolingOffQuotesFor(actor, loans) };
}

export interface BnplOption {
  enabled: boolean;
  /** the escrow can take a BNPL application right now (final eligibility, including score, is checked on apply) */
  available: boolean;
  consented: boolean;
  maxAmountPaise: number;
  application: ApplicationView | null;
  lender: { name: string; grievance: { name: string; email: string; phone: string } };
  tenors: readonly number[];
  /** exit inside the cooling-off period (RBI) for a disbursed BNPL loan on this escrow, with the exact amount owed today */
  exitQuote: CoolingOffQuote | null;
}

/** Buyer-side option for the escrow panel. `available` is false unless the actor is the buyer of an unfunded escrow. */
export async function getBnplOption(actor: Actor, escrowId: string): Promise<BnplOption> {
  const lender = getCreditPartner().lender;
  const off: BnplOption = { enabled: creditEnabled(), available: false, consented: false, maxAmountPaise: 0, application: null, lender, tenors: TENORS.bnpl, exitQuote: null };
  if (!off.enabled || !UUID.test(escrowId)) return off;
  const facts = await ports().escrowFacts(escrowId);
  if (!facts || facts.buyerBusinessId !== actor.businessId) return off;
  const existing = await prisma.creditApplication.findFirst({ where: { businessId: actor.businessId, product: "bnpl", escrowId }, orderBy: { createdAt: "desc" } });
  const application = existing ? (await toApplicationViews([existing]))[0]! : null;
  const consented = await actorHasCreditConsent(actor);
  const unfunded = !facts.frozen && (facts.status === "created" || facts.status === "awaiting_funding");
  const live = !!application && (ACTIVE_APPLICATION_STATUSES as readonly string[]).includes(application.status);
  const score = consented ? await getLatestScore(actor.businessId) : null;
  const maxAmountPaise = score ? maxAmount("bnpl", score.band, facts, 0) : facts.amountPaise;
  const exitQuote = application?.loan ? (await coolingOffQuotesFor(actor, [application.loan]))[application.loan.id] ?? null : null;
  return { ...off, available: unfunded || live, consented, maxAmountPaise, application, exitQuote };
}

export { hasActiveCreditConsent };

// Company GST verification (ADR-003 T1): provider lookup + cross-checks → scored outcome → tier/badge.
// passed → tier ≥ 1 + BusinessVerified; ambiguous → pending VerificationRecord for staff review; failed → reasons.
import { DomainError, emit } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { bustSellerCaches } from "../business";
import { GST_STATES, GstnProviderError, getGstnProvider, isValidGstin, isValidUdyam, normaliseGstin, type GstnRecord } from "../gstin";
import { nameSimilarity, panFromGstin } from "./normalise";
import { openPan } from "./pan";

export type CheckId = "status" | "name" | "state" | "pan" | "filing" | "hsn";
export interface GstCheck {
  id: CheckId;
  result: "pass" | "warn" | "fail" | "skip";
  /** 0..1 where meaningful (name similarity) */
  score?: number;
  detail: string;
}
export interface VerificationOutcome {
  decision: "passed" | "review" | "failed" | "unavailable";
  /** 0–100 weighted over the checks that ran */
  score: number;
  checks: GstCheck[];
  reasons: string[];
  gstin: string;
  provider: string;
  /** provider snapshot (normalised) when the lookup succeeded */
  record: GstnRecord | null;
  tier?: number;
}

export const NAME_PASS = 0.85;
export const NAME_REVIEW = 0.6;
const WEIGHTS: Record<CheckId, number> = { status: 30, name: 30, state: 10, pan: 15, filing: 10, hsn: 5 };

/**
 * HSN alignment needs the seller's listing HSNs from @cnote/catalogue, which depends on identity (no cycle allowed).
 * The composition root registers it: `setListingHsnSource((id) => getSellerListingHsns(id))`. Unset → check skipped.
 */
type HsnSource = (businessId: string) => Promise<string[]>;
let hsnSource: HsnSource | null = null;
export const setListingHsnSource = (fn: HsnSource | null) => void (hsnSource = fn);

export interface GstCheckInput {
  gstin: string;
  record: GstnRecord;
  declared: {
    names: string[];
    pan?: string | null;
    stateCode?: string | null;
  };
  listingHsns?: string[];
  now?: Date;
}

/** Pure: runs every check and derives the decision. */
export function evaluateGstChecks(i: GstCheckInput): Pick<VerificationOutcome, "decision" | "score" | "checks" | "reasons"> {
  const checks: GstCheck[] = [];
  const { record: r, gstin } = i;

  checks.push(
    r.status === "Active"
      ? { id: "status", result: "pass", detail: "GSTIN is active." }
      : { id: "status", result: "fail", detail: `GSTIN is ${r.status.toLowerCase()} on the GST portal.` },
  );

  const names = i.declared.names.filter(Boolean);
  const registered = [r.legalName, r.tradeName].filter((x): x is string => !!x);
  if (names.length === 0 || registered.length === 0) {
    checks.push({ id: "name", result: "warn", detail: "Not enough name data to compare; needs a manual look." });
  } else {
    const best = Math.max(...names.flatMap((n) => registered.map((g) => nameSimilarity(n, g))));
    const score = Math.round(best * 100) / 100;
    checks.push(
      best >= NAME_PASS ? { id: "name", result: "pass", score, detail: `Name matches the GST registration (${Math.round(best * 100)}%).` }
      : best >= NAME_REVIEW ? { id: "name", result: "warn", score, detail: `Name only partly matches "${r.legalName}" (${Math.round(best * 100)}%).` }
      : { id: "name", result: "fail", score, detail: `Name does not match the GST registration "${r.legalName}" (${Math.round(best * 100)}%).` },
    );
  }

  const gstState = gstin.slice(0, 2);
  checks.push(
    !i.declared.stateCode ? { id: "state", result: "warn", detail: "Registered address state is missing." }
    : i.declared.stateCode === gstState ? { id: "state", result: "pass", detail: "Registered address state matches the GSTIN state code." }
    : { id: "state", result: "warn", detail: `Address state code ${i.declared.stateCode} differs from the GSTIN state code ${gstState}.` },
  );

  checks.push(
    !i.declared.pan ? { id: "pan", result: "skip", detail: "PAN not declared." }
    : i.declared.pan === panFromGstin(gstin) ? { id: "pan", result: "pass", detail: "PAN matches characters 3–12 of the GSTIN." }
    : { id: "pan", result: "fail", detail: "Declared PAN does not match the GSTIN." },
  );

  const last6 = (r.filings ?? []).slice(0, 6);
  if (last6.length === 0) checks.push({ id: "filing", result: "skip", detail: "Filing history not provided by the provider." });
  else {
    const filed = last6.filter((f) => f.filed).length;
    checks.push({
      id: "filing", result: filed >= 5 ? "pass" : filed >= 3 ? "warn" : "fail", score: filed / last6.length,
      detail: `GSTR-3B filed for ${filed} of the last ${last6.length} periods.`,
    });
  }

  const hsns = (i.listingHsns ?? []).map((h) => h.slice(0, 4));
  if (hsns.length === 0 || !r.hsnCodes?.length) checks.push({ id: "hsn", result: "skip", detail: "No HSN data to compare." });
  else {
    const reg = new Set(r.hsnCodes.map((h) => h.slice(0, 4)));
    const overlap = hsns.filter((h) => reg.has(h)).length;
    checks.push(overlap > 0 ? { id: "hsn", result: "pass", detail: "Listing HSN codes align with the GST registration." } : { id: "hsn", result: "warn", detail: "Listing HSN codes do not appear on the GST registration (hint only)." });
  }

  const by = Object.fromEntries(checks.map((c) => [c.id, c])) as Record<CheckId, GstCheck>;
  const decision: "passed" | "review" | "failed" =
    by.status.result === "fail" || by.pan.result === "fail" || by.name.result === "fail" ? "failed"
    : by.name.result === "warn" || by.state.result === "warn" ? "review"
    : "passed";
  const ran = checks.filter((c) => c.result !== "skip");
  const possible = ran.reduce((s, c) => s + WEIGHTS[c.id], 0);
  const earned = ran.reduce((s, c) => s + WEIGHTS[c.id] * (c.result === "pass" ? 1 : c.result === "warn" ? 0.5 : 0), 0);
  return {
    decision,
    score: possible ? Math.round((earned / possible) * 100) : 0,
    checks,
    reasons: checks.filter((c) => c.result === "warn" || c.result === "fail").map((c) => c.detail),
  };
}

const stateCodeOfName = (name: string | null | undefined): string | null => {
  const n = name?.trim().toLowerCase();
  if (!n) return null;
  return Object.entries(GST_STATES).find(([, v]) => v.toLowerCase() === n)?.[0] ?? null;
};

/** The GSTIN is held by a verified business whose name matches the registry: it cannot be taken over automatically. */
class GstinHeldError extends Error {
  constructor(readonly holderId: string) {
    super("GSTIN held by another verified business");
  }
}

type Tx = Prisma.TransactionClient;

/** Highest tier a business keeps once its GST-derived verification (and the Udyam format check riding on it) is removed. */
async function tierWithoutGst(tx: Tx, businessId: string): Promise<number> {
  const rows = await tx.verificationRecord.findMany({ where: { businessId, status: "passed" }, select: { tier: true, kind: true, provider: true } });
  return rows.filter((r) => r.kind !== "gstin" && !(r.kind === "udyam" && r.provider === "format-check")).reduce((m, r) => Math.max(m, r.tier), 0);
}

/**
 * GSTIN squatting guard (ADR-003): `gstin` is unique, so whoever stored it first blocks everyone else. A claim by an
 * UNVERIFIED business, or by one whose own names do not match the registry record, must not lock out the real owner.
 * When the claimant has passed the name/state/PAN checks (or staff decided so: `force`) the weak holder's claim is
 * released in the claimant's transaction, with a failed record on the holder, an event and the caller's audit trail.
 * A verified, name-matching holder is never displaced automatically (throws GstinHeldError → staff dispute).
 */
async function claimGstin(tx: Tx, a: { claimantId: string; gstin: string; record: GstnRecord | null; provider: string; force?: boolean; staffId?: string }): Promise<void> {
  const holder = await tx.business.findFirst({
    where: { gstin: a.gstin, id: { not: a.claimantId } },
    select: { id: true, name: true, legalName: true, tradeName: true, gstVerifiedAt: true },
  });
  if (!holder) return;
  const registered = a.record ? [a.record.legalName, a.record.tradeName].filter((x): x is string => !!x) : [];
  const names = [holder.legalName, holder.tradeName, holder.name].filter((x): x is string => !!x);
  const holderMatches = registered.length > 0 && Math.max(0, ...names.flatMap((n) => registered.map((g) => nameSimilarity(n, g)))) >= NAME_REVIEW;
  const holderIsVerified = !!holder.gstVerifiedAt && holderMatches;
  if (holderIsVerified && !a.force) throw new GstinHeldError(holder.id);
  const tier = await tierWithoutGst(tx, holder.id);
  await tx.business.update({ where: { id: holder.id }, data: { gstin: null, gstVerifiedAt: null, gstStatus: null, gstLastCheckedAt: null, verificationTier: tier } });
  const reason = a.force ? "staff_dispute" : "superseded";
  await tx.verificationRecord.create({
    data: {
      businessId: holder.id, tier: 1, kind: "gstin", status: "failed", provider: a.provider,
      details: { gstin: a.gstin, released: true, reason, byBusinessId: a.claimantId, staffId: a.staffId ?? null, holderWasVerified: !!holder.gstVerifiedAt, holderNameMatched: holderMatches, at: new Date().toISOString() },
    },
  });
  await emit(tx, "GstinClaimReleased", { type: "Business", id: holder.id }, { businessId: holder.id, gstin: a.gstin, reason, byBusinessId: a.claimantId, ...(a.staffId ? { staffId: a.staffId } : {}) });
}

/**
 * Staff "dispute this GSTIN" action: releases a business's claim on its GSTIN (e.g. a squatter reported by the real owner)
 * and drops the GST-derived tier. Callers wrap this in admin.audited("businesses.verify"). Emits GstinClaimReleased.
 */
export async function releaseGstinClaim(businessId: string, staffId: string, reason: string): Promise<{ gstin: string }> {
  const note = reason.trim();
  if (note.length < 5) throw new DomainError("validation", "Give a reason for releasing this GSTIN claim.");
  const out = await prisma.$transaction(async (tx) => {
    const b = await tx.business.findUnique({ where: { id: businessId }, select: { gstin: true } });
    if (!b) throw new DomainError("not_found", "Business not found.", undefined, "account.businessNotFound");
    if (!b.gstin) throw new DomainError("conflict", "This business has no GSTIN claim to release.");
    const tier = await tierWithoutGst(tx, businessId);
    await tx.business.update({ where: { id: businessId }, data: { gstin: null, gstVerifiedAt: null, gstStatus: null, gstLastCheckedAt: null, verificationTier: tier } });
    await tx.verificationRecord.create({
      data: { businessId, tier: 1, kind: "gstin", status: "failed", provider: "staff", details: { gstin: b.gstin, released: true, reason: "staff_dispute", staffId, note, at: new Date().toISOString() } },
    });
    await emit(tx, "GstinClaimReleased", { type: "Business", id: businessId }, { businessId, gstin: b.gstin, reason: "staff_dispute", staffId });
    return { gstin: b.gstin };
  });
  await bustSellerCaches(businessId);
  return out;
}

const detailsOf = (o: VerificationOutcome, extra: object = {}): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify({ gstin: o.gstin, decision: o.decision, score: o.score, checks: o.checks, reasons: o.reasons, snapshot: o.record, checkedAt: new Date().toISOString(), ...extra }));

/** One open GST review per business: a repeat check refreshes it rather than stacking duplicates. */
async function queueReview(businessId: string, providerName: string, details: Prisma.InputJsonValue): Promise<void> {
  const pending = await prisma.verificationRecord.findFirst({ where: { businessId, kind: "gstin", status: "pending" }, select: { id: true } });
  if (pending) await prisma.verificationRecord.update({ where: { id: pending.id }, data: { details, provider: providerName } });
  else await prisma.verificationRecord.create({ data: { businessId, tier: 1, kind: "gstin", status: "pending", provider: providerName, details } });
}

/**
 * Verifies the business's GSTIN (pass `opts.gstin` to verify a new one before it is stored) and applies the outcome.
 * Provider outages return decision "unavailable" and change nothing.
 */
export async function verifyCompanyGst(businessId: string, opts: { gstin?: string } = {}): Promise<VerificationOutcome> {
  const b = await prisma.business.findUnique({ where: { id: businessId } });
  if (!b) throw new DomainError("not_found", "Business not found.", undefined, "account.businessNotFound");
  const gstin = normaliseGstin(opts.gstin ?? b.gstin ?? "");
  const provider = getGstnProvider();
  const base = { gstin, provider: provider.name, record: null as GstnRecord | null };
  const failWith = async (reason: string, checks: GstCheck[] = []): Promise<VerificationOutcome> => {
    const o: VerificationOutcome = { ...base, decision: "failed", score: 0, checks, reasons: [reason] };
    await prisma.verificationRecord.create({ data: { businessId, tier: 1, kind: "gstin", status: "failed", provider: provider.name, details: detailsOf(o) } });
    return o;
  };

  if (!gstin) throw new DomainError("validation", "Add a GSTIN first.");
  if (!isValidGstin(gstin)) return failWith("Invalid GSTIN. Check the 15 characters and try again.");

  const declaredName = b.legalName ?? b.name;
  let record: GstnRecord | null;
  try {
    record = await provider.lookup(gstin, { businessName: declaredName });
  } catch (err) {
    if (err instanceof GstnProviderError) {
      return { ...base, decision: "unavailable", score: 0, checks: [], reasons: ["GST verification is temporarily unavailable. Please try again in a few minutes."] };
    }
    throw err;
  }
  const now = new Date();
  if (!record) {
    await prisma.business.update({ where: { id: businessId }, data: { gstLastCheckedAt: now } });
    return failWith("GSTIN not found in the GST registry.");
  }
  base.record = record;

  let listingHsns: string[] = [];
  try { listingHsns = (await hsnSource?.(businessId)) ?? []; } catch { /* hint only */ }
  const declaredPan = await openPan(b.pan, businessId);
  const addr = b.registeredAddress as { stateCode?: string } | null;
  const ev = evaluateGstChecks({
    gstin, record, listingHsns,
    declared: { names: [b.legalName, b.tradeName, b.name].filter((x): x is string => !!x), pan: declaredPan, stateCode: addr?.stateCode ?? stateCodeOfName(b.state) },
  });
  const outcome: VerificationOutcome = { ...base, ...ev };
  const snapshot = { gstStatus: record.status, gstLastCheckedAt: now };

  if (outcome.decision === "passed") {
    try {
      outcome.tier = await applyPass(businessId, gstin, provider.name, detailsOf(outcome), snapshot, now, { record });
    } catch (err) {
      if (err instanceof GstinHeldError) {
        // The claimant matches the registry AND a verified business already holds the GSTIN: a real contest. Queue it for
        // staff (no tier change) instead of silently blocking the claimant forever.
        const reason = "This GSTIN is already registered to another verified business. Our team will review your claim.";
        const o: VerificationOutcome = { ...outcome, decision: "review", reasons: [reason, ...outcome.reasons] };
        await queueReview(businessId, provider.name, detailsOf(o, { dispute: true, heldBy: err.holderId }));
        await bustSellerCaches(businessId);
        return o;
      }
      if ((err as { code?: string }).code === "P2002") {
        return failWith("This GSTIN is already registered to another business.", ev.checks);
      }
      throw err;
    }
  } else if (outcome.decision === "review") {
    await prisma.business.update({ where: { id: businessId }, data: snapshot });
    await queueReview(businessId, provider.name, detailsOf(outcome));
  } else {
    await prisma.$transaction([
      prisma.business.update({ where: { id: businessId }, data: snapshot }),
      prisma.verificationRecord.create({ data: { businessId, tier: 1, kind: "gstin", status: "failed", provider: provider.name, details: detailsOf(outcome) } }),
    ]);
  }
  await bustSellerCaches(businessId);
  return outcome;
}

async function applyPass(
  businessId: string, gstin: string, providerName: string, details: Prisma.InputJsonValue,
  snapshot: { gstStatus: string; gstLastCheckedAt: Date }, now: Date, opts: { record: GstnRecord | null; existingRecordId?: string; force?: boolean; staffId?: string },
): Promise<number> {
  const existingRecordId = opts.existingRecordId;
  return prisma.$transaction(async (tx) => {
    await claimGstin(tx, { claimantId: businessId, gstin, record: opts.record, provider: providerName, force: opts.force, staffId: opts.staffId });
    const cur = await tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { verificationTier: true, legalName: true } });
    const tier = Math.max(cur.verificationTier, 1);
    // The registry's legal name is only ever adopted AFTER the checks matched it, and never over a name the business declared.
    await tx.business.update({ where: { id: businessId }, data: { gstin, verificationTier: tier, ...snapshot, gstVerifiedAt: now, ...(cur.legalName || !opts.record?.legalName ? {} : { legalName: opts.record.legalName }) } });
    if (existingRecordId) await tx.verificationRecord.update({ where: { id: existingRecordId }, data: { status: "passed", details } });
    else await tx.verificationRecord.create({ data: { businessId, tier: 1, kind: "gstin", status: "passed", provider: providerName, details } });
    await emit(tx, "BusinessVerified", { type: "Business", id: businessId }, { businessId, tier, kind: "gstin" });
    return tier;
  });
}

// ---------- manual review queue ----------
export interface GstReviewItem {
  id: string;
  businessId: string;
  businessName: string;
  gstin: string | null;
  score: number | null;
  reasons: string[];
  /** the GSTIN is held by another verified business: approving moves it (staff decision) */
  dispute: boolean;
  createdAt: string;
}

/** Pending GST verifications awaiting staff (ambiguous name/state/missing data). Oldest first. */
export async function listPendingGstReviews(limit = 100): Promise<GstReviewItem[]> {
  const rows = await prisma.verificationRecord.findMany({
    where: { kind: "gstin", status: "pending" }, orderBy: { createdAt: "asc" }, take: Math.min(Math.max(limit, 1), 200),
    include: { business: { select: { name: true } } },
  });
  return rows.map((r) => {
    const d = (r.details ?? {}) as { gstin?: string; score?: number; reasons?: string[]; dispute?: boolean };
    return { id: r.id, businessId: r.businessId, businessName: r.business.name, gstin: d.gstin ?? null, score: d.score ?? null, reasons: d.reasons ?? [], dispute: d.dispute === true, createdAt: r.createdAt.toISOString() };
  });
}

/** Staff decision on a pending GST review. Callers wrap this in admin.audited("businesses.verify"). */
export async function resolveGstReview(id: string, decision: "approved" | "rejected", staffId: string, note?: string): Promise<{ status: "passed" | "failed"; tier?: number }> {
  const rec = await prisma.verificationRecord.findUnique({ where: { id } });
  if (!rec || rec.kind !== "gstin") throw new DomainError("not_found", "Review not found.", undefined, "account.reviewNotFound");
  if (rec.status !== "pending") throw new DomainError("conflict", "This review was already resolved.");
  const d = (rec.details ?? {}) as { gstin?: string; snapshot?: GstnRecord | null; dispute?: boolean };
  const details = JSON.parse(JSON.stringify({ ...d, manualReview: { decision, staffId, note: note ?? null, at: new Date().toISOString() } })) as Prisma.InputJsonValue;
  // Atomic claim: the first decision writes its manualReview marker; any concurrent decision finds the marker and loses.
  // (Filtering on status alone is not enough: status stays "pending" until applyPass/reject below.)
  const claimed = await prisma.$executeRaw`
    UPDATE verification_records SET details = ${JSON.stringify(details)}::jsonb
    WHERE id = ${id}::uuid AND status = 'pending' AND NOT (details ? 'manualReview')`;
  if (claimed === 0) throw new DomainError("conflict", "This review was already resolved.");
  if (decision === "rejected") {
    await prisma.verificationRecord.update({ where: { id }, data: { status: "failed" } });
    return { status: "failed" };
  }
  // A failed approval releases the claim so staff can decide again (e.g. reject after a GSTIN clash).
  const release = () => prisma.$executeRaw`UPDATE verification_records SET details = details - 'manualReview' WHERE id = ${id}::uuid AND status = 'pending'`;
  if (!d.gstin) {
    await release();
    throw new DomainError("validation", "Review has no GSTIN to approve.");
  }
  const now = new Date();
  try {
    // A staff approval of a dispute item is the human decision to move the GSTIN from its current holder to this business.
    const tier = await applyPass(rec.businessId, d.gstin, rec.provider, details, { gstStatus: d.snapshot?.status ?? "Active", gstLastCheckedAt: now }, now, { record: d.snapshot ?? null, existingRecordId: id, force: d.dispute === true, staffId });
    await bustSellerCaches(rec.businessId);
    return { status: "passed", tier };
  } catch (err) {
    await release();
    if (err instanceof GstinHeldError) throw new DomainError("conflict", "This GSTIN is already registered to another verified business. Release that claim first (dispute) or reject this review.");
    if ((err as { code?: string }).code === "P2002") throw new DomainError("conflict", "This GSTIN is already registered to another business.");
    throw err;
  }
}

export interface GstEvidence {
  id: string;
  status: "pending" | "passed" | "failed";
  provider: string;
  createdAt: string;
  gstin: string | null;
  decision: string | null;
  score: number | null;
  recheck: boolean;
  checks: GstCheck[];
  reasons: string[];
  snapshot: GstnRecord | null;
  manualReview: { decision: string; staffId: string; note: string | null; at: string } | null;
}

/** GST verification history with the full evidence (provider snapshot + per-check results), newest first. For staff tools. */
export async function getGstEvidence(businessId: string, limit = 10): Promise<GstEvidence[]> {
  const rows = await prisma.verificationRecord.findMany({ where: { businessId, kind: "gstin" }, orderBy: { createdAt: "desc" }, take: Math.min(Math.max(limit, 1), 50) });
  return rows.map((r) => {
    const d = (r.details ?? {}) as Record<string, unknown>;
    return {
      id: r.id, status: r.status, provider: r.provider, createdAt: r.createdAt.toISOString(),
      gstin: (d.gstin as string) ?? null, decision: (d.decision as string) ?? null, score: (d.score as number) ?? null, recheck: d.recheck === true,
      checks: (d.checks as GstCheck[]) ?? [], reasons: (d.reasons as string[]) ?? [], snapshot: (d.snapshot as GstnRecord) ?? null,
      manualReview: (d.manualReview as GstEvidence["manualReview"]) ?? null,
    };
  });
}

// ---------- legacy entry point used by the buyer account and the seller verification page ----------
export interface GstinVerifyResult {
  passed: boolean;
  tier: number;
  reason?: string;
  legalName?: string;
  state?: string | null;
  /** borderline match: queued for staff review, tier unchanged */
  pending?: boolean;
}

/**
 * T1 for the self-serve forms. Runs the strict company-GST checks (registry status, legal/trade-name similarity against the
 * business's declared name, state match, PAN consistency): pass -> tier 1; borderline -> a staff review item (no tier change);
 * mismatch -> fail. Possession of a valid GSTIN number proves nothing, so a number that merely exists is never enough.
 * Udyam (format-checked) is recorded only when the GSTIN passes.
 */
export async function verifyGstin(businessId: string, gstinInput: string, udyamInput?: string): Promise<GstinVerifyResult> {
  const udyam = udyamInput?.trim() ? udyamInput.trim().toUpperCase() : undefined;
  const before = await prisma.business.findUnique({ where: { id: businessId }, select: { verificationTier: true } });
  if (!before) throw new DomainError("not_found", "Business not found.", undefined, "account.businessNotFound");
  if (udyam && !isValidUdyam(udyam)) {
    await prisma.verificationRecord.create({
      data: { businessId, tier: 1, kind: "gstin", status: "failed", provider: getGstnProvider().name, details: { gstin: normaliseGstin(gstinInput), reason: "Invalid Udyam number." } },
    });
    return { passed: false, tier: before.verificationTier, reason: "Invalid Udyam number. Expected format UDYAM-XX-00-0000000." };
  }
  const o = await verifyCompanyGst(businessId, { gstin: gstinInput });
  const tier = (await prisma.business.findUnique({ where: { id: businessId }, select: { verificationTier: true } }))?.verificationTier ?? before.verificationTier;
  if (o.decision === "unavailable") return { passed: false, tier, reason: "The GST registry is unavailable right now. Please try again shortly." };
  if (o.decision === "review") {
    const contested = o.reasons.find((r) => /already registered/.test(r));
    return { passed: false, tier, pending: true, reason: contested ?? "We could not fully match your GST details automatically. Our team will review them; there is nothing more to do." };
  }
  if (o.decision === "failed") {
    // Keep the short wording the forms have always shown for a registry status problem.
    const status = o.checks.find((c) => c.id === "status" && c.result === "fail") ? o.record?.status : undefined;
    return { passed: false, tier, reason: status ? `GSTIN is ${status.toLowerCase()}.` : (o.reasons[0] ?? "GST verification failed.") };
  }
  if (udyam) {
    await prisma.$transaction([
      prisma.business.update({ where: { id: businessId }, data: { udyam } }),
      prisma.verificationRecord.create({ data: { businessId, tier: 1, kind: "udyam", status: "passed", provider: "format-check", details: { udyam } } }),
    ]);
  }
  return { passed: true, tier: o.tier ?? tier, legalName: o.record?.legalName, state: o.record?.state ?? null };
}

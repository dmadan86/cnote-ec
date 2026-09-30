// Company GST verification (ADR-003 T1): provider lookup + cross-checks → scored outcome → tier/badge.
// passed → tier ≥ 1 + BusinessVerified; ambiguous → pending VerificationRecord for staff review; failed → reasons.
import { DomainError, emit } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { bustSellerCaches } from "../business";
import { GstnProviderError, getGstnProvider, isValidGstin, normaliseGstin, type GstnRecord } from "../gstin";
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

const detailsOf = (o: VerificationOutcome, extra: object = {}): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify({ gstin: o.gstin, decision: o.decision, score: o.score, checks: o.checks, reasons: o.reasons, snapshot: o.record, checkedAt: new Date().toISOString(), ...extra }));

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
    declared: { names: [b.legalName, b.tradeName, b.name].filter((x): x is string => !!x), pan: declaredPan, stateCode: addr?.stateCode ?? null },
  });
  const outcome: VerificationOutcome = { ...base, ...ev };
  const snapshot = { gstStatus: record.status, gstLastCheckedAt: now };

  if (outcome.decision === "passed") {
    try {
      outcome.tier = await applyPass(businessId, gstin, provider.name, detailsOf(outcome), snapshot, now);
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        return failWith("This GSTIN is already registered to another business.", ev.checks);
      }
      throw err;
    }
  } else if (outcome.decision === "review") {
    await prisma.business.update({ where: { id: businessId }, data: snapshot });
    const pending = await prisma.verificationRecord.findFirst({ where: { businessId, kind: "gstin", status: "pending" }, select: { id: true } });
    const data = { businessId, tier: 1, kind: "gstin" as const, status: "pending" as const, provider: provider.name, details: detailsOf(outcome) };
    if (pending) await prisma.verificationRecord.update({ where: { id: pending.id }, data: { details: data.details, provider: provider.name } });
    else await prisma.verificationRecord.create({ data });
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
  snapshot: { gstStatus: string; gstLastCheckedAt: Date }, now: Date, existingRecordId?: string,
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const cur = await tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { verificationTier: true } });
    const tier = Math.max(cur.verificationTier, 1);
    await tx.business.update({ where: { id: businessId }, data: { gstin, verificationTier: tier, ...snapshot, gstVerifiedAt: now } });
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
  createdAt: string;
}

/** Pending GST verifications awaiting staff (ambiguous name/state/missing data). Oldest first. */
export async function listPendingGstReviews(limit = 100): Promise<GstReviewItem[]> {
  const rows = await prisma.verificationRecord.findMany({
    where: { kind: "gstin", status: "pending" }, orderBy: { createdAt: "asc" }, take: Math.min(Math.max(limit, 1), 200),
    include: { business: { select: { name: true } } },
  });
  return rows.map((r) => {
    const d = (r.details ?? {}) as { gstin?: string; score?: number; reasons?: string[] };
    return { id: r.id, businessId: r.businessId, businessName: r.business.name, gstin: d.gstin ?? null, score: d.score ?? null, reasons: d.reasons ?? [], createdAt: r.createdAt.toISOString() };
  });
}

/** Staff decision on a pending GST review. Callers wrap this in admin.audited("businesses.verify"). */
export async function resolveGstReview(id: string, decision: "approved" | "rejected", staffId: string, note?: string): Promise<{ status: "passed" | "failed"; tier?: number }> {
  const rec = await prisma.verificationRecord.findUnique({ where: { id } });
  if (!rec || rec.kind !== "gstin") throw new DomainError("not_found", "Review not found.", undefined, "account.reviewNotFound");
  if (rec.status !== "pending") throw new DomainError("conflict", "This review was already resolved.");
  const d = (rec.details ?? {}) as { gstin?: string; snapshot?: GstnRecord | null };
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
    const tier = await applyPass(rec.businessId, d.gstin, rec.provider, details, { gstStatus: d.snapshot?.status ?? "Active", gstLastCheckedAt: now }, now, id);
    await bustSellerCaches(rec.businessId);
    return { status: "passed", tier };
  } catch (err) {
    await release();
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

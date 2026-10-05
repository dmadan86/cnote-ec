// Udyam + MCA/CIN verification (ADR-003 T1): provider lookup -> name/address match scoring against the business profile
// -> scored outcome -> VerificationRecord + trust score, exactly like the GST check. See docs/design/verification-t2-t3.md.
//
// Effect on tier/trust (decision in the design doc): GST remains the T1 gate. A passing Udyam or MCA check is supplementary
// evidence: it stamps the business (udyamVerifiedAt / mcaVerifiedAt), adds trust points and shows on the profile. Udyam can
// also GRANT T1 for sellers with no GSTIN (sub-threshold MSMEs) when UDYAM_GRANTS_T1=1. An MCA status other than Active
// (struck off, liquidation) is a trust penalty and a failed record, found at verification or by the periodic re-check.
import { DomainError, emit, type ScheduledJob } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { bustSellerCaches } from "../business";
import { GstnProviderError } from "../gstin";
import { CIN_RE } from "../gst/normalise";
import { NAME_PASS, NAME_REVIEW } from "../gst/verify";
import { ADDRESS_PASS, ADDRESS_REVIEW, addressSimilarity, nameSimilarity, type AddressParts } from "./match";
import { UDYAM_RE, getMcaProvider, getUdyamProvider, type McaRecord, type UdyamRecord } from "./providers";

export type RegistryKind = "udyam" | "mca";
export type RegistryCheckId = "status" | "identifier" | "name" | "address";
export interface RegistryCheck { id: RegistryCheckId; result: "pass" | "warn" | "fail" | "skip"; score?: number; detail: string }
export interface RegistryOutcome {
  kind: RegistryKind;
  decision: "passed" | "review" | "failed" | "unavailable";
  /** 0-100 weighted over the checks that ran */
  score: number;
  checks: RegistryCheck[];
  reasons: string[];
  number: string;
  provider: string;
  record: UdyamRecord | McaRecord | null;
  nameScore?: number;
  addressScore?: number;
}

const WEIGHTS: Record<RegistryCheckId, number> = { status: 35, identifier: 5, name: 40, address: 20 };

export interface RegistryCheckInput {
  kind: RegistryKind;
  number: string;
  record: { number: string; name: string; active: boolean; statusLabel: string; address: AddressParts };
  declared: { names: string[]; address: AddressParts | null };
  /** another business already holds this verified number */
  heldByOther?: boolean;
}

/** Pure: runs every check and derives the decision. fail > review > pass. */
export function evaluateRegistryChecks(i: RegistryCheckInput): Pick<RegistryOutcome, "decision" | "score" | "checks" | "reasons" | "nameScore" | "addressScore"> {
  const label = i.kind === "udyam" ? "Udyam registration" : "company (MCA) record";
  const checks: RegistryCheck[] = [];
  checks.push(i.record.active ? { id: "status", result: "pass", detail: `The ${label} is active.` } : { id: "status", result: "fail", detail: `The ${label} is ${i.record.statusLabel.toLowerCase()}.` });
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  checks.push(
    norm(i.record.number) === norm(i.number) ? { id: "identifier", result: "pass", detail: "Registry returned the same number." }
    : { id: "identifier", result: "fail", detail: "Registry returned a different number than the one declared." },
  );
  const names = i.declared.names.filter(Boolean);
  let nameScore: number | undefined;
  if (names.length === 0 || !i.record.name) checks.push({ id: "name", result: "warn", detail: "Not enough name data to compare; needs a manual look." });
  else {
    const best = Math.max(...names.map((n) => nameSimilarity(n, i.record.name)));
    nameScore = Math.round(best * 100) / 100;
    const pct = Math.round(best * 100);
    checks.push(
      best >= NAME_PASS ? { id: "name", result: "pass", score: nameScore, detail: `Name matches the registry (${pct}%).` }
      : best >= NAME_REVIEW ? { id: "name", result: "warn", score: nameScore, detail: `Name only partly matches "${i.record.name}" (${pct}%).` }
      : { id: "name", result: "fail", score: nameScore, detail: `Name does not match the registry "${i.record.name}" (${pct}%).` },
    );
  }
  let addressScore: number | undefined;
  if (!i.declared.address || (!i.record.address.line && !i.record.address.pincode)) checks.push({ id: "address", result: "skip", detail: "No address on one side to compare." });
  else {
    addressScore = addressSimilarity(i.declared.address, i.record.address);
    checks.push(
      addressScore >= ADDRESS_PASS ? { id: "address", result: "pass", score: addressScore, detail: `Registered address matches (${Math.round(addressScore * 100)}%).` }
      : addressScore >= ADDRESS_REVIEW ? { id: "address", result: "pass", score: addressScore, detail: `Registered address partly matches (${Math.round(addressScore * 100)}%).` }
      : { id: "address", result: "warn", score: addressScore, detail: `Registered address differs from the registry (${Math.round(addressScore * 100)}% similar).` },
    );
  }
  const by = Object.fromEntries(checks.map((c) => [c.id, c])) as Record<RegistryCheckId, RegistryCheck>;
  const reasons = checks.filter((c) => c.result === "warn" || c.result === "fail").map((c) => c.detail);
  if (i.heldByOther) reasons.unshift("This number is already verified for another business. Our team will review your claim.");
  const decision: "passed" | "review" | "failed" =
    by.status.result === "fail" || by.identifier.result === "fail" || by.name.result === "fail" ? "failed"
    : i.heldByOther || by.name.result === "warn" || by.address.result === "warn" ? "review" : "passed";
  const ran = checks.filter((c) => c.result !== "skip");
  const possible = ran.reduce((s, c) => s + WEIGHTS[c.id], 0);
  const earned = ran.reduce((s, c) => s + WEIGHTS[c.id] * (c.result === "pass" ? 1 : c.result === "warn" ? 0.5 : 0), 0);
  return { decision, score: possible ? Math.round((earned / possible) * 100) : 0, checks, reasons, nameScore, addressScore };
}

const udyamView = (r: UdyamRecord) => ({ number: r.udyamNumber, name: r.enterpriseName, active: r.status === "Active", statusLabel: r.status, address: r.address });
const mcaView = (r: McaRecord) => ({ number: r.cin, name: r.companyName, active: r.status === "Active", statusLabel: r.status, address: r.address });

const normaliseNumber = (kind: RegistryKind, v: string) => (kind === "udyam" ? v.trim().toUpperCase().replace(/\s+/g, "") : v.trim().toUpperCase());
export const isValidRegistryNumber = (kind: RegistryKind, v: string) => (kind === "udyam" ? UDYAM_RE.test(v) : CIN_RE.test(v));

function declaredAddress(raw: unknown, b: { city: string | null; state: string | null; pincode: string | null }): AddressParts | null {
  const a = (raw ?? null) as { line1?: string; line2?: string; city?: string; state?: string; pincode?: string } | null;
  if (a && (a.line1 || a.pincode)) return { line: [a.line1, a.line2].filter(Boolean).join(", "), city: a.city, state: a.state, pincode: a.pincode };
  return b.pincode || b.city ? { city: b.city ?? undefined, state: b.state ?? undefined, pincode: b.pincode ?? undefined } : null;
}

const detailsOf = (o: RegistryOutcome, extra: object = {}): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify({ number: o.number, decision: o.decision, score: o.score, nameScore: o.nameScore ?? null, addressScore: o.addressScore ?? null, checks: o.checks, reasons: o.reasons, snapshot: o.record, checkedAt: new Date().toISOString(), ...extra }));

const grantsT1 = (kind: RegistryKind, tierNow: number, hasGst: boolean) => kind === "udyam" && tierNow < 1 && !hasGst && /^(1|true|on)$/i.test(process.env.UDYAM_GRANTS_T1?.trim() ?? "");

async function afterChange(businessId: string): Promise<void> {
  const { recomputeTrust } = await import("../trust-worker"); // lazy: trust-worker imports this module's jobs
  await recomputeTrust(businessId);
  await bustSellerCaches(businessId);
}

async function applyPass(kind: RegistryKind, businessId: string, number: string, providerName: string, details: Prisma.InputJsonValue, record: UdyamRecord | McaRecord | null, now: Date, opts: { existingRecordId?: string } = {}): Promise<number> {
  const tier = await prisma.$transaction(async (tx) => {
    const cur = await tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { verificationTier: true, gstVerifiedAt: true } });
    const grant = grantsT1(kind, cur.verificationTier, !!cur.gstVerifiedAt);
    const newTier = grant ? 1 : cur.verificationTier;
    const stamp = kind === "udyam"
      ? { udyam: number, udyamVerifiedAt: now, udyamLastCheckedAt: now }
      : { cin: number, mcaVerifiedAt: now, mcaLastCheckedAt: now, mcaStatus: (record as McaRecord | null)?.status ?? "Active" };
    await tx.business.update({ where: { id: businessId }, data: { ...stamp, verificationTier: newTier } });
    const full = JSON.parse(JSON.stringify({ ...(details as object), grantedT1: grant })) as Prisma.InputJsonValue;
    if (opts.existingRecordId) await tx.verificationRecord.update({ where: { id: opts.existingRecordId }, data: { status: "passed", details: full } });
    else await tx.verificationRecord.create({ data: { businessId, tier: 1, kind, status: "passed", provider: providerName, details: full } });
    await emit(tx, "BusinessVerified", { type: "Business", id: businessId }, { businessId, tier: newTier, kind });
    return newTier;
  });
  await afterChange(businessId);
  return tier;
}

async function queueReview(kind: RegistryKind, businessId: string, providerName: string, details: Prisma.InputJsonValue): Promise<void> {
  const pending = await prisma.verificationRecord.findFirst({ where: { businessId, kind, status: "pending" }, select: { id: true } });
  if (pending) await prisma.verificationRecord.update({ where: { id: pending.id }, data: { details, provider: providerName } });
  else await prisma.verificationRecord.create({ data: { businessId, tier: 1, kind, status: "pending", provider: providerName, details } });
}

/**
 * Verifies the business's Udyam number or CIN (pass `opts.number` to verify a new one before it is stored) and applies the
 * outcome. Provider outages (or a provider that is not configured) return decision "unavailable" and change nothing.
 */
export async function verifyRegistry(kind: RegistryKind, businessId: string, opts: { number?: string } = {}): Promise<RegistryOutcome> {
  const b = await prisma.business.findUnique({ where: { id: businessId } });
  if (!b) throw new DomainError("not_found", "Business not found.", undefined, "account.businessNotFound");
  const number = normaliseNumber(kind, opts.number ?? (kind === "udyam" ? b.udyam : b.cin) ?? "");
  if (!number) throw new DomainError("validation", kind === "udyam" ? "Add your Udyam number first." : "Add your CIN first.");
  const label = kind === "udyam" ? "Udyam" : "CIN";
  const providerName = (() => { try { return (kind === "udyam" ? getUdyamProvider() : getMcaProvider()).name; } catch { return "unconfigured"; } })();
  const base = { kind, number, provider: providerName, record: null as UdyamRecord | McaRecord | null };
  if (!isValidRegistryNumber(kind, number)) {
    const o: RegistryOutcome = { ...base, decision: "failed", score: 0, checks: [], reasons: [`Invalid ${label}. Check the number and try again.`] };
    await prisma.verificationRecord.create({ data: { businessId, tier: 1, kind, status: "failed", provider: providerName, details: detailsOf(o) } });
    return o;
  }
  const names = [b.legalName, b.tradeName, b.name].filter((x): x is string => !!x);
  const address = declaredAddress(b.registeredAddress, b);
  let record: UdyamRecord | McaRecord | null;
  try {
    const lookupOpts = { businessName: b.legalName ?? b.name, address: address ?? undefined };
    record = kind === "udyam" ? await getUdyamProvider().lookup(number, lookupOpts) : await getMcaProvider().lookup(number, lookupOpts);
  } catch (err) {
    if (err instanceof GstnProviderError || err instanceof DomainError) return { ...base, decision: "unavailable", score: 0, checks: [], reasons: ["Verification is temporarily unavailable. Please try again in a few minutes."] };
    throw err;
  }
  const now = new Date();
  if (!record) {
    await prisma.business.update({ where: { id: businessId }, data: kind === "udyam" ? { udyamLastCheckedAt: now } : { mcaLastCheckedAt: now } });
    const o: RegistryOutcome = { ...base, decision: "failed", score: 0, checks: [], reasons: [`${label} not found in the registry.`] };
    await prisma.verificationRecord.create({ data: { businessId, tier: 1, kind, status: "failed", provider: providerName, details: detailsOf(o) } });
    return o;
  }
  base.record = record;
  const heldByOther = !!(await prisma.business.findFirst({
    where: kind === "udyam" ? { udyam: number, udyamVerifiedAt: { not: null }, id: { not: businessId } } : { cin: number, mcaVerifiedAt: { not: null }, id: { not: businessId } },
    select: { id: true },
  }));
  const ev = evaluateRegistryChecks({ kind, number, record: kind === "udyam" ? udyamView(record as UdyamRecord) : mcaView(record as McaRecord), declared: { names, address }, heldByOther });
  const outcome: RegistryOutcome = { ...base, ...ev };

  if (outcome.decision === "passed") await applyPass(kind, businessId, number, providerName, detailsOf(outcome), record, now);
  else if (outcome.decision === "review") {
    await prisma.business.update({ where: { id: businessId }, data: kind === "udyam" ? { udyamLastCheckedAt: now } : { mcaLastCheckedAt: now } });
    await queueReview(kind, businessId, providerName, detailsOf(outcome, heldByOther ? { dispute: true } : {}));
  } else {
    const status = ev.checks.find((c) => c.id === "status" && c.result === "fail") ? (record as McaRecord).status : undefined;
    await prisma.$transaction([
      prisma.business.update({ where: { id: businessId }, data: kind === "udyam" ? { udyamLastCheckedAt: now } : { mcaLastCheckedAt: now, ...(status ? { mcaStatus: status } : {}) } }),
      prisma.verificationRecord.create({ data: { businessId, tier: 1, kind, status: "failed", provider: providerName, details: detailsOf(outcome) } }),
    ]);
    if (status) await afterChange(businessId);
  }
  await bustSellerCaches(businessId);
  return outcome;
}
export const verifyUdyam = (businessId: string, opts?: { number?: string }) => verifyRegistry("udyam", businessId, opts);
export const verifyMca = (businessId: string, opts?: { number?: string }) => verifyRegistry("mca", businessId, opts);

export interface RegistryStatusView {
  udyam: string | null; udyamVerifiedAt: string | null; cin: string | null; mcaVerifiedAt: string | null; mcaStatus: string | null;
}
/** What the seller portal shows: the declared numbers and when each was last verified (no provider snapshot). */
export async function getRegistryStatus(businessId: string): Promise<RegistryStatusView | null> {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { udyam: true, udyamVerifiedAt: true, cin: true, mcaVerifiedAt: true, mcaStatus: true } });
  return b ? { udyam: b.udyam, udyamVerifiedAt: b.udyamVerifiedAt?.toISOString() ?? null, cin: b.cin, mcaVerifiedAt: b.mcaVerifiedAt?.toISOString() ?? null, mcaStatus: b.mcaStatus } : null;
}

// ---------- manual review queue (admin: businesses.verify, audited) ----------
export interface RegistryReviewItem { id: string; kind: RegistryKind; businessId: string; businessName: string; number: string | null; score: number | null; reasons: string[]; dispute: boolean; createdAt: string }
export async function listPendingRegistryReviews(limit = 100): Promise<RegistryReviewItem[]> {
  const rows = await prisma.verificationRecord.findMany({
    where: { kind: { in: ["udyam", "mca"] }, status: "pending" }, orderBy: { createdAt: "asc" }, take: Math.min(Math.max(limit, 1), 200),
    include: { business: { select: { name: true } } },
  });
  return rows.map((r) => {
    const d = (r.details ?? {}) as { number?: string; score?: number; reasons?: string[]; dispute?: boolean };
    return { id: r.id, kind: r.kind as RegistryKind, businessId: r.businessId, businessName: r.business.name, number: d.number ?? null, score: d.score ?? null, reasons: d.reasons ?? [], dispute: d.dispute === true, createdAt: r.createdAt.toISOString() };
  });
}

export async function resolveRegistryReview(id: string, decision: "approved" | "rejected", staffId: string, note?: string): Promise<{ status: "passed" | "failed" }> {
  const rec = await prisma.verificationRecord.findUnique({ where: { id } });
  if (!rec || (rec.kind !== "udyam" && rec.kind !== "mca")) throw new DomainError("not_found", "Review not found.", undefined, "account.reviewNotFound");
  if (rec.status !== "pending") throw new DomainError("conflict", "This review was already resolved.");
  const d = (rec.details ?? {}) as { number?: string; snapshot?: UdyamRecord | McaRecord | null };
  const details = JSON.parse(JSON.stringify({ ...d, manualReview: { decision, staffId, note: note ?? null, at: new Date().toISOString() } })) as Prisma.InputJsonValue;
  // atomic claim: only the first decision flips pending -> (passed|failed)
  const claimed = await prisma.verificationRecord.updateMany({ where: { id, status: "pending" }, data: { status: decision === "approved" ? "passed" : "failed", details } });
  if (claimed.count === 0) throw new DomainError("conflict", "This review was already resolved.");
  if (decision === "rejected") return { status: "failed" };
  if (!d.number) throw new DomainError("validation", "Review has no number to approve.");
  try {
    await applyPass(rec.kind as RegistryKind, rec.businessId, d.number, rec.provider, details, d.snapshot ?? null, new Date(), { existingRecordId: id });
  } catch (err) {
    await prisma.verificationRecord.updateMany({ where: { id }, data: { status: "pending" } });
    throw err;
  }
  return { status: "passed" };
}

// ---------- periodic re-check (supplementary evidence stays honest) ----------
const DAY_MS = 86_400_000;
export const REGISTRY_RECHECK_DAYS = 90;

/** Re-checks one business's verified Udyam / CIN. A cancelled Udyam or non-active company clears the stamp and records a failure. */
export async function recheckRegistry(businessId: string, now = new Date()): Promise<{ udyam?: string; mca?: string } | null> {
  const b = await prisma.business.findUnique({ where: { id: businessId } });
  if (!b) return null;
  const out: { udyam?: string; mca?: string } = {};
  let changed = false;
  const opts = { businessName: b.legalName ?? b.name };
  if (b.udyam && b.udyamVerifiedAt) {
    try {
      const r = await getUdyamProvider().lookup(b.udyam, opts);
      const ok = r?.status === "Active";
      out.udyam = r?.status ?? "not_found";
      await prisma.business.update({ where: { id: businessId }, data: { udyamLastCheckedAt: now, ...(ok ? {} : { udyamVerifiedAt: null }) } });
      if (!ok) {
        changed = true;
        await prisma.verificationRecord.create({ data: { businessId, tier: 1, kind: "udyam", status: "failed", provider: getUdyamProvider().name, details: JSON.parse(JSON.stringify({ number: b.udyam, recheck: true, status: out.udyam, snapshot: r, checkedAt: now.toISOString() })) } });
      }
    } catch (err) { if (!(err instanceof GstnProviderError || err instanceof DomainError)) throw err; }
  }
  if (b.cin && b.mcaVerifiedAt) {
    try {
      const r = await getMcaProvider().lookup(b.cin, opts);
      const ok = r?.status === "Active";
      out.mca = r?.status ?? "not_found";
      await prisma.business.update({ where: { id: businessId }, data: { mcaLastCheckedAt: now, mcaStatus: r?.status ?? "Inactive", ...(ok ? {} : { mcaVerifiedAt: null }) } });
      if (!ok) {
        changed = true;
        await prisma.verificationRecord.create({ data: { businessId, tier: 1, kind: "mca", status: "failed", provider: getMcaProvider().name, details: JSON.parse(JSON.stringify({ number: b.cin, recheck: true, status: out.mca, snapshot: r, checkedAt: now.toISOString() })) } });
      }
    } catch (err) { if (!(err instanceof GstnProviderError || err instanceof DomainError)) throw err; }
  }
  if (changed) await afterChange(businessId);
  return out;
}

export async function runRegistryRecheck(now = new Date(), maxPerRun = 100): Promise<number> {
  const cutoff = new Date(now.getTime() - REGISTRY_RECHECK_DAYS * DAY_MS);
  const due = await prisma.business.findMany({
    where: { OR: [{ udyamVerifiedAt: { not: null }, udyamLastCheckedAt: { lt: cutoff } }, { mcaVerifiedAt: { not: null }, mcaLastCheckedAt: { lt: cutoff } }] },
    select: { id: true }, orderBy: { id: "asc" }, take: maxPerRun,
  });
  for (const b of due) await recheckRegistry(b.id, now);
  return due.length;
}
export const registryWorkerJobs: ScheduledJob[] = [
  { name: "identity.registry-recheck", everyMs: DAY_MS, run: async () => void (await runRegistryRecheck()) },
];

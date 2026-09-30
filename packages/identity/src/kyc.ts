// T2 verification: document forensics + video KYC (ADR-003). Sub-module of @cnote/identity.
//
// Flow: startKyc -> uploadKycDocument (per type: validate, store privately, AI extract, classical checks, cross-checks
// vs declared data, per-document verdict) -> beginVideoKyc (provider hosted liveness link, KycSubmitted) ->
// completeKyc (webhook or poll: aggregate documents + liveness/face match) -> approved | rejected | review (staff
// decideKyc). Approval lifts the business to tier >= 2 (VerificationRecords document + video_kyc), recomputes trust.
//
// Data minimisation (DPDP, docs/design/t2-t3-verification.md): document images are stored in the PRIVATE bucket only and purged
// 90 days after the decision (purgeKycDocuments); PAN/Aadhaar are kept masked (+ PAN envelope-encrypted, dropped at
// purge); we never receive or store raw biometrics, only provider scores.
//
// Ports (AI extraction, object store, image inspection) are injected with setKycPorts by the composition root because
// @cnote/identity may only depend on core/db/security (ADR-006). Apps wire them from @cnote/ai and @cnote/media.
import { randomUUID } from "node:crypto";
import { DomainError, emit } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { encryptField } from "@cnote/security";
import { bustSellerCaches } from "./business";
import { nameSimilarity, maskPan, panFromGstin } from "./gst/normalise";
import { openPan } from "./gst/pan";
import { NAME_PASS, NAME_REVIEW } from "./gst/verify";
import { imageChecks } from "./kyc-forensics";
import { getKycProvider, type KycProviderResult } from "./kyc-provider";

export * from "./kyc-forensics";
export * from "./kyc-provider";

export const KYC_DOC_TYPES = ["gst_certificate", "pan_card", "bank_proof", "address_proof", "udyam_certificate"] as const;
export type KycDocType = (typeof KYC_DOC_TYPES)[number];
/** Needed before video KYC can start. */
export const REQUIRED_KYC_DOCS: readonly KycDocType[] = ["gst_certificate", "pan_card"];
export const KYC_SESSION_TTL_DAYS = 7;
export const KYC_RETENTION_DAYS = 90;
export const LIVENESS_MIN = 0.8;
export const FACE_MATCH_MIN = 0.75;
const DAY = 86_400_000;

// ---------------- ports ----------------
export interface KycExtraction {
  fields: { name?: string; pan?: string; gstin?: string; address?: string; issueDate?: string; udyam?: string; accountLast4?: string; ifsc?: string; aadhaarLast4?: string };
  forgerySignals: string[];
  confidence: number;
  needsReview: boolean;
  decisionId?: string;
}
export interface KycPorts {
  /** PRIVATE bucket store (media getMediaStore("private")). */
  store: { put(key: string, bytes: Uint8Array, contentType: string): Promise<void>; get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>; delete(key: string): Promise<void> };
  /** media validateImage: throws a seller-presentable Error for bad files. */
  inspectImage(bytes: Uint8Array): { mime: string; ext: string; width: number; height: number; sha256: string };
  /** ai.extractDocument (logged AiDecision, redacted). */
  extractDocument(input: { image: { bytes: Uint8Array; mimeType: string }; docType: KycDocType }, subject: { type: "business"; id: string }): Promise<KycExtraction>;
}
let ports: KycPorts | null = null;
export const setKycPorts = (p: KycPorts | null): void => void (ports = p);
export function kycPorts(): KycPorts {
  if (!ports) throw new Error("KYC ports are not configured (call setKycPorts at startup)");
  return ports;
}

/** Private-only object key. `bulk/` is the only private-only prefix media allows today; see docs (a dedicated `kyc/` prefix is requested). */
export const kycDocKey = (businessId: string, sessionId: string, docId: string, ext: string) => `kyc/${businessId}/${sessionId}/${docId}.${ext}`;

// ---------------- types ----------------
export interface KycActor { personId: string; businessId: string }
export type KycDocVerdict = "pending" | "pass" | "fail" | "review";
export interface KycCheck { id: string; result: "pass" | "warn" | "fail" | "skip"; detail: string }
export interface KycDocView {
  id: string; docType: KycDocType; verdict: KycDocVerdict; reasons: string[]; createdAt: string;
  /** masked values only */
  extracted: Record<string, string | undefined>;
  /** false once purged */
  hasImage: boolean;
}
export interface KycSessionView {
  id: string; businessId: string; status: "initiated" | "in_progress" | "review" | "approved" | "rejected" | "expired";
  provider: string; expiresAt: string; completedAt: string | null; reviewNote: string | null;
  livenessScore: number | null; faceMatchScore: number | null;
  documents: KycDocView[];
  missingRequired: KycDocType[];
}

const SESSION_INCLUDE = { documents: { orderBy: { createdAt: "asc" } } } as const satisfies Prisma.KycSessionInclude;
type SessionRow = Prisma.KycSessionGetPayload<{ include: typeof SESSION_INCLUDE }>;
const ACTIVE = ["initiated", "in_progress", "review"] as const;

const docView = (d: SessionRow["documents"][number]): KycDocView => {
  const x = d.extracted as Record<string, string | undefined>;
  const { panEnc: _enc, ...masked } = x;
  return {
    id: d.id, docType: d.docType as KycDocType, verdict: d.verdict as KycDocVerdict,
    reasons: ((d.checks as { reasons?: string[] }).reasons) ?? [], createdAt: d.createdAt.toISOString(), extracted: masked, hasImage: !!d.storageKey,
  };
};
const view = (s: SessionRow): KycSessionView => {
  const have = new Set(s.documents.filter((d) => d.verdict !== "fail").map((d) => d.docType));
  return {
    id: s.id, businessId: s.businessId, status: s.status, provider: s.provider, expiresAt: s.expiresAt.toISOString(),
    completedAt: s.completedAt?.toISOString() ?? null, reviewNote: s.reviewNote, livenessScore: s.livenessScore, faceMatchScore: s.faceMatchScore,
    documents: s.documents.map(docView), missingRequired: REQUIRED_KYC_DOCS.filter((t) => !have.has(t)),
  };
};

async function assertSignatory(actor: KycActor): Promise<void> {
  const m = await prisma.businessMember.findUnique({ where: { businessId_personId: { businessId: actor.businessId, personId: actor.personId } } });
  if (m?.role !== "owner") throw new DomainError("forbidden", "Only the business owner (authorised signatory) can complete KYC.");
}

async function loadOwned(actor: KycActor, sessionId: string): Promise<SessionRow> {
  const s = await prisma.kycSession.findUnique({ where: { id: sessionId }, include: SESSION_INCLUDE });
  if (!s || s.businessId !== actor.businessId) throw new DomainError("not_found", "KYC session not found.");
  return s;
}

/** Marks sessions past their expiry as expired (lazy, on access). */
async function expireIfStale(s: SessionRow, now = new Date()): Promise<SessionRow> {
  if ((ACTIVE as readonly string[]).includes(s.status) && s.expiresAt < now) {
    await prisma.kycSession.updateMany({ where: { id: s.id, status: { in: [...ACTIVE] } }, data: { status: "expired" } });
    return { ...s, status: "expired" };
  }
  return s;
}

// ---------------- start / read ----------------
/** Starts (or returns) the business's single active T2 session. Requires T1 (GST verified) and the owner. */
export async function startKyc(actor: KycActor, now = new Date()): Promise<KycSessionView> {
  await assertSignatory(actor);
  const b = await prisma.business.findUniqueOrThrow({ where: { id: actor.businessId }, select: { verificationTier: true } });
  if (b.verificationTier < 1) throw new DomainError("validation", "Verify your GSTIN first (Tier 1) before starting KYC.");
  if (b.verificationTier >= 2) throw new DomainError("conflict", "This business is already KYC verified.");
  const existing = await prisma.kycSession.findFirst({ where: { businessId: actor.businessId, status: { in: [...ACTIVE] } }, orderBy: { createdAt: "desc" }, include: SESSION_INCLUDE });
  if (existing) {
    const cur = await expireIfStale(existing, now);
    if (cur.status !== "expired") return view(cur);
  }
  const s = await prisma.kycSession.create({
    data: { businessId: actor.businessId, personId: actor.personId, provider: getKycProvider().name, expiresAt: new Date(now.getTime() + KYC_SESSION_TTL_DAYS * DAY) },
    include: SESSION_INCLUDE,
  });
  return view(s);
}

/** The business's latest session (any status), or null. */
export async function getKycSession(actor: KycActor): Promise<KycSessionView | null> {
  const s = await prisma.kycSession.findFirst({ where: { businessId: actor.businessId }, orderBy: { createdAt: "desc" }, include: SESSION_INCLUDE });
  return s ? view(await expireIfStale(s)) : null;
}

// ---------------- documents ----------------
export interface DeclaredData { gstin: string | null; names: string[]; pan: string | null; udyam: string | null }

export interface DocEvaluationInput {
  docType: KycDocType;
  fields: KycExtraction["fields"];
  declared: DeclaredData;
  forgerySignals: string[];
  aiNeedsReview: boolean;
  image: ReturnType<typeof imageChecks>;
  duplicateOtherBusiness: boolean;
}
const normUdyam = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Pure: per-document checks and verdict. fail beats review beats pass. */
export function evaluateKycDocument(i: DocEvaluationInput): { verdict: "pass" | "fail" | "review"; checks: KycCheck[]; reasons: string[] } {
  const c: KycCheck[] = [];
  const add = (id: string, result: KycCheck["result"], detail: string) => c.push({ id, result, detail });
  const f = i.fields;

  add("duplicate", i.duplicateOtherBusiness ? "fail" : "pass", i.duplicateOtherBusiness ? "This exact file was already submitted by another business." : "File is unique.");
  if (i.forgerySignals.length) add("forgery", "warn", `Possible tampering: ${i.forgerySignals.join("; ")}`);
  else add("forgery", "pass", "No visual tampering signals.");
  if (i.image.metadataAnomalies.length) add("metadata", "warn", i.image.metadataAnomalies.join("; "));
  else add("metadata", "pass", "No editing-software metadata.");
  const quality: string[] = [];
  if (i.image.lowResolution) quality.push("low resolution");
  if (i.image.likelyScreenshot) quality.push("looks like a screenshot");
  if (i.image.aspectImplausible) quality.push("unusual proportions");
  add("image_quality", quality.length ? "warn" : "pass", quality.length ? `Image ${quality.join(", ")}.` : "Resolution and proportions look plausible.");
  if (i.aiNeedsReview) add("ai_confidence", "warn", "Automatic reading was not confident.");

  const declaredPan = i.declared.pan ?? (i.declared.gstin ? panFromGstin(i.declared.gstin) : null);
  const need = (id: string, v: string | undefined, label: string) => { if (!v) add(id, "warn", `Could not read the ${label} from the document.`); return !!v; };

  switch (i.docType) {
    case "gst_certificate":
      if (need("gstin", f.gstin, "GSTIN")) {
        if (!i.declared.gstin) add("gstin", "warn", "No GSTIN on file to compare.");
        else add("gstin", f.gstin === i.declared.gstin ? "pass" : "fail", f.gstin === i.declared.gstin ? "GSTIN matches the verified GSTIN." : "GSTIN on the document differs from the business GSTIN.");
        if (f.pan) add("pan", f.pan === panFromGstin(f.gstin!) ? "pass" : "fail", f.pan === panFromGstin(f.gstin!) ? "PAN matches GSTIN characters 3-12." : "PAN on the document does not match its GSTIN.");
      }
      break;
    case "pan_card":
      if (need("pan", f.pan, "PAN")) {
        if (!declaredPan) add("pan", "warn", "No PAN or GSTIN on file to compare.");
        else add("pan", f.pan === declaredPan ? "pass" : "fail", f.pan === declaredPan ? "PAN matches the GSTIN / declared PAN." : "PAN differs from the GSTIN / declared PAN.");
      }
      break;
    case "udyam_certificate":
      if (need("udyam", f.udyam, "Udyam number") && i.declared.udyam) {
        const ok = normUdyam(f.udyam!) === normUdyam(i.declared.udyam);
        add("udyam", ok ? "pass" : "fail", ok ? "Udyam number matches." : "Udyam number differs from the one on file.");
      }
      break;
    case "bank_proof":
      need("account", f.accountLast4, "account number");
      break;
    case "address_proof":
      need("address", f.address, "address");
      break;
  }

  const names = i.declared.names.filter(Boolean);
  if (!f.name || names.length === 0) add("name", "warn", f.name ? "No declared name to compare." : "Could not read a name from the document.");
  else {
    const best = Math.max(...names.map((n) => nameSimilarity(n, f.name!)));
    const pct = Math.round(best * 100);
    // Personal documents (PAN, bank, address) legitimately carry a proprietor's name, so a mismatch there is a review, not a rejection.
    add("name", best >= NAME_PASS ? "pass" : best >= NAME_REVIEW || i.docType !== "gst_certificate" ? "warn" : "fail",
      best >= NAME_PASS ? `Name matches (${pct}%).` : `Name only ${pct}% similar to the declared name.`);
  }

  const verdict = c.some((x) => x.result === "fail") ? "fail" : c.some((x) => x.result === "warn") ? "review" : "pass";
  return { verdict, checks: c, reasons: c.filter((x) => x.result === "warn" || x.result === "fail").map((x) => x.detail) };
}

export interface UploadKycDocumentInput { docType: KycDocType; bytes: Uint8Array; mimeType: string }
export interface UploadKycDocumentResult { document: KycDocView }

/**
 * Validates, stores privately, extracts and checks one document, replacing an earlier upload of the same type.
 * Images only (JPEG/PNG/WebP): PDFs are not accepted yet (no server-side rasteriser); ask sellers to photograph or screenshot page 1.
 */
export async function uploadKycDocument(actor: KycActor, sessionId: string, input: UploadKycDocumentInput, now = new Date()): Promise<UploadKycDocumentResult> {
  await assertSignatory(actor);
  if (!(KYC_DOC_TYPES as readonly string[]).includes(input.docType)) throw new DomainError("validation", "Unknown document type.");
  const p = kycPorts();
  const s = await expireIfStale(await loadOwned(actor, sessionId), now);
  if (s.status !== "initiated" && s.status !== "in_progress") throw new DomainError("conflict", "This KYC session is no longer accepting documents.");

  let img: ReturnType<KycPorts["inspectImage"]>;
  try { img = p.inspectImage(input.bytes); } catch (err) { throw new DomainError("validation", err instanceof Error ? err.message : "Invalid image."); }

  const [b, person, dup] = await Promise.all([
    prisma.business.findUniqueOrThrow({ where: { id: actor.businessId } }),
    prisma.person.findUnique({ where: { id: actor.personId }, select: { name: true } }),
    prisma.kycDocument.findFirst({ where: { sha256: img.sha256, session: { businessId: { not: actor.businessId } } }, select: { id: true } }),
  ]);
  const declared: DeclaredData = {
    gstin: b.gstin, udyam: b.udyam, pan: await openPan(b.pan, b.id),
    names: [b.legalName, b.tradeName, b.name, input.docType === "pan_card" || input.docType === "bank_proof" ? person?.name : null].filter((x): x is string => !!x),
  };

  const docId = randomUUID();
  const ex = await p.extractDocument({ image: { bytes: input.bytes, mimeType: img.mime }, docType: input.docType }, { type: "business", id: actor.businessId });
  const ev = evaluateKycDocument({
    docType: input.docType, fields: ex.fields, declared, forgerySignals: ex.forgerySignals, aiNeedsReview: ex.needsReview,
    image: imageChecks(input.bytes, img.mime, img.width, img.height), duplicateOtherBusiness: !!dup,
  });

  const f = ex.fields;
  const extracted: Record<string, string> = {};
  for (const k of ["name", "gstin", "address", "issueDate", "udyam", "accountLast4", "ifsc", "aadhaarLast4"] as const) if (f[k]) extracted[k] = f[k]!;
  if (f.pan) { extracted.pan = maskPan(f.pan)!; extracted.panEnc = await encryptField(f.pan, `kyc.doc:${docId}`); }

  const key = kycDocKey(actor.businessId, sessionId, docId, img.ext);
  await p.store.put(key, input.bytes, img.mime);
  const prior = s.documents.filter((d) => d.docType === input.docType);
  const checks = { reasons: ev.reasons, checks: ev.checks, forgerySignals: ex.forgerySignals, aiConfidence: ex.confidence, aiDecisionId: ex.decisionId ?? null, width: img.width, height: img.height };
  const row = await prisma.$transaction(async (tx) => {
    await tx.kycDocument.deleteMany({ where: { id: { in: prior.map((d) => d.id) } } });
    return tx.kycDocument.create({
      data: { id: docId, sessionId, docType: input.docType, storageKey: key, sha256: img.sha256, extracted: extracted as Prisma.InputJsonValue, checks: JSON.parse(JSON.stringify(checks)), verdict: ev.verdict },
    });
  });
  for (const d of prior) if (d.storageKey) await p.store.delete(d.storageKey).catch(() => {}); // superseded upload: drop the image
  return { document: docView(row) };
}

// ---------------- video KYC ----------------
export async function beginVideoKyc(actor: KycActor, sessionId: string, opts: { returnUrl?: string } = {}, now = new Date()): Promise<{ url: string | null; session: KycSessionView }> {
  await assertSignatory(actor);
  const s = await expireIfStale(await loadOwned(actor, sessionId), now);
  if (s.status !== "initiated") throw new DomainError("conflict", s.status === "in_progress" ? "Video KYC has already started." : "This KYC session cannot start video KYC.");
  if (s.documents.some((d) => d.verdict === "fail")) throw new DomainError("validation", "Replace the documents that failed checks before starting video KYC.", undefined, "account.replaceDocumentsFailedChecksBefore");
  const v = view(s);
  if (v.missingRequired.length) throw new DomainError("validation", `Upload these documents first: ${v.missingRequired.join(", ")}.`);
  const provider = getKycProvider();
  const link = await provider.createSession({ sessionId, businessId: s.businessId, personId: s.personId, returnUrl: opts.returnUrl });
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.kycSession.updateMany({ where: { id: sessionId, status: "initiated" }, data: { status: "in_progress", provider: provider.name, providerRef: link.providerRef } });
    /* v8 ignore next */
    if (claimed.count === 0) throw new DomainError("conflict", "Video KYC has already started.", undefined, "account.videoKycAlreadyStarted");
    await emit(tx, "KycSubmitted", { type: "KycSession", id: sessionId }, { sessionId, businessId: s.businessId, provider: provider.name });
  });
  if (provider.instant) await completeKyc(sessionId, now);
  const fresh = await prisma.kycSession.findUniqueOrThrow({ where: { id: sessionId }, include: SESSION_INCLUDE });
  return { url: provider.instant ? null : link.url, session: view(fresh) };
}

/** Verifies the webhook signature, then completes the session it refers to. */
export async function handleKycWebhook(rawBody: string, headers: Record<string, string | undefined>): Promise<{ sessionId: string | null; status: string }> {
  const { providerRef } = getKycProvider().verifyWebhook(rawBody, headers);
  const s = await prisma.kycSession.findUnique({ where: { providerRef }, select: { id: true } });
  if (!s) return { sessionId: null, status: "unknown_reference" }; // ack so the provider stops retrying
  const r = await completeKyc(s.id);
  return { sessionId: s.id, status: r.status };
}

const applyApproval = (tx: Prisma.TransactionClient, s: SessionRow, decidedBy: string | null, details: Prisma.InputJsonValue, provider: string) =>
  (async () => {
    const cur = await tx.business.findUniqueOrThrow({ where: { id: s.businessId }, select: { verificationTier: true } });
    const tier = Math.max(cur.verificationTier, 2);
    await tx.business.update({ where: { id: s.businessId }, data: { verificationTier: tier } });
    await tx.verificationRecord.createMany({ data: [
      { businessId: s.businessId, tier: 2, kind: "document", status: "passed", provider: "kyc", details },
      { businessId: s.businessId, tier: 2, kind: "video_kyc", status: "passed", provider, details },
    ] });
    await emit(tx, "KycDecided", { type: "KycSession", id: s.id }, { sessionId: s.id, businessId: s.businessId, status: "approved", decidedBy });
    await emit(tx, "BusinessVerified", { type: "Business", id: s.businessId }, { businessId: s.businessId, tier, kind: "kyc" });
  })();

async function afterDecision(businessId: string): Promise<void> {
  const { recomputeTrust } = await import("./trust-worker"); // lazy: trust-worker imports this package's jobs
  await recomputeTrust(businessId);
  await bustSellerCaches(businessId);
}

export type CompleteKycOutcome = { status: "pending" } | { status: "approved" | "rejected" | "review"; reasons: string[] };

/** Aggregates document verdicts + provider liveness/face match. Idempotent: an already-decided session returns its status. */
export async function completeKyc(sessionId: string, now = new Date()): Promise<CompleteKycOutcome> {
  const s = await prisma.kycSession.findUnique({ where: { id: sessionId }, include: SESSION_INCLUDE });
  if (!s) throw new DomainError("not_found", "KYC session not found.");
  if (s.status === "approved" || s.status === "rejected" || s.status === "review") return { status: s.status, reasons: [] };
  if (s.status !== "in_progress" || !s.providerRef) throw new DomainError("conflict", "Video KYC has not started for this session.", undefined, "account.videoKycNotStartedSession");
  if (s.expiresAt < now) {
    await prisma.kycSession.updateMany({ where: { id: s.id, status: "in_progress" }, data: { status: "expired" } });
    throw new DomainError("conflict", "This KYC session has expired. Start again.");
  }
  const provider = getKycProvider();
  const r: KycProviderResult = await provider.getResult(s.providerRef);
  if (r.status === "pending") return { status: "pending" };

  const reasons: string[] = [];
  const v = view(s);
  if (v.missingRequired.length) reasons.push(`Missing documents: ${v.missingRequired.join(", ")}.`);
  const failedDocs = s.documents.filter((d) => d.verdict === "fail");
  const reviewDocs = s.documents.filter((d) => d.verdict === "review" || d.verdict === "pending");
  for (const d of failedDocs) reasons.push(`${d.docType}: ${docView(d).reasons.join(" ")}`);
  const liveOk = (r.livenessScore ?? 0) >= LIVENESS_MIN, faceOk = (r.faceMatchScore ?? 0) >= FACE_MATCH_MIN;
  if (r.status === "failed") reasons.push(`Video KYC failed${r.reasons?.length ? `: ${r.reasons.join(", ")}` : "."}`);
  else if (!liveOk || !faceOk) reasons.push("Liveness or face-match score is below the automatic threshold.");
  for (const d of reviewDocs) reasons.push(`${d.docType}: needs a staff look (${docView(d).reasons.join(" ")})`);

  const status: "approved" | "rejected" | "review" =
    failedDocs.length || r.status === "failed" || v.missingRequired.length ? "rejected"
    : !liveOk || !faceOk || reviewDocs.length ? "review" : "approved";
  const outcome = { reasons, provider: provider.name, providerStatus: r.status, providerReasons: r.reasons ?? [], documents: s.documents.map((d) => ({ id: d.id, docType: d.docType, verdict: d.verdict })) };
  const data = { status, livenessScore: r.livenessScore ?? null, faceMatchScore: r.faceMatchScore ?? null, outcome: outcome as Prisma.InputJsonValue, ...(status === "review" ? {} : { completedAt: now }) };

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.kycSession.updateMany({ where: { id: s.id, status: "in_progress" }, data });
    if (claimed.count === 0) return; // a concurrent delivery decided it
    if (status === "approved") await applyApproval(tx, s, null, outcome as Prisma.InputJsonValue, provider.name);
    else {
      if (status === "rejected") await tx.verificationRecord.create({ data: { businessId: s.businessId, tier: 2, kind: "video_kyc", status: "failed", provider: provider.name, details: outcome as Prisma.InputJsonValue } });
      await emit(tx, "KycDecided", { type: "KycSession", id: s.id }, { sessionId: s.id, businessId: s.businessId, status, decidedBy: null });
    }
  });
  if (status === "approved") await afterDecision(s.businessId);
  return { status, reasons };
}

// ---------------- staff ----------------
export interface KycReviewItem {
  id: string; businessId: string; businessName: string; status: KycSessionView["status"]; createdAt: string;
  livenessScore: number | null; faceMatchScore: number | null; reasons: string[]; documents: KycDocView[];
  declared: { gstin: string | null; legalName: string | null; tradeName: string | null; name: string; panMasked: string | null };
  reviewNote: string | null;
}

type BizLite = { name: string; legalName: string | null; tradeName: string | null; gstin: string | null; pan: string | null; id: string };
const BIZ_SELECT = { id: true, name: true, legalName: true, tradeName: true, gstin: true, pan: true } as const;

async function reviewItem(s: SessionRow, business: BizLite): Promise<KycReviewItem> {
  const pan = await openPan(business.pan, business.id);
  return {
    id: s.id, businessId: s.businessId, businessName: business.name, status: s.status, createdAt: s.createdAt.toISOString(),
    livenessScore: s.livenessScore, faceMatchScore: s.faceMatchScore, reasons: ((s.outcome as { reasons?: string[] }).reasons) ?? [], documents: s.documents.map(docView),
    declared: { gstin: business.gstin, legalName: business.legalName, tradeName: business.tradeName, name: business.name, panMasked: maskPan(pan ?? (business.gstin ? panFromGstin(business.gstin) : null)) },
    reviewNote: s.reviewNote,
  };
}

/** Sessions awaiting a staff decision, oldest first. */
export async function listKycReviews(opts: { status?: "review" | "approved" | "rejected"; limit?: number } = {}): Promise<KycReviewItem[]> {
  const rows = await prisma.kycSession.findMany({ where: { status: opts.status ?? "review" }, orderBy: { createdAt: "asc" }, take: Math.min(Math.max(opts.limit ?? 100, 1), 200), include: SESSION_INCLUDE });
  const biz = new Map((await prisma.business.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.businessId))] } }, select: BIZ_SELECT })).map((b) => [b.id, b]));
  return Promise.all(rows.map((r) => reviewItem(r, biz.get(r.businessId)!)));
}
export async function getKycReview(sessionId: string): Promise<KycReviewItem | null> {
  const s = await prisma.kycSession.findUnique({ where: { id: sessionId }, include: SESSION_INCLUDE });
  const b = s && (await prisma.business.findUnique({ where: { id: s.businessId }, select: BIZ_SELECT }));
  return s && b ? reviewItem(s, b) : null;
}

/** Staff-only image read for the admin preview route. Callers gate it with the kyc.review privilege. */
export async function readKycDocumentImage(documentId: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const d = await prisma.kycDocument.findUnique({ where: { id: documentId }, select: { storageKey: true } });
  return d?.storageKey ? kycPorts().store.get(d.storageKey) : null;
}

/** Staff decision on a session in `review`. Callers wrap this in admin.audited("kyc.review"). */
export async function decideKyc(sessionId: string, decision: "approved" | "rejected", note: string, staffId: string, now = new Date()): Promise<{ status: "approved" | "rejected" }> {
  if (!note.trim()) throw new DomainError("validation", "A note is required.", undefined, "account.noteRequired");
  const s = await prisma.kycSession.findUnique({ where: { id: sessionId }, include: SESSION_INCLUDE });
  if (!s) throw new DomainError("not_found", "KYC session not found.");
  if (s.status !== "review") throw new DomainError("conflict", "This session is not awaiting review.");
  const details = { manualReview: { decision, staffId, note: note.trim(), at: now.toISOString() }, ...(s.outcome as object) } as Prisma.InputJsonValue;
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.kycSession.updateMany({ where: { id: s.id, status: "review" }, data: { status: decision, reviewNote: note.trim(), reviewedBy: staffId, completedAt: now } });
    /* v8 ignore next */
    if (claimed.count === 0) throw new DomainError("conflict", "This session was already decided.", undefined, "account.sessionAlreadyDecided");
    if (decision === "approved") await applyApproval(tx, s, staffId, details, s.provider);
    else {
      await tx.verificationRecord.create({ data: { businessId: s.businessId, tier: 2, kind: "document", status: "failed", provider: "kyc", details } });
      await emit(tx, "KycDecided", { type: "KycSession", id: s.id }, { sessionId: s.id, businessId: s.businessId, status: "rejected", decidedBy: staffId });
    }
  });
  if (decision === "approved") await afterDecision(s.businessId);
  return { status: decision };
}

// ---------------- retention (DPDP storage limitation) ----------------
/**
 * Deletes document images (and the encrypted PAN) of sessions decided/expired before `before` (compliance passes now - 90 days).
 * Keeps the masked fields, verdicts and checks as the audit record. Idempotent. Needs setKycPorts (the object store).
 */
export async function purgeKycDocuments(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const where: Prisma.KycDocumentWhereInput = {
    session: { OR: [{ status: { in: ["approved", "rejected"] }, completedAt: { lt: before } }, { status: "expired", expiresAt: { lt: before } }] },
  };
  const rows = (await prisma.kycDocument.findMany({ where, select: { id: true, storageKey: true, extracted: true } }))
    .filter((r) => r.storageKey || "panEnc" in (r.extracted as object));
  if (opts.dryRun) return rows.length;
  for (const r of rows) {
    if (r.storageKey) await kycPorts().store.delete(r.storageKey);
    const { panEnc: _drop, ...rest } = r.extracted as Record<string, unknown>;
    await prisma.kycDocument.update({ where: { id: r.id }, data: { storageKey: null, extracted: rest as Prisma.InputJsonValue } });
  }
  return rows.length;
}

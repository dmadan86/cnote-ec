// Listing versioning: seller working copy → immutable ListingVersion → (auto/staff) review → publisher → LIVE db.
// See docs/design/listing-versioning-and-live-db.md. ADR-003 (moderation), ADR-007 (events), ADR-008 (HITL).
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import * as ai from "@cnote/ai";
import { DomainError, emit } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { getTrustProfiles } from "@cnote/identity";
import { bustListingCaches } from "./cache";
import { getCategoryById } from "./categories";
import { isUuid, listingInclude, type ListingRow } from "./mappers";
import { compactTrade, parsePriceTiers, parseTrade, tradeOfRow, type PriceTier, type TradeInfo } from "./tiers";
import { canonicalText, coerceAttributes, validateAttributes, validatePublishable } from "./validate";
import type { ListingView } from "./index";

export type VersionStatus = "submitted" | "in_review" | "approved" | "published" | "superseded" | "rejected" | "withdrawn";
const OPEN: VersionStatus[] = ["submitted", "in_review", "approved"];

/** Trusted-seller auto-approval policy (ADR-008: humans review everything else). */
export const AUTO_APPROVE = { minTier: 1, minTrust: 60 } as const;

const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
/**
 * Extra auto-approval gates (security audit H3). A model "allow" alone never publishes: the seller must also have an
 * aged account and a history of staff-approved versions, and a random sample of auto-approvals is audited by staff
 * after publication. Env-configurable: LISTING_AUTO_APPROVE_MIN_ACCOUNT_AGE_DAYS (30), _MIN_HUMAN_APPROVED (3), _SAMPLE_RATE (0.05).
 */
export function autoApprovePolicy(env: NodeJS.ProcessEnv = process.env) {
  return {
    ...AUTO_APPROVE,
    minAccountAgeDays: Math.max(0, num(env.LISTING_AUTO_APPROVE_MIN_ACCOUNT_AGE_DAYS, 30)),
    minHumanApproved: Math.max(0, num(env.LISTING_AUTO_APPROVE_MIN_HUMAN_APPROVED, 3)),
    sampleRate: Math.min(1, Math.max(0, num(env.LISTING_AUTO_APPROVE_SAMPLE_RATE, 0.05))),
  };
}

/** Pure decision: may this submission skip the staff queue? Requires deterministic-clean AND model allow AND seller history. */
export function mayAutoApprove(
  screening: { outcome: "allow" | "review" | "block"; deterministic?: string },
  seller: { verificationTier: number; trustScore: number; createdAt?: string } | null | undefined,
  humanApproved: number,
  now = new Date(),
  policy = autoApprovePolicy(),
): boolean {
  if (screening.outcome !== "allow" || screening.deterministic !== "clean") return false;
  if (!seller || seller.verificationTier < policy.minTier || seller.trustScore < policy.minTrust) return false;
  const created = seller.createdAt ? Date.parse(seller.createdAt) : NaN;
  if (!Number.isFinite(created) || now.getTime() - created < policy.minAccountAgeDays * 86_400_000) return false;
  return humanApproved >= policy.minHumanApproved;
}
export const PREVIEW_TOKEN_TTL_SECONDS = 3600;
const MAX_SCHEDULE_MS = 365 * 24 * 3600 * 1000;

/** Everything a buyer would see; frozen at submit time. */
export interface VersionSnapshot {
  title: string;
  description: string;
  categoryId: string;
  categoryName: string;
  attributes: Record<string, string | number>;
  pricePaise: number | null;
  priceUnit: string | null;
  moq: number | null;
  moqUnit: string | null;
  hsn: string | null;
  /** quantity slabs; absent on versions created before tiers existed */
  priceTiers?: PriceTier[];
  trade?: TradeInfo;
  language: string;
  /** approved, non-deleted images at submit time, in display order */
  imageIds: string[];
  /** placeholder urls from the working copy (used only when no uploaded image is approved) */
  imageUrls: string[];
}

export interface FieldChange {
  field: string;
  label: string;
  before: string | number | null;
  after: string | number | null;
}

export interface VersionView {
  id: string;
  listingId: string;
  version: number;
  status: VersionStatus;
  changeNote: string | null;
  changes: FieldChange[];
  aiVerdict: string | null;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  publishAt: string | null;
  publishedAt: string | null;
  createdBy: string;
  createdAt: string;
  snapshot: VersionSnapshot;
  isLive: boolean;
}

export interface VersionOverview {
  listingId: string;
  live: VersionView | null;
  /** the open (submitted / in review / approved-not-yet-live) version, if any */
  pending: VersionView | null;
  versions: VersionView[];
  /** working copy vs the newest version; empty = nothing new to submit */
  unsubmittedChanges: FieldChange[];
}

// ---------------------------------------------------------------------------------------------
// snapshot + diff

const attrsOf = (v: unknown): Record<string, string | number> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string | number>) : {};

export function snapshotOf(l: ListingRow, categoryName: string, attributes = attrsOf(l.attributes)): VersionSnapshot {
  return {
    title: l.title,
    description: l.description,
    categoryId: l.categoryId,
    categoryName,
    attributes,
    pricePaise: l.pricePaise === null ? null : Number(l.pricePaise),
    priceUnit: l.priceUnit,
    moq: l.moq,
    moqUnit: l.moqUnit,
    hsn: l.hsn,
    priceTiers: parsePriceTiers(l.priceTiers),
    trade: tradeOfRow(l),
    language: l.language,
    imageIds: l.images.map((i) => i.id),
    imageUrls: l.imageUrls,
  };
}

const SCALARS: { key: keyof VersionSnapshot; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "description", label: "Description" },
  { key: "categoryName", label: "Category" },
  { key: "pricePaise", label: "Price (paise)" },
  { key: "priceUnit", label: "Price unit" },
  { key: "moq", label: "Minimum order" },
  { key: "moqUnit", label: "MOQ unit" },
  { key: "hsn", label: "HSN" },
  { key: "language", label: "Language" },
];

const TRADE_FIELDS: [keyof TradeInfo, string][] = [
  ["leadTimeDays", "Lead time (days)"],
  ["packaging", "Packaging"],
  ["sampleAvailable", "Sample available"],
  ["samplePricePaise", "Sample price (paise)"],
  ["supplyCapacityPerMonth", "Supply capacity / month"],
  ["paymentTerms", "Payment terms"],
  ["certifications", "Certifications"],
  ["unitWeightGrams", "Unit weight (g)"],
  ["unitLengthMm", "Unit length (mm)"],
  ["unitWidthMm", "Unit width (mm)"],
  ["unitHeightMm", "Unit height (mm)"],
];
const summarise = (v: unknown): string | number | null => (v == null ? null : Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "yes" : "no") : (v as string | number));

/** Field-level diff (what a reviewer / the history UI shows). `before = null` means no earlier version. */
export function diffSnapshots(before: VersionSnapshot | null, after: VersionSnapshot): FieldChange[] {
  const out: FieldChange[] = [];
  const b = before as Partial<VersionSnapshot> | null;
  for (const { key, label } of SCALARS) {
    const x = (b?.[key] ?? null) as string | number | null;
    const y = (after[key] ?? null) as string | number | null;
    if (x !== y) out.push({ field: key === "categoryName" ? "category" : key, label, before: x, after: y });
  }
  const ba = b?.attributes ?? {};
  for (const k of [...new Set([...Object.keys(ba), ...Object.keys(after.attributes)])].sort()) {
    const x = ba[k] ?? null;
    const y = after.attributes[k] ?? null;
    if (x !== y) out.push({ field: `attributes.${k}`, label: k, before: x, after: y });
  }
  const tiersBefore = JSON.stringify(b?.priceTiers ?? []);
  const tiersAfter = JSON.stringify(after.priceTiers ?? []);
  if (tiersBefore !== tiersAfter) {
    const n = (t: PriceTier[] | undefined) => `${t?.length ?? 0} tier${t?.length === 1 ? "" : "s"}`;
    out.push({ field: "priceTiers", label: "Quantity price tiers", before: n(b?.priceTiers), after: n(after.priceTiers) });
  }
  const tb = compactTrade(b?.trade);
  const ta = compactTrade(after.trade);
  for (const [k, label] of TRADE_FIELDS) {
    const x = JSON.stringify(tb[k] ?? null);
    const y = JSON.stringify(ta[k] ?? null);
    if (x !== y) out.push({ field: `trade.${k}`, label, before: summarise(tb[k]), after: summarise(ta[k]) });
  }
  const bi = b?.imageIds ?? [];
  if (JSON.stringify(bi) !== JSON.stringify(after.imageIds)) {
    const added = after.imageIds.filter((i) => !bi.includes(i)).length;
    const removed = bi.filter((i) => !after.imageIds.includes(i)).length;
    const reordered = !added && !removed;
    out.push({
      field: "images",
      label: "Images",
      before: `${bi.length} image${bi.length === 1 ? "" : "s"}`,
      after: `${after.imageIds.length} image${after.imageIds.length === 1 ? "" : "s"}${reordered ? " (reordered)" : ` (+${added} / -${removed})`}`,
    });
  }
  return out;
}

type VersionRow = Prisma.ListingVersionGetPayload<object>;

function coerceSnapshot(raw: unknown): VersionSnapshot {
  const s = (raw ?? {}) as Partial<VersionSnapshot>;
  return {
    title: s.title ?? "",
    description: s.description ?? "",
    categoryId: s.categoryId ?? "",
    categoryName: s.categoryName ?? "",
    attributes: attrsOf(s.attributes),
    pricePaise: s.pricePaise ?? null,
    priceUnit: s.priceUnit ?? null,
    moq: s.moq ?? null,
    moqUnit: s.moqUnit ?? null,
    hsn: s.hsn ?? null,
    priceTiers: parsePriceTiers(s.priceTiers),
    trade: parseTrade(s.trade),
    language: s.language ?? "en",
    imageIds: Array.isArray(s.imageIds) ? s.imageIds : [],
    imageUrls: Array.isArray(s.imageUrls) ? s.imageUrls : [],
  };
}

/** @internal exported for the publisher */
export const parseSnapshot = coerceSnapshot;

export function toVersionView(v: VersionRow, liveVersionId: string | null): VersionView {
  return {
    id: v.id,
    listingId: v.listingId,
    version: v.version,
    status: v.status,
    changeNote: v.changeNote,
    changes: Array.isArray(v.changes) ? (v.changes as unknown as FieldChange[]) : [],
    aiVerdict: v.aiVerdict,
    reviewNote: v.reviewNote,
    reviewedBy: v.reviewedBy,
    reviewedAt: v.reviewedAt?.toISOString() ?? null,
    publishAt: v.publishAt?.toISOString() ?? null,
    publishedAt: v.publishedAt?.toISOString() ?? null,
    createdBy: v.createdBy,
    createdAt: v.createdAt.toISOString(),
    snapshot: coerceSnapshot(v.snapshot),
    isLive: v.id === liveVersionId,
  };
}

async function loadOwned(sellerBusinessId: string, listingId: string): Promise<ListingRow> {
  const row = isUuid(listingId) ? await prisma.listing.findUnique({ where: { id: listingId }, include: listingInclude }) : null;
  if (!row) throw new DomainError("not_found", "Listing not found", undefined, "ads.listingNotFound");
  if (row.sellerBusinessId !== sellerBusinessId) throw new DomainError("forbidden", "Not your listing");
  return row;
}

async function loadOwnedVersion(sellerBusinessId: string, versionId: string) {
  const v = isUuid(versionId) ? await prisma.listingVersion.findUnique({ where: { id: versionId }, include: { listing: { select: { sellerBusinessId: true, liveVersionId: true } } } }) : null;
  if (!v) throw new DomainError("not_found", "Version not found", undefined, "catalogue.versionNotFound");
  if (v.listing.sellerBusinessId !== sellerBusinessId) throw new DomainError("forbidden", "Not your listing");
  return v;
}

// ---------------------------------------------------------------------------------------------
// seller: submit / withdraw / history

export interface SubmitOptions {
  changeNote?: string | null;
  /** go live at this time once approved; null/past = as soon as approved */
  publishAt?: Date | string | null;
  /** person id of the submitter (audit); defaults to the seller business id */
  createdBy?: string;
}

function parsePublishAt(v: SubmitOptions["publishAt"]): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new DomainError("validation", "Invalid schedule time", undefined, "catalogue.invalidScheduleTime");
  if (d.getTime() - Date.now() > MAX_SCHEDULE_MS) throw new DomainError("validation", "Schedule at most one year ahead", undefined, "catalogue.scheduleMostOneYearAhead");
  return d.getTime() <= Date.now() ? null : d;
}

interface Screening {
  outcome: "allow" | "review" | "block";
  verdict: string;
  reason: string | null;
  /** deterministic pre-check result; auto-approval needs "clean" */
  deterministic?: string;
  decisionId?: string;
}

async function screen(listingId: string, snap: VersionSnapshot, category: { slug: string; name: string; prohibited: boolean }): Promise<Screening> {
  if (category.prohibited) return { outcome: "block", verdict: "block: prohibited category", reason: `Category "${category.name}" is not permitted on the marketplace` };
  const text = canonicalText(snap, category.name);
  const mod = await ai.moderate({ text, categorySlug: category.slug }, { type: "listing", id: listingId });
  if (mod.verdict === "block") {
    const reason = mod.reason ?? `Blocked by content policy${mod.flags.length ? `: ${mod.flags.join(", ")}` : ""}`;
    return { outcome: "block", verdict: `block: ${reason}`.slice(0, 300), reason, ...(mod.deterministic ? { deterministic: mod.deterministic } : {}), decisionId: mod.decisionId };
  }
  const review = mod.verdict === "review" || mod.needsReview;
  const reason = review ? (mod.reason ?? "Flagged for manual review") : null;
  return { outcome: review ? "review" : "allow", verdict: (review ? `review: ${reason}` : "allow").slice(0, 300), reason, ...(mod.deterministic ? { deterministic: mod.deterministic } : {}), decisionId: mod.decisionId };
}

/**
 * Snapshots the seller's working copy into a new immutable version, screens it and (for trusted sellers with a clean
 * verdict) auto-approves it; everything else waits in the staff queue. Nothing goes live here: the publisher does that
 * after a ListingVersionReviewed(approved) event, at `publishAt` if scheduled.
 * Any earlier still-open version is withdrawn: only the latest snapshot can be published.
 */
export async function submitListingVersion(sellerBusinessId: string, listingId: string, opts: SubmitOptions = {}): Promise<VersionView> {
  const cur = await loadOwned(sellerBusinessId, listingId);
  if (cur.status === "archived") throw new DomainError("conflict", "Archived listings cannot be submitted");
  const category = await getCategoryById(cur.categoryId);
  if (!category) throw new DomainError("validation", "Unknown category", undefined, "ads.unknownCategory");
  const attributes = coerceAttributes(category.attributeSchema, attrsOf(cur.attributes));
  const problems = [...validatePublishable(cur), ...validateAttributes(category.attributeSchema, attributes)];
  if (problems.length) throw new DomainError("validation", problems.join("; "), problems);

  const snap = snapshotOf(cur, category.name, attributes);
  const publishAt = parsePublishAt(opts.publishAt);
  const changeNote = opts.changeNote?.trim().slice(0, 500) || null;

  const liveRow = cur.liveVersionId ? await prisma.listingVersion.findUnique({ where: { id: cur.liveVersionId } }) : null;
  const liveSnap = liveRow ? coerceSnapshot(liveRow.snapshot) : null;
  const changes = diffSnapshots(liveSnap, snap);
  if (liveSnap && !changes.length && !publishAt) throw new DomainError("conflict", "Nothing has changed since the live version");

  const screening = await screen(cur.id, snap, category);
  const trust = (await getTrustProfiles([sellerBusinessId])).get(sellerBusinessId);
  // staff-approved history is only counted when the cheap gates pass (saves a query for new sellers)
  const humanApproved = screening.outcome === "allow" && screening.deterministic === "clean" && trust
    ? await prisma.listingVersion.count({ where: { listing: { sellerBusinessId }, reviewedBy: { not: null }, status: { in: ["approved", "published", "superseded"] } } })
    : 0;
  const policy = autoApprovePolicy();
  const trusted = mayAutoApprove(screening, trust, humanApproved, new Date(), policy);
  const audit = trusted && Math.random() < policy.sampleRate;
  const status: VersionStatus = screening.outcome === "block" ? "rejected" : trusted ? "approved" : "in_review";
  const decided = status === "approved" || status === "rejected";
  const reviewNote = status === "approved" ? `Auto-approved (trusted seller, clean screening${audit ? "; sampled for post-publication staff audit" : ""})` : status === "rejected" ? screening.reason : null;
  const base = { listingId: cur.id, sellerBusinessId };

  for (let attempt = 0; ; attempt++) {
    try {
      const created = await prisma.$transaction(async (tx) => {
        const max = await tx.listingVersion.aggregate({ where: { listingId: cur.id }, _max: { version: true } });
        const v = await tx.listingVersion.create({
          data: {
            listingId: cur.id,
            version: (max._max.version ?? 0) + 1,
            snapshot: snap as unknown as Prisma.InputJsonValue,
            changes: changes as unknown as Prisma.InputJsonValue,
            changeNote,
            status,
            aiVerdict: screening.verdict,
            reviewNote,
            reviewedAt: decided ? new Date() : null,
            publishAt,
            createdBy: opts.createdBy ?? sellerBusinessId,
          },
        });
        // a newer submission replaces any earlier open one
        await tx.listingVersion.updateMany({
          where: { listingId: cur.id, id: { not: v.id }, status: { in: OPEN } },
          data: { status: "withdrawn", reviewNote: `Replaced by version ${v.version}` },
        });
        if (!liveRow) {
          // never-live listing: reflect the newest verdict on the working copy (approved + draft = cleared, awaiting go-live)
          await tx.listing.update({
            where: { id: cur.id },
            data: { moderationStatus: status === "rejected" ? "rejected" : status === "in_review" ? "review" : "approved", moderationReason: status === "rejected" ? reviewNote : status === "in_review" ? screening.reason : null, ...(status === "rejected" ? { status: "draft" } : {}) },
          });
        }
        await emit(tx, "ListingVersionSubmitted", { type: "listing", id: cur.id }, { ...base, versionId: v.id, version: v.version, aiVerdict: screening.verdict });
        if (decided) {
          const st = status === "approved" ? "approved" : "rejected";
          await emit(tx, "ListingVersionReviewed", { type: "listing", id: cur.id }, { ...base, versionId: v.id, version: v.version, status: st, reviewedBy: null });
          await emit(tx, "ListingModerated", { type: "listing", id: cur.id }, { ...base, status: st, ...(reviewNote && st === "rejected" ? { reason: reviewNote } : {}) });
        } else {
          await emit(tx, "ListingModerated", { type: "listing", id: cur.id }, { ...base, status: "review", ...(screening.reason ? { reason: screening.reason } : {}) });
        }
        return v;
      });
      if (audit && status === "approved") {
        // best effort: the audit queue must never fail a submission that was already persisted
        await ai.enqueueReview({ subject: { type: "listing", id: cur.id }, reason: `Post-publication audit: version ${created.version} was auto-approved (random sample)`, decisionId: screening.decisionId ?? null }).catch(() => undefined);
      }
      await bustListingCaches(cur.id, sellerBusinessId);
      return toVersionView(created, cur.liveVersionId);
    } catch (e) {
      if (attempt < 3 && (e as { code?: string }).code === "P2002") continue; // concurrent submit took the version number
      throw e;
    }
  }
}

/** Seller pulls a version back before it goes live. The live version (if any) is untouched. */
export async function withdrawVersion(sellerBusinessId: string, versionId: string): Promise<VersionView> {
  const v = await loadOwnedVersion(sellerBusinessId, versionId);
  if (!OPEN.includes(v.status)) throw new DomainError("conflict", `A ${v.status.replace("_", " ")} version cannot be withdrawn`);
  const res = await prisma.listingVersion.updateMany({ where: { id: v.id, status: { in: OPEN } }, data: { status: "withdrawn", reviewNote: "Withdrawn by seller" } });
  if (!res.count) throw new DomainError("conflict", "Version is no longer pending", undefined, "catalogue.versionNoLongerPending");
  if (!v.listing.liveVersionId) {
    await prisma.listing.update({ where: { id: v.listingId }, data: { moderationStatus: "pending", moderationReason: null } });
  }
  await bustListingCaches(v.listingId, sellerBusinessId);
  return toVersionView((await prisma.listingVersion.findUniqueOrThrow({ where: { id: v.id } })), v.listing.liveVersionId);
}

/** Version history, newest first, with diffs, statuses and reviewer notes. */
export async function listListingVersions(sellerBusinessId: string, listingId: string): Promise<VersionView[]> {
  const cur = await loadOwned(sellerBusinessId, listingId);
  const rows = await prisma.listingVersion.findMany({ where: { listingId: cur.id }, orderBy: { version: "desc" }, take: 200 });
  return rows.map((r) => toVersionView(r, cur.liveVersionId));
}

/** History + "Live: v3 · Pending: v4 in review" state + whether the working copy has un-submitted edits. */
export async function getVersionOverview(sellerBusinessId: string, listingId: string): Promise<VersionOverview> {
  const cur = await loadOwned(sellerBusinessId, listingId);
  const rows = await prisma.listingVersion.findMany({ where: { listingId: cur.id }, orderBy: { version: "desc" }, take: 200 });
  const versions = rows.map((r) => toVersionView(r, cur.liveVersionId));
  const category = await getCategoryById(cur.categoryId);
  const snap = snapshotOf(cur, category?.name ?? "");
  const newest = versions.find((v) => v.status !== "withdrawn" && v.status !== "rejected") ?? versions[0] ?? null;
  return {
    listingId: cur.id,
    live: versions.find((v) => v.isLive) ?? null,
    pending: versions.find((v) => OPEN.includes(v.status)) ?? null,
    versions,
    unsubmittedChanges: cur.status === "archived" ? [] : diffSnapshots(newest ? newest.snapshot : null, snap),
  };
}

// ---------------------------------------------------------------------------------------------
// preview (seller-scoped and token-scoped)

export interface PreviewView extends ListingView {
  preview: {
    versionId: string;
    version: number;
    versionStatus: VersionStatus;
    changeNote: string | null;
    publishAt: string | null;
    /** ordered image ids of the snapshot; render through a token-gated route, not the public media route */
    imageIds: string[];
    seller: { name: string; city: string | null; state: string | null; verificationTier: number; trustScore: number; badgeActive: boolean } | null;
  };
}

async function buildPreview(v: VersionRow): Promise<PreviewView> {
  const snap = coerceSnapshot(v.snapshot);
  const listing = await prisma.listing.findUnique({ where: { id: v.listingId } });
  if (!listing) throw new DomainError("not_found", "Listing not found", undefined, "ads.listingNotFound");
  const category = await getCategoryById(snap.categoryId);
  const seller = (await getTrustProfiles([listing.sellerBusinessId])).get(listing.sellerBusinessId) ?? null;
  return {
    id: listing.id,
    sellerBusinessId: listing.sellerBusinessId,
    category: { id: snap.categoryId, slug: category?.slug ?? "", name: category?.name ?? snap.categoryName },
    title: snap.title,
    description: snap.description,
    attributes: snap.attributes,
    pricePaise: snap.pricePaise,
    priceUnit: snap.priceUnit,
    moq: snap.moq,
    moqUnit: snap.moqUnit,
    hsn: snap.hsn,
    priceTiers: snap.priceTiers ?? [],
    trade: snap.trade ?? {},
    language: snap.language,
    imageUrls: snap.imageIds.length ? snap.imageIds.map((id) => `/media/listing-images/${id}`) : snap.imageUrls,
    aiGenerated: listing.aiGenerated,
    status: "draft",
    moderationStatus: v.status === "approved" || v.status === "published" ? "approved" : v.status === "rejected" ? "rejected" : "review",
    moderationReason: v.reviewNote,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.createdAt.toISOString(),
    preview: {
      versionId: v.id,
      version: v.version,
      versionStatus: v.status,
      changeNote: v.changeNote,
      publishAt: v.publishAt?.toISOString() ?? null,
      imageIds: snap.imageIds,
      seller: seller ? { name: seller.name, city: seller.city, state: seller.state, verificationTier: seller.verificationTier, trustScore: seller.trustScore, badgeActive: seller.badgeActive } : null,
    },
  };
}

/** The version rendered as a listing, for the owning seller. Not cached, works for any status. */
export async function getVersionPreview(sellerBusinessId: string, versionId: string): Promise<PreviewView> {
  const v = await loadOwnedVersion(sellerBusinessId, versionId);
  return buildPreview(v);
}

function previewSecret(): string {
  const s = process.env.PREVIEW_TOKEN_SECRET ?? process.env.JWT_SECRET;
  if (!s) throw new Error("PREVIEW_TOKEN_SECRET (or JWT_SECRET) is not set");
  return s;
}
/**
 * The preview MAC key is DERIVED (HKDF-SHA256, purpose label), never the raw secret: PREVIEW_TOKEN_SECRET may fall back to
 * JWT_SECRET, and using that value directly as an HMAC key would let anything signed with it elsewhere double as a preview token
 * (same construction as packages/storefront/src/preview.ts).
 */
const previewKey = () => Buffer.from(hkdfSync("sha256", previewSecret(), "cnote-catalogue", "listing-preview-v1", 32));
const sign = (payload: string) => createHmac("sha256", previewKey()).update(`listing-preview:${payload}`).digest("base64url");

/** Short-lived (1h) HMAC token that lets anyone holding the link view one version's preview. */
export function createPreviewToken(versionId: string, now = Date.now()): string {
  if (!isUuid(versionId)) throw new DomainError("validation", "Invalid version id", undefined, "catalogue.invalidVersionId");
  const exp = Math.floor(now / 1000) + PREVIEW_TOKEN_TTL_SECONDS;
  const payload = `${versionId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

/** Returns the version id if the token is authentic and unexpired, else null. Constant-time signature check. */
export function verifyPreviewToken(token: string | null | undefined, now = Date.now()): { versionId: string } | null {
  if (!token) return null;
  const [versionId, exp, sig, ...rest] = token.split(".");
  if (!versionId || !exp || !sig || rest.length || !isUuid(versionId) || !/^\d{1,12}$/.test(exp)) return null;
  const want = Buffer.from(sign(`${versionId}.${exp}`));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (Number(exp) * 1000 < now) return null;
  return { versionId };
}

/** Preview for a valid token (web preview route). Null when the token is bad/expired or the version is gone. */
export async function getPreviewByToken(token: string | null | undefined): Promise<PreviewView | null> {
  const t = verifyPreviewToken(token);
  if (!t) return null;
  const v = await prisma.listingVersion.findUnique({ where: { id: t.versionId } });
  return v ? buildPreview(v) : null;
}

// ---------------------------------------------------------------------------------------------
// staff review

export interface ReviewQueueItem {
  versionId: string;
  listingId: string;
  version: number;
  title: string;
  sellerBusinessId: string;
  sellerName: string;
  sellerTier: number;
  sellerTrustScore: number;
  changeNote: string | null;
  aiVerdict: string | null;
  changeCount: number;
  firstVersion: boolean;
  publishAt: string | null;
  status: VersionStatus;
  createdAt: string;
}

/** Oldest first. Default: versions waiting for a human (in_review). */
export async function listVersionReviewQueue(opts: { status?: VersionStatus; cursor?: string; limit?: number } = {}): Promise<{ items: ReviewQueueItem[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(100, Math.trunc(opts.limit ?? 50)));
  const rows = await prisma.listingVersion.findMany({
    where: { status: opts.status ?? "in_review" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    ...(opts.cursor && isUuid(opts.cursor) ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    include: { listing: { select: { sellerBusinessId: true, title: true, liveVersionId: true } } },
  });
  const page = rows.slice(0, limit);
  const profiles = await getTrustProfiles([...new Set(page.map((r) => r.listing.sellerBusinessId))]);
  return {
    items: page.map((r) => {
      const p = profiles.get(r.listing.sellerBusinessId);
      return {
        versionId: r.id,
        listingId: r.listingId,
        version: r.version,
        title: coerceSnapshot(r.snapshot).title || r.listing.title,
        sellerBusinessId: r.listing.sellerBusinessId,
        sellerName: p?.name ?? "Unknown seller",
        sellerTier: p?.verificationTier ?? 0,
        sellerTrustScore: p?.trustScore ?? 0,
        changeNote: r.changeNote,
        aiVerdict: r.aiVerdict,
        changeCount: Array.isArray(r.changes) ? r.changes.length : 0,
        firstVersion: !r.listing.liveVersionId,
        publishAt: r.publishAt?.toISOString() ?? null,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      };
    }),
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}

export interface VersionForReview {
  version: VersionView;
  listingTitle: string;
  seller: { businessId: string; name: string; tier: number; trustScore: number; city: string | null; state: string | null } | null;
  /** the currently live snapshot to diff against (null = first publication) */
  live: { version: number; snapshot: VersionSnapshot } | null;
  /** live vs submitted, recomputed now (the stored `changes` is as of submit time) */
  changes: FieldChange[];
}

export async function getVersionForReview(versionId: string): Promise<VersionForReview | null> {
  const v = isUuid(versionId) ? await prisma.listingVersion.findUnique({ where: { id: versionId }, include: { listing: true } }) : null;
  if (!v) return null;
  const liveRow = v.listing.liveVersionId ? await prisma.listingVersion.findUnique({ where: { id: v.listing.liveVersionId } }) : null;
  const seller = (await getTrustProfiles([v.listing.sellerBusinessId])).get(v.listing.sellerBusinessId);
  const snap = coerceSnapshot(v.snapshot);
  return {
    version: toVersionView(v, v.listing.liveVersionId),
    listingTitle: v.listing.title,
    seller: seller ? { businessId: seller.businessId, name: seller.name, tier: seller.verificationTier, trustScore: seller.trustScore, city: seller.city, state: seller.state } : null,
    live: liveRow ? { version: liveRow.version, snapshot: coerceSnapshot(liveRow.snapshot) } : null,
    changes: diffSnapshots(liveRow ? coerceSnapshot(liveRow.snapshot) : null, snap),
  };
}

/**
 * Staff decision on a version waiting in the queue. Rejecting requires a note the seller will see. Approval does NOT
 * publish: it emits ListingVersionReviewed(approved), which the publisher subscribes to.
 */
export async function reviewListingVersion(versionId: string, decision: "approved" | "rejected", note: string | null | undefined, staffId: string): Promise<VersionView> {
  const clean = note?.trim() || null;
  if (decision === "rejected" && !clean) throw new DomainError("validation", "A note is required when rejecting a version", undefined, "catalogue.noteRequiredWhenRejectingVersion");
  const v = isUuid(versionId) ? await prisma.listingVersion.findUnique({ where: { id: versionId }, include: { listing: true } }) : null;
  if (!v) throw new DomainError("not_found", "Version not found", undefined, "catalogue.versionNotFound");
  if (v.status !== "in_review" && v.status !== "submitted") throw new DomainError("conflict", `Version is already ${v.status.replace("_", " ")}`);
  const base = { listingId: v.listingId, sellerBusinessId: v.listing.sellerBusinessId };
  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.listingVersion.updateMany({
      where: { id: v.id, status: { in: ["in_review", "submitted"] } },
      data: { status: decision === "approved" ? "approved" : "rejected", reviewNote: clean, reviewedBy: staffId, reviewedAt: new Date() },
    });
    if (!res.count) throw new DomainError("conflict", "Version was already decided", undefined, "catalogue.versionAlreadyDecided");
    if (!v.listing.liveVersionId) {
      await tx.listing.update({
        where: { id: v.listingId },
        data: decision === "approved" ? { moderationStatus: "approved", moderationReason: null } : { moderationStatus: "rejected", moderationReason: clean, status: "draft" },
      });
    }
    await emit(tx, "ListingVersionReviewed", { type: "listing", id: v.listingId }, { ...base, versionId: v.id, version: v.version, status: decision, reviewedBy: staffId });
    await emit(tx, "ListingModerated", { type: "listing", id: v.listingId }, { ...base, status: decision, ...(clean && decision === "rejected" ? { reason: clean } : {}) });
    return tx.listingVersion.findUniqueOrThrow({ where: { id: v.id } });
  });
  await bustListingCaches(v.listingId, v.listing.sellerBusinessId);
  return toVersionView(updated, v.listing.liveVersionId);
}

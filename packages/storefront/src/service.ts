// Storefront lifecycle: create/slug, draft autosave with optimistic concurrency, preview, publish with AI pre-screen,
// staff review queue, suspension and cached public reads. Owns only the Storefront* tables.
import { createHash, randomBytes } from "node:crypto";
import * as ai from "@cnote/ai";
import { cachedTagged, cacheTags, DomainError, emit, rateLimit } from "@cnote/core";
import { prisma, type Prisma, type Tx } from "@cnote/db";
import { getTrustProfiles } from "@cnote/identity";
import { purgeStorefront, storefrontTag } from "./cache";
import { listApprovedSellerImages, loadRenderData } from "./data";
import { blankDocument, collectImages, collectText, imageIdOf, validateDocument, SCHEMA_VERSION, type StorefrontDocument } from "./document";
import { signPreviewToken, verifyPreviewToken } from "./preview";
import type { RenderData } from "./render/types";
import { assertValidSlug, slugProblem, suggestSlug, SLUG_MAX } from "./slug";

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type StorefrontStatus = "draft" | "live" | "suspended";
export type VersionStatus = "draft" | "in_review" | "published" | "rejected" | "archived";

export interface StorefrontView {
  id: string;
  sellerBusinessId: string;
  slug: string;
  status: StorefrontStatus;
  templateKey: string | null;
  publishedVersionId: string | null;
  suspendedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VersionView {
  id: string;
  version: number;
  status: VersionStatus;
  aiVerdict: string | null;
  reviewNote: string | null;
  createdAt: string;
  publishedAt: string | null;
  reviewedAt: string | null;
}

export interface DraftState {
  storefront: StorefrontView;
  draft: VersionView;
  document: StorefrontDocument;
  /** Content hash; send it back to saveDraft as `expectedEtag` (optimistic concurrency). */
  etag: string;
  published: { versionId: string; etag: string; publishedAt: string | null } | null;
  hasUnpublishedChanges: boolean;
  pendingReview: { versionId: string; aiVerdict: string | null; submittedAt: string } | null;
  lastRejection: { note: string | null; at: string | null } | null;
}

export type PublishOutcome = {
  outcome: "published" | "in_review";
  versionId: string;
  version: number;
  verdict: "allow" | "review" | "block";
  flags: string[];
  reason: string | null;
};

export interface PublishedStorefront {
  storefront: { id: string; slug: string; sellerBusinessId: string; versionId: string; publishedAt: string | null; updatedAt: string };
  document: StorefrontDocument;
  data: RenderData;
}

const toStorefront = (r: Prisma.StorefrontGetPayload<object>): StorefrontView => ({
  id: r.id,
  sellerBusinessId: r.sellerBusinessId,
  slug: r.slug,
  status: r.status,
  templateKey: r.templateKey,
  publishedVersionId: r.publishedVersionId,
  suspendedReason: r.suspendedReason,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const toVersion = (r: Prisma.StorefrontVersionGetPayload<object>): VersionView => ({
  id: r.id,
  version: r.version,
  status: r.status,
  aiVerdict: r.aiVerdict,
  reviewNote: r.reviewNote,
  createdAt: r.createdAt.toISOString(),
  publishedAt: r.publishedAt?.toISOString() ?? null,
  reviewedAt: r.reviewedAt?.toISOString() ?? null,
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
/** Order-independent content hash (Postgres jsonb reorders keys, so never hash the raw string). */
export const documentEtag = (doc: unknown): string => createHash("sha1").update(canonical(doc)).digest("hex").slice(0, 16);

const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
const asJson = (d: StorefrontDocument) => d as unknown as Prisma.InputJsonValue;

function parseStored(json: unknown): StorefrontDocument {
  const v = validateDocument(json);
  if (!v.ok) throw new DomainError("validation", "The stored storefront is invalid.", { issues: v.issues });
  return v.document;
}

async function storefrontOf(sellerBusinessId: string) {
  const sf = await prisma.storefront.findUnique({ where: { sellerBusinessId } });
  if (!sf) throw new DomainError("not_found", "Create your storefront first.");
  return sf;
}

const lockVersion = (tx: Tx, id: string) => tx.$queryRaw`SELECT id FROM storefront_versions WHERE id = ${id}::uuid FOR UPDATE`;
const lockStorefront = (tx: Tx, id: string) => tx.$queryRaw`SELECT id FROM storefronts WHERE id = ${id}::uuid FOR UPDATE`;

// ---------------------------------------------------------------------------------------------
// Create + slug
// ---------------------------------------------------------------------------------------------

export async function isSlugAvailable(slug: string, exceptStorefrontId?: string): Promise<boolean> {
  if (slugProblem(slug)) return false;
  const hit = await prisma.storefront.findUnique({ where: { slug }, select: { id: true } });
  return !hit || hit.id === exceptStorefrontId;
}

export async function getStorefront(sellerBusinessId: string): Promise<StorefrontView | null> {
  const r = await prisma.storefront.findUnique({ where: { sellerBusinessId } });
  return r ? toStorefront(r) : null;
}

/** Idempotent. The slug is suggested from the business name (made unique with a numeric suffix); the seller can change it. */
export async function getOrCreateStorefront(sellerBusinessId: string, personId?: string): Promise<StorefrontView> {
  const existing = await prisma.storefront.findUnique({ where: { sellerBusinessId } });
  if (existing) return toStorefront(existing);
  const profile = (await getTrustProfiles([sellerBusinessId])).get(sellerBusinessId);
  if (!profile) throw new DomainError("not_found", "Business not found.");
  const base = suggestSlug(profile.name);
  const doc = blankDocument({ name: profile.name, city: profile.city });
  for (let attempt = 0; attempt < 12; attempt++) {
    const suffix = attempt === 0 ? "" : attempt < 8 ? `-${attempt + 1}` : `-${randomBytes(2).toString("hex")}`;
    const slug = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (slugProblem(slug)) continue;
    try {
      const row = await prisma.storefront.create({
        data: { sellerBusinessId, slug, versions: { create: { version: 1, document: asJson(doc), schemaVersion: SCHEMA_VERSION, createdBy: personId ?? null } } },
      });
      return toStorefront(row);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await prisma.storefront.findUnique({ where: { sellerBusinessId } });
      if (raced) return toStorefront(raced);
    }
  }
  throw new DomainError("conflict", "Could not find a free storefront address. Please choose one manually.");
}

export async function setSlug(sellerBusinessId: string, slug: string): Promise<StorefrontView> {
  const next = slug.trim().toLowerCase();
  assertValidSlug(next);
  const sf = await storefrontOf(sellerBusinessId);
  if (sf.slug === next) return toStorefront(sf);
  if (!(await isSlugAvailable(next, sf.id))) throw new DomainError("conflict", "That address is already taken.", { field: "slug" });
  try {
    const row = await prisma.storefront.update({ where: { id: sf.id }, data: { slug: next } });
    await purgeStorefront([sf.slug, next]);
    return toStorefront(row);
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError("conflict", "That address is already taken.", { field: "slug" });
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------

async function ensureDraftRow(storefrontId: string, personId?: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const draft = await prisma.storefrontVersion.findFirst({ where: { storefrontId, status: "draft" }, orderBy: { version: "desc" } });
    if (draft) return draft;
    const [source, latest] = await Promise.all([
      prisma.storefrontVersion.findFirst({ where: { storefrontId, status: { in: ["in_review", "published"] } }, orderBy: { version: "desc" } }),
      prisma.storefrontVersion.findFirst({ where: { storefrontId }, orderBy: { version: "desc" } }),
    ]);
    const base = source ?? latest;
    if (!base) throw new DomainError("not_found", "Storefront has no versions.");
    try {
      return await prisma.storefrontVersion.create({
        data: { storefrontId, version: (latest?.version ?? 0) + 1, document: base.document as Prisma.InputJsonValue, schemaVersion: base.schemaVersion, createdBy: personId ?? null },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new DomainError("conflict", "Could not open a draft. Please retry.");
}

export async function getDraft(sellerBusinessId: string, personId?: string): Promise<DraftState> {
  const sf = await storefrontOf(sellerBusinessId);
  const draft = await ensureDraftRow(sf.id, personId);
  const [published, pending, rejected] = await Promise.all([
    sf.publishedVersionId ? prisma.storefrontVersion.findUnique({ where: { id: sf.publishedVersionId } }) : null,
    prisma.storefrontVersion.findFirst({ where: { storefrontId: sf.id, status: "in_review" }, orderBy: { version: "desc" } }),
    prisma.storefrontVersion.findFirst({ where: { storefrontId: sf.id, status: "rejected" }, orderBy: { version: "desc" } }),
  ]);
  const doc = parseStored(draft.document);
  const etag = documentEtag(doc);
  const pubEtag = published ? documentEtag(published.document) : null;
  const rejectedIsLatest = rejected && (!published || rejected.version > published.version) && (!pending || rejected.version > pending.version);
  return {
    storefront: toStorefront(sf),
    draft: toVersion(draft),
    document: doc,
    etag,
    published: published && pubEtag ? { versionId: published.id, etag: pubEtag, publishedAt: published.publishedAt?.toISOString() ?? null } : null,
    hasUnpublishedChanges: pubEtag !== etag,
    pendingReview: pending ? { versionId: pending.id, aiVerdict: pending.aiVerdict, submittedAt: pending.createdAt.toISOString() } : null,
    lastRejection: rejectedIsLatest ? { note: rejected.reviewNote, at: rejected.reviewedAt?.toISOString() ?? null } : null,
  };
}

/**
 * Autosave. `expectedEtag` is the etag the editor last saw; if the stored draft changed since (another tab, an AI
 * builder, a template apply) a `conflict` DomainError carries the current etag so the editor can reload.
 */
export async function saveDraft(sellerBusinessId: string, personId: string, input: unknown, expectedEtag: string | null): Promise<{ etag: string; versionId: string; savedAt: string }> {
  if (!(await rateLimit(`storefront:save:${sellerBusinessId}`, 90, 60))) throw new DomainError("rate_limited", "Saving too fast. Please wait a moment.");
  const v = validateDocument(input);
  if (!v.ok) throw new DomainError("validation", "Some fields need attention before this can be saved.", { issues: v.issues });
  const sf = await storefrontOf(sellerBusinessId);
  const draft = await ensureDraftRow(sf.id, personId);
  return prisma.$transaction(async (tx) => {
    await lockVersion(tx, draft.id);
    const cur = await tx.storefrontVersion.findUniqueOrThrow({ where: { id: draft.id } });
    const curEtag = documentEtag(cur.document);
    if (cur.status !== "draft" || (expectedEtag !== null && expectedEtag !== curEtag)) {
      throw new DomainError("conflict", "This storefront was changed elsewhere. Reload to continue.", { etag: curEtag });
    }
    await tx.storefrontVersion.update({ where: { id: cur.id }, data: { document: asJson(v.document), schemaVersion: SCHEMA_VERSION, createdBy: personId } });
    return { etag: documentEtag(v.document), versionId: cur.id, savedAt: new Date().toISOString() };
  });
}

export async function listVersions(sellerBusinessId: string, limit = 30): Promise<VersionView[]> {
  const sf = await storefrontOf(sellerBusinessId);
  const rows = await prisma.storefrontVersion.findMany({ where: { storefrontId: sf.id }, orderBy: { version: "desc" }, take: Math.min(limit, 100) });
  return rows.map(toVersion);
}

/** Copies an older version's content into the working draft (history is kept; nothing is deleted). */
export async function restoreVersion(sellerBusinessId: string, personId: string, versionId: string): Promise<DraftState> {
  const sf = await storefrontOf(sellerBusinessId);
  const src = await prisma.storefrontVersion.findFirst({ where: { id: versionId, storefrontId: sf.id } });
  if (!src) throw new DomainError("not_found", "Version not found.");
  const doc = parseStored(src.document);
  const draft = await ensureDraftRow(sf.id, personId);
  await prisma.storefrontVersion.update({ where: { id: draft.id }, data: { document: asJson(doc), createdBy: personId } });
  return getDraft(sellerBusinessId, personId);
}

/**
 * Replaces the working draft with `doc` while keeping the previous draft in history (archived) — used by
 * applyTemplate and by future AI builders. Bypasses optimistic concurrency deliberately: it is an explicit reset.
 */
export async function replaceDraft(sellerBusinessId: string, personId: string, doc: StorefrontDocument, opts: { templateKey?: string | null } = {}): Promise<DraftState> {
  const sf = await storefrontOf(sellerBusinessId);
  await prisma.$transaction(async (tx) => {
    await lockStorefront(tx, sf.id);
    await tx.storefrontVersion.updateMany({ where: { storefrontId: sf.id, status: "draft" }, data: { status: "archived" } });
    const latest = await tx.storefrontVersion.findFirst({ where: { storefrontId: sf.id }, orderBy: { version: "desc" }, select: { version: true } });
    await tx.storefrontVersion.create({ data: { storefrontId: sf.id, version: (latest?.version ?? 0) + 1, document: asJson(doc), schemaVersion: SCHEMA_VERSION, createdBy: personId } });
    if (opts.templateKey !== undefined) await tx.storefront.update({ where: { id: sf.id }, data: { templateKey: opts.templateKey } });
  });
  return getDraft(sellerBusinessId, personId);
}

// ---------------------------------------------------------------------------------------------
// Preview (signed, short-lived)
// ---------------------------------------------------------------------------------------------

export async function previewDraft(sellerBusinessId: string): Promise<{ token: string; expiresAt: string }> {
  const sf = await storefrontOf(sellerBusinessId);
  const { token, expiresAt } = signPreviewToken(sf.id);
  return { token, expiresAt: expiresAt.toISOString() };
}

/** Public (token-authenticated) render of the CURRENT draft. Never cached. */
export async function getDraftByPreviewToken(token: string): Promise<{ storefront: StorefrontView; document: StorefrontDocument; data: RenderData }> {
  const storefrontId = verifyPreviewToken(token);
  const sf = await prisma.storefront.findUnique({ where: { id: storefrontId } });
  if (!sf) throw new DomainError("not_found", "Storefront not found.");
  const draft = await ensureDraftRow(sf.id);
  return { storefront: toStorefront(sf), document: parseStored(draft.document), data: await loadRenderData(sf.sellerBusinessId) };
}

/** Live data + draft document for the editor's own preview pane. */
export async function getEditorData(sellerBusinessId: string): Promise<RenderData> {
  return loadRenderData(sellerBusinessId);
}

// ---------------------------------------------------------------------------------------------
// Publish (AI pre-screen; flagged → staff review)
// ---------------------------------------------------------------------------------------------

async function assertImagesApproved(sellerBusinessId: string, doc: StorefrontDocument): Promise<void> {
  const used = [...new Set(collectImages(doc).map((i) => imageIdOf(i.src)).filter((x): x is string => !!x))];
  if (!used.length) return;
  const approved = new Set((await listApprovedSellerImages(sellerBusinessId)).map((i) => i.id));
  const bad = used.filter((id) => !approved.has(id));
  if (bad.length) throw new DomainError("validation", `${bad.length} image${bad.length === 1 ? " is" : "s are"} not approved yet. Only approved images can be published.`, { imageIds: bad });
}

async function screenText(sellerBusinessId: string, doc: StorefrontDocument): Promise<{ verdict: "allow" | "review" | "block"; flags: string[]; reason: string | null }> {
  const chunks: string[] = [];
  let cur = "";
  for (const t of collectText(doc)) {
    if (cur.length + t.length > 6000) {
      chunks.push(cur);
      cur = "";
    }
    cur += `${t}\n`;
  }
  if (cur) chunks.push(cur);
  let verdict: "allow" | "review" | "block" = "allow";
  const flags = new Set<string>();
  const reasons: string[] = [];
  for (const text of chunks.slice(0, 8)) {
    try {
      const r = await ai.moderate({ text }, { type: "business", id: sellerBusinessId });
      r.flags.forEach((f) => flags.add(f));
      if (r.reason) reasons.push(r.reason);
      if (r.verdict === "block") verdict = "block";
      else if (r.verdict === "review" && verdict !== "block") verdict = "review";
      // low-confidence AI results are queued for a human too (ADR-008)
      else if (r.needsReview && verdict === "allow") verdict = "review";
    } catch (err) {
      // fail closed: if screening is unavailable, a human decides; nothing auto-publishes unscreened.
      console.error("[storefront] moderation failed:", err instanceof Error ? err.message : err);
      verdict = verdict === "block" ? "block" : "review";
      reasons.push("Automated screening was unavailable.");
    }
  }
  return { verdict, flags: [...flags], reason: reasons.length ? reasons.join(" ").slice(0, 500) : null };
}

async function goLive(tx: Tx, sf: { id: string; publishedVersionId: string | null }, versionId: string, reviewer?: string): Promise<void> {
  if (sf.publishedVersionId && sf.publishedVersionId !== versionId) {
    await tx.storefrontVersion.update({ where: { id: sf.publishedVersionId }, data: { status: "archived" } });
  }
  await tx.storefrontVersion.update({
    where: { id: versionId },
    data: { status: "published", publishedAt: new Date(), ...(reviewer ? { reviewedBy: reviewer, reviewedAt: new Date() } : {}) },
  });
  await tx.storefront.update({ where: { id: sf.id }, data: { status: "live", publishedVersionId: versionId, suspendedReason: null } });
}

/**
 * Publish the current draft. Clean → live immediately (StorefrontPublished). Flagged (AI verdict review/block, or
 * screening unavailable) → the version waits in `in_review` for staff and NOTHING goes live. Images must be the
 * seller's approved platform images.
 */
export async function publish(sellerBusinessId: string, personId: string): Promise<PublishOutcome> {
  const sf = await storefrontOf(sellerBusinessId);
  if (sf.status === "suspended") throw new DomainError("forbidden", "This storefront is suspended. Contact support.", { reason: sf.suspendedReason });
  if (!(await rateLimit(`storefront:publish:${sellerBusinessId}`, 10, 3600))) throw new DomainError("rate_limited", "Too many publish attempts. Try again later.");
  const draftRow = await ensureDraftRow(sf.id, personId);
  const doc = parseStored(draftRow.document);
  await assertImagesApproved(sellerBusinessId, doc);
  const screen = await screenText(sellerBusinessId, doc);
  const clean = screen.verdict === "allow";
  const verdictLabel = clean ? "allow" : `${screen.verdict}${screen.flags.length ? `: ${screen.flags.join(", ")}` : ""}`;

  await prisma.$transaction(async (tx) => {
    await lockStorefront(tx, sf.id);
    const fresh = await tx.storefront.findUniqueOrThrow({ where: { id: sf.id } });
    if (fresh.status === "suspended") throw new DomainError("forbidden", "This storefront is suspended.");
    const v = await tx.storefrontVersion.findUniqueOrThrow({ where: { id: draftRow.id } });
    if (v.status !== "draft") throw new DomainError("conflict", "This draft was already submitted.");
    if (clean) {
      await tx.storefrontVersion.update({ where: { id: v.id }, data: { aiVerdict: verdictLabel } });
      await goLive(tx, fresh, v.id);
      await emit(tx, "StorefrontPublished", { type: "Storefront", id: sf.id }, { storefrontId: sf.id, sellerBusinessId, slug: fresh.slug, versionId: v.id });
    } else {
      // a newer submission supersedes an older one still waiting for review
      await tx.storefrontVersion.updateMany({ where: { storefrontId: sf.id, status: "in_review" }, data: { status: "archived" } });
      await tx.storefrontVersion.update({ where: { id: v.id }, data: { status: "in_review", aiVerdict: `${verdictLabel}${screen.reason ? ` | ${screen.reason}` : ""}`.slice(0, 900) } });
    }
  });
  if (clean) await purgeStorefront([sf.slug]);
  return { outcome: clean ? "published" : "in_review", versionId: draftRow.id, version: draftRow.version, verdict: screen.verdict, flags: screen.flags, reason: screen.reason };
}

// ---------------------------------------------------------------------------------------------
// Staff: review queue, suspension
// ---------------------------------------------------------------------------------------------

export interface ReviewQueueItem {
  versionId: string;
  version: number;
  storefrontId: string;
  slug: string;
  sellerBusinessId: string;
  businessName: string;
  status: VersionStatus;
  aiVerdict: string | null;
  reviewNote: string | null;
  createdAt: string;
}

export async function listStorefrontReviews(opts: { status?: "in_review" | "published" | "rejected"; limit?: number } = {}): Promise<ReviewQueueItem[]> {
  const rows = await prisma.storefrontVersion.findMany({
    where: { status: opts.status ?? "in_review" },
    include: { storefront: true },
    orderBy: { createdAt: "asc" },
    take: Math.min(opts.limit ?? 50, 200),
  });
  const names = await getTrustProfiles([...new Set(rows.map((r) => r.storefront.sellerBusinessId))]);
  return rows.map((r) => ({
    versionId: r.id,
    version: r.version,
    storefrontId: r.storefrontId,
    slug: r.storefront.slug,
    sellerBusinessId: r.storefront.sellerBusinessId,
    businessName: names.get(r.storefront.sellerBusinessId)?.name ?? "Unknown business",
    status: r.status,
    aiVerdict: r.aiVerdict,
    reviewNote: r.reviewNote,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Everything staff need to judge a submission: the document, live platform data and the AI verdict. */
export async function getStorefrontVersionForReview(versionId: string): Promise<{ item: ReviewQueueItem; document: StorefrontDocument; data: RenderData } | null> {
  const r = await prisma.storefrontVersion.findUnique({ where: { id: versionId }, include: { storefront: true } });
  if (!r) return null;
  const data = await loadRenderData(r.storefront.sellerBusinessId);
  return {
    item: {
      versionId: r.id, version: r.version, storefrontId: r.storefrontId, slug: r.storefront.slug, sellerBusinessId: r.storefront.sellerBusinessId,
      businessName: data.business.name, status: r.status, aiVerdict: r.aiVerdict, reviewNote: r.reviewNote, createdAt: r.createdAt.toISOString(),
    },
    document: parseStored(r.document),
    data,
  };
}

/** Call inside admin.audited(ctx, "storefronts.review", …). A rejection needs a note (shown to the seller). */
export async function reviewStorefrontVersion(versionId: string, staffId: string, outcome: "approved" | "rejected", note?: string): Promise<VersionView> {
  if (outcome === "rejected" && !note?.trim()) throw new DomainError("validation", "Tell the seller why this was rejected.", { field: "note" });
  const row = await prisma.storefrontVersion.findUnique({ where: { id: versionId }, include: { storefront: true } });
  if (!row) throw new DomainError("not_found", "Version not found.");
  const slug = row.storefront.slug;
  const res = await prisma.$transaction(async (tx) => {
    await lockStorefront(tx, row.storefrontId);
    const v = await tx.storefrontVersion.findUniqueOrThrow({ where: { id: versionId } });
    const sf = await tx.storefront.findUniqueOrThrow({ where: { id: row.storefrontId } });
    if (v.status !== "in_review") throw new DomainError("conflict", "This version is no longer waiting for review.");
    if (outcome === "approved") {
      if (sf.status === "suspended") throw new DomainError("conflict", "Reinstate the suspended storefront before approving.");
      await goLive(tx, sf, v.id, staffId);
      await tx.storefrontVersion.update({ where: { id: v.id }, data: { reviewNote: note?.trim() || null } });
      await emit(tx, "StorefrontPublished", { type: "Storefront", id: sf.id }, { storefrontId: sf.id, sellerBusinessId: sf.sellerBusinessId, slug: sf.slug, versionId: v.id });
    } else {
      await tx.storefrontVersion.update({ where: { id: v.id }, data: { status: "rejected", reviewNote: note!.trim().slice(0, 500), reviewedBy: staffId, reviewedAt: new Date() } });
    }
    await emit(tx, "StorefrontVersionReviewed", { type: "Storefront", id: sf.id }, { storefrontId: sf.id, sellerBusinessId: sf.sellerBusinessId, versionId: v.id, status: outcome === "approved" ? "published" : "rejected", reviewedBy: staffId });
    return tx.storefrontVersion.findUniqueOrThrow({ where: { id: v.id } });
  });
  if (outcome === "approved") await purgeStorefront([slug]);
  return toVersion(res);
}

/** Call inside admin.audited(ctx, "storefronts.review", …). Hides the storefront everywhere (hard purge). */
export async function suspendStorefront(storefrontId: string, staffId: string, reason: string): Promise<StorefrontView> {
  const why = reason.trim();
  if (!why) throw new DomainError("validation", "A reason is required.", { field: "reason" });
  const row = await prisma.$transaction(async (tx) => {
    const sf = await tx.storefront.findUnique({ where: { id: storefrontId } });
    if (!sf) throw new DomainError("not_found", "Storefront not found.");
    const u = await tx.storefront.update({ where: { id: sf.id }, data: { status: "suspended", suspendedReason: why.slice(0, 500) } });
    await emit(tx, "StorefrontSuspended", { type: "Storefront", id: sf.id }, { storefrontId: sf.id, sellerBusinessId: sf.sellerBusinessId, reason: why.slice(0, 500) });
    void staffId;
    return u;
  });
  await purgeStorefront([row.slug]);
  return toStorefront(row);
}

export async function reinstateStorefront(storefrontId: string): Promise<StorefrontView> {
  const sf = await prisma.storefront.findUnique({ where: { id: storefrontId } });
  if (!sf) throw new DomainError("not_found", "Storefront not found.");
  if (sf.status !== "suspended") return toStorefront(sf);
  const row = await prisma.storefront.update({ where: { id: sf.id }, data: { status: sf.publishedVersionId ? "live" : "draft", suspendedReason: null } });
  await purgeStorefront([row.slug]);
  return toStorefront(row);
}

export async function listStorefronts(opts: { status?: StorefrontStatus; q?: string; limit?: number } = {}): Promise<(StorefrontView & { businessName: string })[]> {
  const q = opts.q?.trim().toLowerCase();
  const rows = await prisma.storefront.findMany({
    where: { ...(opts.status ? { status: opts.status } : {}), ...(q ? { slug: { contains: q } } : {}) },
    orderBy: { updatedAt: "desc" },
    take: Math.min(opts.limit ?? 50, 200),
  });
  const names = await getTrustProfiles(rows.map((r) => r.sellerBusinessId));
  return rows.map((r) => ({ ...toStorefront(r), businessName: names.get(r.sellerBusinessId)?.name ?? "Unknown business" }));
}

// ---------------------------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------------------------

export interface ResolvedStorefront {
  id: string;
  slug: string;
  sellerBusinessId: string;
  status: StorefrontStatus;
  publishedVersionId: string | null;
}

/** Uncached slug → storefront lookup (host routing, analytics). Includes non-live rows; check `status`. */
export async function resolveStorefrontBySlug(slug: string): Promise<ResolvedStorefront | null> {
  if (slugProblem(slug)) return null;
  const r = await prisma.storefront.findUnique({ where: { slug }, select: { id: true, slug: true, sellerBusinessId: true, status: true, publishedVersionId: true } });
  return r;
}

export async function resolveStorefrontById(id: string): Promise<ResolvedStorefront | null> {
  return prisma.storefront.findUnique({ where: { id }, select: { id: true, slug: true, sellerBusinessId: true, status: true, publishedVersionId: true } });
}

const NOT_LIVE = Symbol("storefront-not-live");

/**
 * The live storefront for a slug (document + live platform data), or null when it does not exist / is not live /
 * is suspended. Redis-cached (300s + SWR) under tags `storefront:<slug>`, `seller:<biz>` and `seller-listings:<biz>`,
 * so publish, suspension, trust changes and listing moderation all purge it. Misses are never cached.
 */
export async function getPublishedStorefront(slug: string): Promise<PublishedStorefront | null> {
  if (slugProblem(slug)) return null;
  try {
    return await cachedTagged<PublishedStorefront>(
      `storefront:v1:${slug}`,
      (v) => [storefrontTag(slug), cacheTags.seller(v.storefront.sellerBusinessId), cacheTags.sellerListings(v.storefront.sellerBusinessId)],
      300,
      async () => {
        const sf = await prisma.storefront.findUnique({ where: { slug }, include: { published: true } });
        if (!sf || sf.status !== "live" || !sf.published) throw NOT_LIVE;
        const v = validateDocument(sf.published.document);
        if (!v.ok) {
          console.error(`[storefront] stored document for ${slug} is invalid`, v.issues.slice(0, 3));
          throw NOT_LIVE;
        }
        return {
          storefront: { id: sf.id, slug: sf.slug, sellerBusinessId: sf.sellerBusinessId, versionId: sf.published.id, publishedAt: sf.published.publishedAt?.toISOString() ?? null, updatedAt: sf.updatedAt.toISOString() },
          document: v.document,
          data: await loadRenderData(sf.sellerBusinessId),
        };
      },
      { staleSeconds: 600 },
    );
  } catch (err) {
    if (err === NOT_LIVE) return null;
    throw err;
  }
}

/** Slugs of live storefronts for generateStaticParams / sitemaps (most recently published first). */
export async function listLiveStorefrontSlugs(limit = 100): Promise<{ slug: string; updatedAt: string }[]> {
  const rows = await prisma.storefront.findMany({
    where: { status: "live", publishedVersionId: { not: null } },
    select: { slug: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: Math.min(limit, 5000),
  });
  return rows.map((r) => ({ slug: r.slug, updatedAt: r.updatedAt.toISOString() }));
}

/** Slug for a seller business (worker handlers). */
export async function storefrontSlugForBusiness(sellerBusinessId: string): Promise<string | null> {
  const r = await prisma.storefront.findUnique({ where: { sellerBusinessId }, select: { slug: true } });
  return r?.slug ?? null;
}

export async function storefrontSlugById(id: string): Promise<string | null> {
  const r = await prisma.storefront.findUnique({ where: { id }, select: { slug: true } });
  return r?.slug ?? null;
}

// Editorial promotions (ADR-025 (1)): admin-curated banners, collections and strips. NEVER sold: this file has no import from
// billing and no price, wallet or seller-paid input (firewall with @cnote/ads). Maker-checker: approvedBy must differ from createdBy.
import { cachedTagged, DomainError, emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { getTrustProfiles } from "@cnote/identity";
import { isValidMediaKey, getPublicMediaStore } from "@cnote/media";
import { z } from "zod";
import { DAY_MS, promotionsEnabled } from "./config";
import { getListingFacts } from "./ports";
import { bustPromotions, promoTags } from "./tags";

export const PROMOTION_KINDS = ["hero_banner", "collection", "category_spotlight", "announcement_strip"] as const;
export const PROMOTION_SURFACES = ["home_hero", "home_strip", "home_category_tile", "home_panel", "category_top"] as const;
export const PROMOTION_STATUSES = ["draft", "in_review", "approved", "archived"] as const;
export type PromotionKindName = (typeof PROMOTION_KINDS)[number];
export type PromotionSurfaceName = (typeof PROMOTION_SURFACES)[number];
export type PromotionStatusName = (typeof PROMOTION_STATUSES)[number];
export const AUDIENCE_SEGMENTS = ["all", "signed_in", "buyers", "sellers"] as const;

/** Code-defined layouts. Staff own words and images; they cannot break the layout or the mobile/3G budget. */
export const PROMOTION_TEMPLATES: Record<PromotionKindName, readonly string[]> = {
  hero_banner: ["hero_split", "hero_full_bleed"],
  collection: ["collection_rail"],
  category_spotlight: ["category_spotlight"],
  announcement_strip: ["strip"],
};
export const MAX_PROMOTION_DAYS = 180;
export const MAX_ITEMS = 24;

/** Locales editors may write content for. English is mandatory and is the fallback for every other locale. */
export const CONTENT_LOCALES = ["en", "hi", "bn", "gu", "kn", "mr", "ta", "te"] as const;

const allowedHosts = () => (process.env.PROMOTIONS_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);

/** Relative paths only (or hosts explicitly allow-listed): a banner can never send buyers to an arbitrary site. */
export function isSafeHref(href: string): boolean {
  if (/^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#[\]]*$/.test(href) && !href.includes("\\")) return true;
  try {
    const u = new URL(href);
    return u.protocol === "https:" && allowedHosts().includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const isImageRef = (k: string) => /^\/media\/template-assets\/[0-9a-f-]{36}$/i.test(k) || isValidMediaKey(k, "public");

export function imageUrl(imageKey: string | null): string | null {
  if (!imageKey) return null;
  if (imageKey.startsWith("/media/")) return imageKey;
  return getPublicMediaStore().publicUrl(imageKey) ?? `/media/v/${imageKey}`;
}

const text = (max: number) => z.string().trim().min(1).max(max);
const contentSchema = z
  .object({
    locale: z.enum(CONTENT_LOCALES),
    headline: text(120),
    subline: z.string().trim().max(240).nullish(),
    ctaLabel: z.string().trim().max(40).nullish(),
    ctaHref: z.string().trim().max(300).nullish(),
    imageKey: z.string().trim().max(300).nullish(),
    altText: z.string().trim().max(300).nullish(),
  })
  .superRefine((c, ctx) => {
    if (c.ctaHref && !isSafeHref(c.ctaHref)) ctx.addIssue({ code: "custom", path: ["ctaHref"], message: "Use a relative link such as /categories/kraft-boxes" });
    if (c.ctaHref && !c.ctaLabel) ctx.addIssue({ code: "custom", path: ["ctaLabel"], message: "A link needs a button label" });
    if (c.imageKey && !isImageRef(c.imageKey)) ctx.addIssue({ code: "custom", path: ["imageKey"], message: "Upload the image through the console first" });
    if (c.imageKey && !c.altText) ctx.addIssue({ code: "custom", path: ["altText"], message: "Alt text is required for every image" });
  });

const itemSchema = z
  .object({ listingId: z.uuid().nullish(), categoryId: z.uuid().nullish(), businessId: z.uuid().nullish(), editorNote: text(300) })
  .refine((i) => [i.listingId, i.categoryId, i.businessId].filter(Boolean).length === 1, { message: "Each pick targets exactly one listing, category or business" });

export const audienceSchema = z.object({
  segment: z.enum(AUDIENCE_SEGMENTS).default("all"),
  states: z.array(z.string().trim().min(2).max(60)).max(40).optional(),
  languages: z.array(z.enum(CONTENT_LOCALES)).max(8).optional(),
});

export const promotionInputSchema = z
  .object({
    kind: z.enum(PROMOTION_KINDS),
    template: z.string().trim().min(1).max(40),
    internalName: text(120),
    surfaces: z.array(z.enum(PROMOTION_SURFACES)).min(1).max(5),
    priority: z.number().int().min(0).max(1000).default(0),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    audience: audienceSchema.default({ segment: "all" }),
    contents: z.array(contentSchema).min(1).max(CONTENT_LOCALES.length),
    items: z.array(itemSchema).max(MAX_ITEMS).default([]),
  })
  .superRefine((p, ctx) => {
    if (!PROMOTION_TEMPLATES[p.kind].includes(p.template)) ctx.addIssue({ code: "custom", path: ["template"], message: `Template must be one of: ${PROMOTION_TEMPLATES[p.kind].join(", ")}` });
    if (p.endsAt <= p.startsAt) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End must be after start" });
    if (p.endsAt.getTime() - p.startsAt.getTime() > MAX_PROMOTION_DAYS * DAY_MS) ctx.addIssue({ code: "custom", path: ["endsAt"], message: `A promotion runs for at most ${MAX_PROMOTION_DAYS} days` });
    if (!p.contents.some((c) => c.locale === "en")) ctx.addIssue({ code: "custom", path: ["contents"], message: "English content is required (it is the fallback for every language)" });
    if (new Set(p.contents.map((c) => c.locale)).size !== p.contents.length) ctx.addIssue({ code: "custom", path: ["contents"], message: "One content block per language" });
  });
export type PromotionInput = z.input<typeof promotionInputSchema>;

export interface PromotionView {
  id: string;
  kind: PromotionKindName;
  template: string;
  internalName: string;
  status: PromotionStatusName;
  surfaces: PromotionSurfaceName[];
  priority: number;
  startsAt: string;
  endsAt: string;
  audience: z.infer<typeof audienceSchema>;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  archivedReason: string | null;
  createdAt: string;
  updatedAt: string;
  contents: { locale: string; headline: string; subline: string | null; ctaLabel: string | null; ctaHref: string | null; imageKey: string | null; altText: string | null }[];
  items: { id: string; position: number; listingId: string | null; categoryId: string | null; businessId: string | null; editorNote: string | null }[];
}

type Row = NonNullable<Awaited<ReturnType<typeof loadRow>>>;
const loadRow = (id: string) => prisma.promotion.findUnique({ where: { id }, include: { contents: { orderBy: { locale: "asc" } }, items: { orderBy: { position: "asc" } } } });
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function toView(r: Row): PromotionView {
  return {
    id: r.id,
    kind: r.kind,
    template: r.template,
    internalName: r.internalName,
    status: r.status,
    surfaces: r.surfaces,
    priority: r.priority,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    audience: audienceSchema.parse(r.audience ?? {}),
    createdBy: r.createdBy,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    archivedReason: r.archivedReason,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    contents: r.contents.map((c) => ({ locale: c.locale, headline: c.headline, subline: c.subline, ctaLabel: c.ctaLabel, ctaHref: c.ctaHref, imageKey: c.imageKey, altText: c.altText })),
    items: r.items.map((i) => ({ id: i.id, position: i.position, listingId: i.listingId, categoryId: i.categoryId, businessId: i.businessId, editorNote: i.editorNote })),
  };
}

function parse(input: PromotionInput) {
  const r = promotionInputSchema.safeParse(input);
  if (!r.success) throw new DomainError("validation", r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), r.error.issues);
  return r.data;
}

const contentRows = (contents: z.infer<typeof promotionInputSchema>["contents"]) =>
  contents.map((c) => ({ locale: c.locale, headline: c.headline, subline: c.subline ?? null, ctaLabel: c.ctaLabel ?? null, ctaHref: c.ctaHref ?? null, imageKey: c.imageKey ?? null, altText: c.altText ?? null }));
const itemRows = (items: z.infer<typeof promotionInputSchema>["items"]) =>
  items.map((i, position) => ({ position, listingId: i.listingId ?? null, categoryId: i.categoryId ?? null, businessId: i.businessId ?? null, editorNote: i.editorNote }));

export async function createPromotion(input: PromotionInput, staffId: string): Promise<PromotionView> {
  const d = parse(input);
  const row = await prisma.promotion.create({
    data: {
      kind: d.kind, template: d.template, internalName: d.internalName, surfaces: d.surfaces, priority: d.priority, startsAt: d.startsAt, endsAt: d.endsAt,
      audience: d.audience, createdBy: staffId,
      contents: { create: contentRows(d.contents) },
      items: { create: itemRows(d.items) },
    },
    include: { contents: { orderBy: { locale: "asc" } }, items: { orderBy: { position: "asc" } } },
  });
  return toView(row);
}

/** Editing is allowed while draft or in review (an edit sends it back to draft so the reviewer never approves what they did not see). */
export async function updatePromotion(id: string, input: PromotionInput, staffId: string): Promise<PromotionView> {
  const d = parse(input);
  const cur = await requirePromotion(id);
  if (cur.status === "approved" || cur.status === "archived") throw new DomainError("conflict", "A live or archived promotion cannot be edited. Archive it and create a new one.", undefined, "promotions.liveArchivedPromotionEditedArchive");
  const row = await prisma.$transaction(async (tx) => {
    await tx.promotionContent.deleteMany({ where: { promotionId: id } });
    await tx.promotionItem.deleteMany({ where: { promotionId: id } });
    return tx.promotion.update({
      where: { id },
      data: {
        kind: d.kind, template: d.template, internalName: d.internalName, surfaces: d.surfaces, priority: d.priority, startsAt: d.startsAt, endsAt: d.endsAt, audience: d.audience, status: "draft",
        // the editor becomes the author: they cannot then approve their own edit
        createdBy: staffId,
        contents: { create: contentRows(d.contents) },
        items: { create: itemRows(d.items) },
      },
      include: { contents: { orderBy: { locale: "asc" } }, items: { orderBy: { position: "asc" } } },
    });
  });
  return toView(row);
}

async function requirePromotion(id: string): Promise<Row> {
  const row = isUuid(id) ? await loadRow(id) : null;
  if (!row) throw new DomainError("not_found", "Promotion not found", undefined, "promotions.promotionNotFound");
  return row;
}

export async function getPromotion(id: string): Promise<PromotionView | null> {
  const row = isUuid(id) ? await loadRow(id) : null;
  return row ? toView(row) : null;
}

export async function listPromotions(opts: { status?: PromotionStatusName; limit?: number } = {}): Promise<PromotionView[]> {
  const rows = await prisma.promotion.findMany({
    where: opts.status ? { status: opts.status } : {},
    orderBy: [{ updatedAt: "desc" }],
    take: Math.min(opts.limit ?? 100, 200),
    include: { contents: { orderBy: { locale: "asc" } }, items: { orderBy: { position: "asc" } } },
  });
  return rows.map(toView);
}

export async function submitPromotion(id: string, staffId: string): Promise<PromotionView> {
  const cur = await requirePromotion(id);
  if (cur.status !== "draft") throw new DomainError("conflict", "Only a draft can be submitted for review", undefined, "promotions.onlyDraftSubmittedReview");
  if (cur.kind === "collection" && cur.items.length === 0) throw new DomainError("validation", "A collection needs at least one item", undefined, "promotions.collectionNeedsLeastOneItem");
  if (cur.endsAt <= new Date()) throw new DomainError("validation", "The end date has already passed", undefined, "promotions.endDateAlreadyPassed");
  if (cur.createdBy !== staffId) throw new DomainError("forbidden", "Only the author can submit their draft", undefined, "promotions.onlyAuthorSubmitTheirDraft");
  const n = await prisma.promotion.updateMany({ where: { id, status: "draft" }, data: { status: "in_review" } });
  if (n.count === 0) throw new DomainError("conflict", "Promotion changed; reload and try again", undefined, "promotions.promotionChangedReloadTryAgain");
  return (await getPromotion(id))!;
}

/** Sends a submitted promotion back to the author with the reviewer's reason kept in the audit log (the caller wraps this in audited()). */
export async function returnPromotionToDraft(id: string, reviewerId: string): Promise<PromotionView> {
  const cur = await requirePromotion(id);
  if (cur.status !== "in_review") throw new DomainError("conflict", "Only a promotion in review can be returned", undefined, "promotions.onlyPromotionReviewReturned");
  if (cur.createdBy === reviewerId) throw new DomainError("forbidden", "Use edit to change your own draft", undefined, "promotions.useEditChangeOwnDraft");
  await prisma.promotion.updateMany({ where: { id, status: "in_review" }, data: { status: "draft" } });
  return (await getPromotion(id))!;
}

/** Two-person rule: approvedBy must differ from createdBy. Enforced here (not only by privilege) so no caller can bypass it. */
export async function approvePromotion(id: string, approverId: string): Promise<PromotionView> {
  const cur = await requirePromotion(id);
  if (cur.status !== "in_review") throw new DomainError("conflict", "Only a promotion in review can be approved", undefined, "promotions.onlyPromotionReviewApproved");
  if (cur.createdBy === approverId) throw new DomainError("forbidden", "A different staff member must approve this promotion (two-person rule)");
  if (cur.endsAt <= new Date()) throw new DomainError("validation", "The end date has already passed", undefined, "promotions.endDateAlreadyPassed");
  await prisma.$transaction(async (tx) => {
    const n = await tx.promotion.updateMany({ where: { id, status: "in_review" }, data: { status: "approved", approvedBy: approverId, approvedAt: new Date() } });
    if (n.count === 0) throw new DomainError("conflict", "Promotion changed; reload and try again", undefined, "promotions.promotionChangedReloadTryAgain");
    await emit(tx, "PromotionPublished", { type: "promotion", id }, {
      promotionId: id, kind: cur.kind, surfaces: cur.surfaces, startsAt: cur.startsAt.toISOString(), endsAt: cur.endsAt.toISOString(), createdBy: cur.createdBy, approvedBy: approverId,
    });
  });
  await bustPromotions(cur.surfaces);
  return (await getPromotion(id))!;
}

/** Pulls a promotion at once (kill switch for a bad banner). Anyone with promotions.publish may do it, including the author. */
export async function archivePromotion(id: string, staffId: string, reason: string): Promise<PromotionView> {
  const why = reason.trim();
  if (!why) throw new DomainError("validation", "A reason is required");
  const cur = await requirePromotion(id);
  if (cur.status === "archived") return toView(cur);
  await prisma.$transaction(async (tx) => {
    await tx.promotion.update({ where: { id }, data: { status: "archived", archivedReason: why.slice(0, 300) } });
    await emit(tx, "PromotionArchived", { type: "promotion", id }, { promotionId: id, reason: why.slice(0, 300), archivedBy: staffId });
  });
  await bustPromotions(cur.surfaces);
  return (await getPromotion(id))!;
}

// ------------------------------------------------------------------------------------------------ public reads

export interface PublicPromotion {
  id: string;
  kind: PromotionKindName;
  template: string;
  surface: PromotionSurfaceName;
  priority: number;
  headline: string;
  subline: string | null;
  cta: { label: string; href: string } | null;
  image: { src: string; alt: string } | null;
  /** Listing picks that still pass standard eligibility at render time (published, approved, seller tier >= 1), in editor order. */
  listingIds: string[];
  categoryIds: string[];
  businessIds: string[];
  startsAt: string;
  endsAt: string;
}

export interface ActiveQuery {
  surface: PromotionSurfaceName;
  locale: string;
  /** Static pages only ever ask for "all"; targeted segments are for signed-in surfaces. */
  segment?: (typeof AUDIENCE_SEGMENTS)[number];
  state?: string;
}

function localise(r: Row, locale: string) {
  return r.contents.find((c) => c.locale === locale) ?? r.contents.find((c) => c.locale === "en") ?? null;
}

export function audienceMatches(audienceJson: unknown, q: { locale: string; segment: string; state?: string }): boolean {
  const a = audienceSchema.safeParse(audienceJson ?? {});
  if (!a.success) return false;
  const { segment, states, languages } = a.data;
  if (segment !== "all" && segment !== q.segment) return false;
  if (languages?.length && !languages.includes(q.locale as never)) return false;
  if (states?.length && (!q.state || !states.map((s) => s.toLowerCase()).includes(q.state.toLowerCase()))) return false;
  return true;
}

async function eligibleListingIds(ids: string[]): Promise<Set<string>> {
  const ok = new Set<string>();
  const listings = (await Promise.all(ids.map((id) => getListingFacts(id).catch(() => null)))).map((l) => (l?.published ? l : null));
  const sellers = [...new Set(listings.flatMap((l) => (l ? [l.sellerBusinessId] : [])))];
  const profiles = await getTrustProfiles(sellers);
  for (const l of listings) if (l && (profiles.get(l.sellerBusinessId)?.verificationTier ?? 0) >= 1) ok.add(l.id);
  return ok;
}

async function render(rows: Row[], q: ActiveQuery): Promise<PublicPromotion[]> {
  const all = rows.flatMap((r) => r.items.flatMap((i) => (i.listingId ? [i.listingId] : [])));
  const eligible = all.length ? await eligibleListingIds([...new Set(all)]) : new Set<string>();
  const out: PublicPromotion[] = [];
  for (const r of rows) {
    const c = localise(r, q.locale);
    if (!c) continue;
    const src = imageUrl(c.imageKey);
    const listingIds = r.items.flatMap((i) => (i.listingId && eligible.has(i.listingId) ? [i.listingId] : []));
    // a collection whose every pick has become ineligible is not shown (an empty rail is worse than none)
    if (r.kind === "collection" && listingIds.length === 0 && r.items.every((i) => i.listingId)) continue;
    out.push({
      id: r.id, kind: r.kind, template: r.template, surface: q.surface, priority: r.priority,
      headline: c.headline, subline: c.subline,
      cta: c.ctaHref && c.ctaLabel ? { label: c.ctaLabel, href: c.ctaHref } : null,
      image: src && c.altText ? { src, alt: c.altText } : null,
      listingIds,
      categoryIds: r.items.flatMap((i) => (i.categoryId ? [i.categoryId] : [])),
      businessIds: r.items.flatMap((i) => (i.businessId ? [i.businessId] : [])),
      startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString(),
    });
  }
  return out;
}

async function loadActive(q: ActiveQuery, now: Date): Promise<PublicPromotion[]> {
  const rows = await prisma.promotion.findMany({
    where: { status: "approved", startsAt: { lte: now }, endsAt: { gt: now }, surfaces: { has: q.surface } },
    orderBy: [{ priority: "desc" }, { startsAt: "desc" }],
    include: { contents: true, items: { orderBy: { position: "asc" } } },
    take: 20,
  });
  const matching = rows.filter((r) => audienceMatches(r.audience, { locale: q.locale, segment: q.segment ?? "all", state: q.state }));
  return render(matching, q);
}

/**
 * Public read for a surface. Redis-cached 60s and tag-invalidated: approve/archive hard-purge `promotions` and the surface tag
 * (Redis and the web tier), so a pulled banner disappears immediately. Window edges (start/end) are honoured within the 60s TTL.
 */
export async function getActivePromotions(q: ActiveQuery): Promise<PublicPromotion[]> {
  if (!promotionsEnabled()) return [];
  const segment = q.segment ?? "all";
  const state = q.state?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  const key = `promo:active:v1:${q.surface}:${q.locale}:${segment}:${state}`;
  return cachedTagged(key, [promoTags.all, promoTags.surface(q.surface)], 60, () => loadActive(q, new Date()));
}

/** Staff preview: renders any promotion (any status) exactly as readers would see it in `locale`, without the time window. */
export async function previewPromotion(id: string, locale: string): Promise<PublicPromotion[]> {
  const row = await requirePromotion(id);
  return render([row], { surface: row.surfaces[0] ?? "home_hero", locale });
}

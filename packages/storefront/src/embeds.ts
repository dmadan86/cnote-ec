// Moderation of third-party video embeds (ADR-003: all seller content is moderated; ADR-008: AI decisions are logged and
// low confidence goes to a human). A seller can only embed a video from a closed list of providers (YouTube, Vimeo). The platform
//  1. fetches the provider's public oEmbed metadata SERVER-SIDE through assertPublicHttpTarget + pinnedFetch (the seller never
//     supplies a URL, and the visitor's browser never talks to the provider before consent),
//  2. runs title, channel, description and thumbnail reference through ai.moderate (deterministic prohibited-content pre-check,
//     then the model; the model can escalate but never relax the pre-check),
//  3. holds the embed in `pending` until it is approved. Auto-approval follows the SAME strictness rules as listings
//     (catalogue.mayAutoApprove: deterministic-clean AND model allow AND tier/trust AND account age AND staff-approved history),
//     and a random sample of would-be auto-approvals (LISTING_AUTO_APPROVE_SAMPLE_RATE) is held for staff as an audit instead.
//     Everything else waits in the ops queue (admin: Storefront embeds). A `block` verdict rejects outright.
// The renderer shows a video only while its review is `approved`. Approved embeds are re-checked periodically.
import * as ai from "@cnote/ai";
import { autoApprovePolicy, mayAutoApprove } from "@cnote/catalogue";
import { DomainError, emit } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { getTrustProfiles } from "@cnote/identity";
import { assertPublicHttpTarget, pinnedFetch } from "@cnote/security";
import { z } from "zod";
import { purgeStorefront } from "./cache";
import { documentRemoteEmbeds, embedKey, type RemoteEmbedRef } from "./document/embed";
import type { StorefrontDocument } from "./document";

export type EmbedStatus = "pending" | "approved" | "rejected";
export type EmbedDecider = "auto" | "staff" | "recheck";

export interface OembedMeta {
  title: string;
  authorName: string | null;
  description: string | null;
  /** only ever a URL on the provider's own image host; otherwise null */
  thumbnailUrl: string | null;
}

/** The provider could not give us metadata. `permanent` = the video is gone/private (404, 401, 403): do not keep retrying blindly. */
export class EmbedFetchError extends Error {
  constructor(message: string, readonly permanent: boolean) {
    super(message);
    this.name = "EmbedFetchError";
  }
}

// ---------------------------------------------------------------------------------------------
// oEmbed (server-side, SSRF-safe)
// ---------------------------------------------------------------------------------------------

/** oEmbed endpoint for a reference. Built by us from the validated id; the host is fixed per provider. */
export function oembedUrl(ref: RemoteEmbedRef): string {
  if (ref.provider === "youtube") return `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ref.mediaId}`)}`;
  return `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${ref.mediaId}`)}`;
}

/** Image hosts a provider's thumbnail may come from. Anything else is dropped (and the embed goes to a human). */
const THUMB_HOSTS: Record<RemoteEmbedRef["provider"], RegExp> = {
  youtube: /^(?:i\d?|img)\.ytimg\.com$/,
  vimeo: /^i\.vimeocdn\.com$/,
};

const Oembed = z.object({
  title: z.string().max(2000),
  author_name: z.string().max(500).nullish(),
  description: z.string().max(10_000).nullish(),
  thumbnail_url: z.string().max(2000).nullish(),
});

export function parseOembed(provider: RemoteEmbedRef["provider"], json: unknown): OembedMeta {
  const o = Oembed.parse(json);
  let thumbnailUrl: string | null = null;
  if (o.thumbnail_url) {
    try {
      const u = new URL(o.thumbnail_url);
      if (u.protocol === "https:" && THUMB_HOSTS[provider].test(u.hostname)) thumbnailUrl = u.toString();
    } catch {
      /* unparseable thumbnail: dropped */
    }
  }
  return { title: o.title.trim(), authorName: o.author_name?.trim() || null, description: o.description?.trim() || null, thumbnailUrl };
}

export type OembedFetcher = (ref: RemoteEmbedRef) => Promise<OembedMeta>;

/** Default: assertPublicHttpTarget (https, public address) then a DNS-pinned fetch that never follows redirects. */
export const fetchOembed: OembedFetcher = async (ref) => {
  let res: Response;
  try {
    const target = await assertPublicHttpTarget(oembedUrl(ref));
    res = await pinnedFetch(target, { headers: { accept: "application/json", "user-agent": "cnote-embed-check/1.0" }, timeoutMs: 8000 });
  } catch (err) {
    throw new EmbedFetchError(err instanceof Error ? err.message : String(err), false);
  }
  if ([401, 403, 404, 410].includes(res.status)) throw new EmbedFetchError(`The video is not available (${res.status}).`, true);
  if (!res.ok) throw new EmbedFetchError(`The provider answered ${res.status}.`, false);
  try {
    return parseOembed(ref.provider, await res.json());
  } catch {
    throw new EmbedFetchError("The provider's answer could not be read.", false);
  }
};

let fetcher: OembedFetcher = fetchOembed;
/** Test hook: replace the oEmbed client (undefined restores the default). */
export function setOembedFetcherForTests(f: OembedFetcher | undefined): void {
  fetcher = f ?? fetchOembed;
}

// ---------------------------------------------------------------------------------------------
// Screening + decision
// ---------------------------------------------------------------------------------------------

type Screening = { outcome: "allow" | "review" | "block"; deterministic?: string; verdict: string; decisionId: string | null; reason: string | null };

/** Everything a visitor would see around the video, as one text. The thumbnail contributes its provider-side file reference. */
export function screeningText(ref: RemoteEmbedRef, m: OembedMeta): string {
  const thumb = m.thumbnailUrl ? new URL(m.thumbnailUrl).pathname.split("/").filter(Boolean).slice(-2).join(" / ") : "none (not from the provider's image host)";
  return [`Embedded ${ref.provider} video`, `Title: ${m.title}`, m.authorName ? `Channel: ${m.authorName}` : "", m.description ? `Description: ${m.description.slice(0, 3000)}` : "", `Thumbnail: ${thumb}`].filter(Boolean).join("\n");
}

async function screen(sellerBusinessId: string, ref: RemoteEmbedRef, m: OembedMeta): Promise<Screening> {
  // A thumbnail from an unexpected host is itself suspicious: never auto-approve it.
  const odd = m.thumbnailUrl === null;
  try {
    const r = await ai.moderate({ text: screeningText(ref, m) }, { type: "business", id: sellerBusinessId });
    const review = r.verdict === "review" || r.needsReview || odd;
    const outcome = r.verdict === "block" ? "block" : review ? "review" : "allow";
    const reason = r.verdict === "block" || review ? (r.reason ?? (odd ? "Thumbnail did not come from the provider's image host" : "Flagged for manual review")) : null;
    return { outcome, ...(r.deterministic ? { deterministic: r.deterministic } : {}), verdict: (outcome === "allow" ? "allow" : `${outcome}: ${reason ?? ""}`).slice(0, 300), decisionId: r.decisionId, reason };
  } catch (err) {
    // fail closed: if screening is unavailable a human decides; nothing auto-approves unscreened
    console.error("[storefront] embed moderation failed:", err instanceof Error ? err.message : err);
    return { outcome: "review", verdict: "review: automated screening was unavailable", decisionId: null, reason: "Automated screening was unavailable." };
  }
}

const recheckDays = () => {
  const n = Number(process.env.STOREFRONT_EMBED_RECHECK_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 7;
};
const DAY = 86_400_000;

async function mayAutoApproveEmbed(sellerBusinessId: string, s: Screening): Promise<boolean> {
  const trust = (await getTrustProfiles([sellerBusinessId])).get(sellerBusinessId);
  const policy = autoApprovePolicy();
  // staff-approved history counts only when the cheap gates pass (saves queries for new sellers)
  const cheap = s.outcome === "allow" && s.deterministic === "clean" && trust;
  const humanApproved = cheap
    ? (await prisma.storefrontVersion.count({ where: { storefront: { sellerBusinessId }, reviewedBy: { not: null }, status: { in: ["published", "archived"] } } })) +
      (await prisma.storefrontEmbedReview.count({ where: { storefront: { sellerBusinessId }, decidedBy: "staff", status: "approved" } }))
    : 0;
  if (!mayAutoApprove(s, trust, humanApproved, new Date(), policy)) return false;
  // sampled audit: a share of would-be auto-approvals waits for staff instead (a stricter twin of the listing post-publication audit)
  return Math.random() >= policy.sampleRate;
}

interface Row { id: string; storefrontId: string; provider: string; mediaId: string; status: EmbedStatus }

async function writeDecision(
  row: Row, sellerBusinessId: string, data: Prisma.StorefrontEmbedReviewUncheckedUpdateInput, status: EmbedStatus, by: EmbedDecider, slug: string | null,
): Promise<void> {
  const changed = row.status !== status;
  await prisma.$transaction(async (tx) => {
    await tx.storefrontEmbedReview.update({ where: { id: row.id }, data: { ...data, status } });
    if (changed) {
      await emit(tx, "StorefrontEmbedDecided", { type: "Storefront", id: row.storefrontId }, {
        storefrontId: row.storefrontId, sellerBusinessId, provider: row.provider as "youtube" | "vimeo", mediaId: row.mediaId, status, decidedBy: by,
      });
    }
  });
  if (changed && slug) await purgeStorefront([slug], true).catch(() => undefined);
}

/**
 * Fetches metadata, screens it and records the decision for one review row. A fetch failure leaves (or puts) the embed in `pending`
 * with the error, so a human or a retry decides; it is never approved without metadata.
 */
async function evaluate(row: Row, sellerBusinessId: string, slug: string | null, by: "auto" | "recheck"): Promise<EmbedStatus> {
  const ref: RemoteEmbedRef = { provider: row.provider as RemoteEmbedRef["provider"], mediaId: row.mediaId };
  const now = new Date();
  let meta: OembedMeta;
  try {
    meta = await fetcher(ref);
  } catch (err) {
    const e = err instanceof EmbedFetchError ? err : new EmbedFetchError(err instanceof Error ? err.message : String(err), false);
    // A transient failure of an APPROVED embed (provider outage) does not hide it; a permanent one (removed/private) does.
    const hide = row.status !== "approved" || e.permanent;
    const status: EmbedStatus = hide ? "pending" : "approved";
    await writeDecision(row, sellerBusinessId, { fetchError: e.message.slice(0, 300), checkedAt: now, nextCheckAt: new Date(now.getTime() + DAY) }, status, by, slug);
    return status;
  }
  const s = await screen(sellerBusinessId, ref, meta);
  const base: Prisma.StorefrontEmbedReviewUncheckedUpdateInput = {
    title: meta.title.slice(0, 500), authorName: meta.authorName?.slice(0, 200) ?? null, description: meta.description?.slice(0, 2000) ?? null, thumbnailUrl: meta.thumbnailUrl,
    aiVerdict: s.verdict, aiDecisionId: s.decisionId, fetchError: null, checkedAt: now,
  };
  if (s.outcome === "block") {
    await writeDecision(row, sellerBusinessId, { ...base, decidedBy: by === "auto" ? "auto" : "recheck", reviewNote: (s.reason ?? "Blocked by moderation").slice(0, 500), nextCheckAt: null }, "rejected", by, slug);
    return "rejected";
  }
  if (row.status === "approved" && by === "recheck") {
    // already approved by a human or the auto-approver: keep it unless the content now needs a second look
    if (s.outcome === "allow") {
      await writeDecision(row, sellerBusinessId, { ...base, nextCheckAt: new Date(now.getTime() + recheckDays() * DAY) }, "approved", by, slug);
      return "approved";
    }
    await writeDecision(row, sellerBusinessId, { ...base, decidedBy: null, reviewNote: "Changed after approval; needs a new check.", nextCheckAt: null }, "pending", by, slug);
    return "pending";
  }
  if (await mayAutoApproveEmbed(sellerBusinessId, s)) {
    await writeDecision(row, sellerBusinessId, { ...base, decidedBy: "auto", reviewNote: "Auto-approved (trusted seller, clean screening).", reviewedAt: now, nextCheckAt: new Date(now.getTime() + recheckDays() * DAY) }, "approved", by, slug);
    return "approved";
  }
  await writeDecision(row, sellerBusinessId, { ...base, nextCheckAt: null }, "pending", by, slug);
  return "pending";
}

/**
 * Called at publish: makes sure every remote video in the document has a review row (creating and evaluating new ones),
 * and reports which are not approved yet. Existing rows are never re-evaluated here (staff decisions stand).
 */
export async function ensureEmbedReviews(storefront: { id: string; slug: string; sellerBusinessId: string }, doc: StorefrontDocument): Promise<{ held: RemoteEmbedRef[]; approved: RemoteEmbedRef[] }> {
  const refs = documentRemoteEmbeds(doc);
  const held: RemoteEmbedRef[] = [];
  const approved: RemoteEmbedRef[] = [];
  for (const ref of refs) {
    let row = await prisma.storefrontEmbedReview.findUnique({ where: { storefrontId_provider_mediaId: { storefrontId: storefront.id, provider: ref.provider, mediaId: ref.mediaId } } });
    let status = row?.status as EmbedStatus | undefined;
    if (!row) {
      try {
        row = await prisma.storefrontEmbedReview.create({ data: { storefrontId: storefront.id, provider: ref.provider, mediaId: ref.mediaId } });
      } catch (e) {
        if ((e as { code?: string }).code !== "P2002") throw e; // a concurrent publish created it first
        row = await prisma.storefrontEmbedReview.findUniqueOrThrow({ where: { storefrontId_provider_mediaId: { storefrontId: storefront.id, provider: ref.provider, mediaId: ref.mediaId } } });
      }
      status = row.status as EmbedStatus;
      if (status === "pending") status = await evaluate(row as Row, storefront.sellerBusinessId, storefront.slug, "auto");
    }
    (status === "approved" ? approved : held).push(ref);
  }
  return { held, approved };
}

/** Keys of the seller's approved embeds, for the renderer. */
export async function approvedEmbedKeys(sellerBusinessId: string): Promise<string[]> {
  const rows = await prisma.storefrontEmbedReview.findMany({ where: { status: "approved", storefront: { sellerBusinessId } }, select: { provider: true, mediaId: true } });
  return rows.map((r) => embedKey({ provider: r.provider as RemoteEmbedRef["provider"], mediaId: r.mediaId }));
}

// ---------------------------------------------------------------------------------------------
// Ops queue
// ---------------------------------------------------------------------------------------------

export interface EmbedReviewItem {
  id: string;
  storefrontId: string;
  slug: string;
  sellerBusinessId: string;
  businessName: string;
  provider: string;
  mediaId: string;
  /** link to the video on the provider's site, for the reviewer */
  href: string;
  status: EmbedStatus;
  title: string | null;
  authorName: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  aiVerdict: string | null;
  fetchError: string | null;
  decidedBy: string | null;
  reviewNote: string | null;
  createdAt: string;
}

const hrefOf = (provider: string, id: string) => (provider === "vimeo" ? `https://vimeo.com/${id}` : `https://www.youtube.com/watch?v=${id}`);

export async function listEmbedReviews(opts: { status?: EmbedStatus; limit?: number } = {}): Promise<EmbedReviewItem[]> {
  const rows = await prisma.storefrontEmbedReview.findMany({
    where: { status: opts.status ?? "pending" }, include: { storefront: true }, orderBy: { createdAt: "asc" }, take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  });
  const names = await getTrustProfiles([...new Set(rows.map((r) => r.storefront.sellerBusinessId))]);
  return rows.map((r) => ({
    id: r.id, storefrontId: r.storefrontId, slug: r.storefront.slug, sellerBusinessId: r.storefront.sellerBusinessId,
    businessName: names.get(r.storefront.sellerBusinessId)?.name ?? "Unknown business", provider: r.provider, mediaId: r.mediaId, href: hrefOf(r.provider, r.mediaId),
    status: r.status as EmbedStatus, title: r.title, authorName: r.authorName, description: r.description, thumbnailUrl: r.thumbnailUrl, aiVerdict: r.aiVerdict,
    fetchError: r.fetchError, decidedBy: r.decidedBy, reviewNote: r.reviewNote, createdAt: r.createdAt.toISOString(),
  }));
}

/** Staff decision. Call inside admin.audited(ctx, "storefronts.review", …). A rejection needs a note (shown to the seller in Studio). */
export async function reviewEmbed(id: string, staffId: string, outcome: "approved" | "rejected", note?: string): Promise<EmbedReviewItem> {
  if (outcome === "rejected" && !note?.trim()) throw new DomainError("validation", "Tell the seller why this video was rejected.", { field: "note" });
  const row = await prisma.storefrontEmbedReview.findUnique({ where: { id }, include: { storefront: true } });
  if (!row) throw new DomainError("not_found", "Embed review not found.");
  const now = new Date();
  await writeDecision(
    row as unknown as Row, row.storefront.sellerBusinessId,
    { decidedBy: "staff", reviewedBy: staffId, reviewedAt: now, reviewNote: note?.trim().slice(0, 500) || null, nextCheckAt: outcome === "approved" ? new Date(now.getTime() + recheckDays() * DAY) : null },
    outcome, "staff", row.storefront.slug,
  );
  return (await listEmbedReviews({ status: outcome, limit: 200 })).find((r) => r.id === id)!;
}

/** What a seller can see about their own videos (Studio): state and the reviewer's note, nothing about other sellers. */
export async function embedStatusesForSeller(sellerBusinessId: string): Promise<{ key: string; status: EmbedStatus; note: string | null }[]> {
  const rows = await prisma.storefrontEmbedReview.findMany({ where: { storefront: { sellerBusinessId } }, select: { provider: true, mediaId: true, status: true, reviewNote: true, decidedBy: true } });
  return rows.map((r) => ({ key: embedKey({ provider: r.provider as RemoteEmbedRef["provider"], mediaId: r.mediaId }), status: r.status as EmbedStatus, note: r.status === "rejected" || r.decidedBy === "staff" ? r.reviewNote : null }));
}

// ---------------------------------------------------------------------------------------------
// Periodic re-check (worker job)
// ---------------------------------------------------------------------------------------------

/**
 * One tick: (1) retries embeds that are pending only because the oEmbed fetch failed, (2) re-checks approved embeds that are due
 * (the video's title or description can change after approval). A `block` verdict rejects, a changed `review` verdict hides the
 * embed until staff look again, a permanent fetch failure (removed/private) hides it. Bounded per tick.
 */
export async function recheckEmbeds(opts: { now?: Date; limit?: number } = {}): Promise<{ retried: number; rechecked: number }> {
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const retry = await prisma.storefrontEmbedReview.findMany({
    where: { status: "pending", fetchError: { not: null }, OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] }, include: { storefront: true }, orderBy: { checkedAt: "asc" }, take: limit,
  });
  for (const r of retry) await evaluate(r as unknown as Row, r.storefront.sellerBusinessId, r.storefront.slug, "auto").catch((e) => console.error("[storefront] embed retry failed:", e instanceof Error ? e.message : e));
  const due = await prisma.storefrontEmbedReview.findMany({ where: { status: "approved", nextCheckAt: { lte: now } }, include: { storefront: true }, orderBy: { nextCheckAt: "asc" }, take: limit });
  for (const r of due) await evaluate(r as unknown as Row, r.storefront.sellerBusinessId, r.storefront.slug, "recheck").catch((e) => console.error("[storefront] embed recheck failed:", e instanceof Error ? e.message : e));
  return { retried: retry.length, rechecked: due.length };
}

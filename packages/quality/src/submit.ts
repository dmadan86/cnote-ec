// Seller flow (ADR-015): share pre-dispatch photos for an order in an allowlisted category. Advisory only.
import { randomUUID } from "node:crypto";
import { DomainError, getJobQueue, rateLimit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { ImageValidationError, VARIANT_WIDTHS, getMediaStore, processImage, sha256Hex, validateImage } from "@cnote/media";
import { ANALYSE_TOPIC, MAX_CHECKS_PER_ORDER, MAX_PHOTOS_PER_CHECK, SUBMISSIONS_PER_HOUR, SUBMITTABLE_ORDER_STATUSES, VIDEO_MAX_BYTES, VIDEO_MAX_FRAMES, VIDEO_MAX_SECONDS, VIDEO_MIN_FRAMES, qualityChecksEnabled } from "./config";
import { isCategoryAllowed } from "./categories";
import { getOrderContextPort } from "./context";
import { buildChecklist } from "./spec";
import { getCheckView } from "./views";
import type { CheckSource, OrderContext, QualityActor, QualityCheckView, SubmissionContext } from "./types";

declare module "@cnote/core" {
  interface JobTopics { "quality.analyse": { checkId: string } }
}

/** Vision long edge (same as the other photo capabilities). */
const AI_LONG_EDGE = 1568;
const largestWidth = (max: number) => [...VARIANT_WIDTHS].reverse().find((w) => w <= max) ?? VARIANT_WIDTHS[0];

/** Private-bucket key: quality/<checkId>/<mediaId>.jpg (lowercase uuids only; filenames are never used). */
export const qualityMediaKey = (checkId: string, mediaId: string): string => `quality/${checkId.toLowerCase()}/${mediaId.toLowerCase()}.jpg`;

async function evaluate(actor: QualityActor, orderId: string): Promise<{ ctx: SubmissionContext; order: OrderContext | null }> {
  const base: SubmissionContext = { eligible: false, categorySlug: null, checklist: [], maxPhotos: MAX_PHOTOS_PER_CHECK,
    video: { minFrames: VIDEO_MIN_FRAMES, maxFrames: VIDEO_MAX_FRAMES, maxSeconds: VIDEO_MAX_SECONDS, maxBytes: VIDEO_MAX_BYTES }, checksUsed: 0, maxChecks: MAX_CHECKS_PER_ORDER };
  if (!qualityChecksEnabled()) return { ctx: { ...base, reason: "disabled" }, order: null };
  const order = await getOrderContextPort().load(actor, orderId);
  if (!order) return { ctx: { ...base, reason: "not_found" }, order: null };
  if (order.role !== "seller") return { ctx: { ...base, reason: "not_seller" }, order };
  if (!order.categorySlug) return { ctx: { ...base, reason: "no_category" }, order };
  const withCat = { ...base, categorySlug: order.categorySlug };
  if (!(await isCategoryAllowed(order.categorySlug))) return { ctx: { ...withCat, reason: "category_not_enabled" }, order };
  if (!(SUBMITTABLE_ORDER_STATUSES as readonly string[]).includes(order.status)) return { ctx: { ...withCat, reason: "order_status" }, order };
  const checksUsed = await prisma.qualityCheck.count({ where: { orderId: order.orderId } });
  const ctx = { ...withCat, checklist: buildChecklist(order.spec), checksUsed };
  return { ctx: checksUsed >= MAX_CHECKS_PER_ORDER ? { ...ctx, reason: "limit_reached" } : { ...ctx, eligible: true }, order };
}

/** Drives the seller UI: whether to show the panel at all, and the checklist derived from the order. */
export async function getSubmissionContext(actor: QualityActor, orderId: string): Promise<SubmissionContext> {
  return (await evaluate(actor, orderId)).ctx;
}

/**
 * Validates (magic bytes, size, dimensions), strips EXIF/GPS/ICC by re-encoding, stores in the PRIVATE bucket and queues
 * analysis. Nothing about dispatch depends on the outcome.
 */
export async function submitDispatchPhotos(
  actor: QualityActor, orderId: string, files: { bytes: Uint8Array; filename?: string }[], opts: { source?: CheckSource } = {},
): Promise<QualityCheckView> {
  const source: CheckSource = opts.source === "video" ? "video" : "photos";
  const [min, max] = source === "video" ? [VIDEO_MIN_FRAMES, VIDEO_MAX_FRAMES] : [1, MAX_PHOTOS_PER_CHECK];
  if (files.length < min || files.length > max) throw new DomainError("validation", source === "video" ? `A video check needs ${min} to ${max} frames` : `Add ${min} to ${max} photos`);
  const { ctx, order } = await evaluate(actor, orderId);
  if (!ctx.eligible || !order) {
    const msg: Record<string, string> = {
      disabled: "Photo checks are not available", not_found: "Order not found", not_seller: "Only the seller can share dispatch photos",
      no_category: "This order has no category", category_not_enabled: "Photo checks are not available for this product category",
      order_status: "Photos can only be shared before or at dispatch", limit_reached: `You can share photos for at most ${MAX_CHECKS_PER_ORDER} checks per order`,
    };
    throw new DomainError(ctx.reason === "not_found" ? "not_found" : ctx.reason === "not_seller" ? "forbidden" : "conflict", msg[ctx.reason ?? "disabled"]!);
  }

  const prepared: { name: string | null; hash: string; bytes: Uint8Array; width: number; height: number }[] = [];
  for (const f of files) {
    let v;
    try { v = validateImage(f.bytes); } catch (e) {
      throw e instanceof ImageValidationError ? new DomainError("validation", `${f.filename ?? "A photo"}: ${e.message}`) : e;
    }
    const w = largestWidth(Math.min(v.width, Math.floor((AI_LONG_EDGE * v.width) / Math.max(v.width, v.height))));
    // processImage drops EXIF/GPS/ICC and bakes in orientation
    const out = await processImage(f.bytes, { listingId: randomUUID(), imageId: randomUUID() }, { widths: [w], formats: ["jpeg"] });
    const pick = out.variants.find((x) => x.width === w) ?? out.variants[out.variants.length - 1]!;
    if (!prepared.some((p) => p.hash === sha256Hex(pick.data))) prepared.push({ name: f.filename ?? null, hash: sha256Hex(pick.data), bytes: pick.data, width: pick.width, height: pick.height });
  }
  if (!(await rateLimit(`quality-submit:${actor.personId}`, SUBMISSIONS_PER_HOUR, 3600))) throw new DomainError("rate_limited", "Too many submissions. Please try again later.");

  const checkId = randomUUID();
  const store = getMediaStore("private");
  const media = prepared.map((p) => ({ id: randomUUID(), ...p }));
  const keys = media.map((m) => qualityMediaKey(checkId, m.id));
  try {
    await Promise.all(media.map((m, i) => store.put(keys[i]!, m.bytes, "image/jpeg")));
    await prisma.$transaction([
      prisma.qualityCheck.create({
        data: {
          id: checkId, orderId: order.orderId, sellerBusinessId: order.sellerBusinessId, submittedByPersonId: actor.personId,
          categorySlug: order.categorySlug!, source, expectedSpec: JSON.parse(JSON.stringify(order.spec)),
        },
      }),
      prisma.qualityCheckMedia.createMany({
        data: media.map((m, i) => ({ id: m.id, checkId, key: keys[i]!, sha256: m.hash, mimeType: "image/jpeg", width: m.width, height: m.height, bytes: m.bytes.length })),
      }),
    ]);
  } catch (e) {
    await Promise.all(keys.map((k) => store.delete(k).catch(() => undefined)));
    throw e;
  }
  await getJobQueue().enqueue(ANALYSE_TOPIC, { checkId }, { dedupeKey: `analyse:${checkId}`, maxAttempts: 3 });
  return (await getCheckView(checkId))!;
}


import * as ai from "@cnote/ai";
import * as catalogue from "@cnote/catalogue";
import { DomainError, emit, rateLimit } from "@cnote/core";
import { prisma, toVectorLiteral } from "@cnote/db";
import { randomUUID } from "node:crypto";
import * as approvals from "@cnote/approvals";
import { assertCan, consult, rfqEstimatePaise } from "./approvals";
import { checkAttachments, discardStored, MAX_RFQ_ATTACHMENTS, MAX_RFQ_ATTACHMENT_BYTES, storeAttachmentBytes } from "./attachments";
import { getBuyerEnquiry } from "./buyer";
import { deriveTitle, enquiryLinesSchema, linesDigest, type ParsedEnquiryLine } from "./lines";
import { runMatching } from "./matching";
import { startProactiveReachability } from "./reachability";
import { collectSignals, recordSignals } from "./risk";
import { enquiryInputSchema } from "./schemas";
import { profiles } from "./support";
import type { Actor, CreateEnquiryContext, EnquiryInput, EnquiryView } from "./types";

/** Validates, moderates, embeds, scores intent, matches top-N sellers synchronously (< 2s). */
export async function createEnquiry(actor: Actor, input: EnquiryInput, ctx: CreateEnquiryContext = {}): Promise<EnquiryView> {
  // Multi-line RFQ: with lines the RFQ title/description may be omitted (derived); line 1 mirrors the single quantity fields.
  const parsedLines: ParsedEnquiryLine[] | null = input.lines?.length ? enquiryLinesSchema.parse(input.lines) : null;
  if (input.lines && !input.lines.length) throw new DomainError("validation", "Add at least one line.");
  const head = parsedLines?.[0];
  const data = enquiryInputSchema.parse(parsedLines
    ? {
        ...input,
        title: input.title?.trim() || deriveTitle(parsedLines),
        requirement: input.requirement?.trim() || `Bill of materials with ${parsedLines.length} line item${parsedLines.length === 1 ? "" : "s"}.`,
        quantity: head!.quantity,
        quantityUnit: head!.unit,
        targetPricePaise: head!.targetPricePaise ?? input.targetPricePaise ?? null,
      }
    : input);
  // Validate files up front (type by magic bytes, size, count) so a bad upload fails before any model call or write.
  const files = checkAttachments(input.attachments, MAX_RFQ_ATTACHMENTS, MAX_RFQ_ATTACHMENT_BYTES);
  // Security audit: a business-only key is bypassed by opening more businesses. Also limit per person and per client IP
  // (spam fan-out burns seller attention and credits). All three must pass; each is checked so none can be skipped.
  const allowed = await Promise.all([
    rateLimit(`enquiry:create:${actor.businessId}`, 10, 3600),
    rateLimit(`enquiry:create:person:${actor.personId}`, 15, 3600),
    ctx.ip ? rateLimit(`enquiry:create:ip:${ctx.ip}`, 30, 3600) : Promise.resolve(true),
  ]);
  if (allowed.includes(false)) {
    throw new DomainError("rate_limited", "You have posted many requirements this hour. Please try again a little later.");
  }

  const isMember = await assertCan(actor, "rfq.create"); // viewer/approver/finance roles cannot publish requirements

  const category = data.categorySlug ? await catalogue.getCategoryBySlug(data.categorySlug) : null;
  if (data.categorySlug && !category) throw new DomainError("validation", "Unknown category", undefined, "ads.unknownCategory");
  if (category?.prohibited) throw new DomainError("validation", "This category is not allowed on the marketplace.");

  // Resolve each line's category (config/data, never hardcoded); a prohibited category blocks the whole RFQ.
  const slugCache = new Map<string, string | null>();
  for (const l of parsedLines ?? []) {
    if (!l.categorySlug || slugCache.has(l.categorySlug)) continue;
    const c = await catalogue.getCategoryBySlug(l.categorySlug);
    if (!c) throw new DomainError("validation", "Unknown category", undefined, "ads.unknownCategory");
    if (c.prohibited) throw new DomainError("validation", "This category is not allowed on the marketplace.");
    slugCache.set(l.categorySlug, c.id);
  }
  const lineRows = (parsedLines ?? [{ itemName: data.title.slice(0, 140), spec: data.requirement.slice(0, 2000), quantity: data.quantity ?? 1, unit: data.quantityUnit ?? "unit", targetPricePaise: data.targetPricePaise, categorySlug: null, hsn: null }])
    .map((l, i) => ({ ordinal: i + 1, itemName: l.itemName, spec: l.spec, quantity: l.quantity, unit: l.unit, targetPricePaise: l.targetPricePaise, hsn: l.hsn, categoryId: l.categorySlug ? (slugCache.get(l.categorySlug) ?? null) : (i === 0 && !parsedLines ? (category?.id ?? null) : null) }));

  const id = randomUUID();
  // ADR-008: every line goes to the AI capabilities as ordinary requirement text (moderation, embedding, intent), so matching sees the whole BOM.
  const digest = parsedLines ? linesDigest(parsedLines) : "";
  const text = `${data.title}\n${data.requirement}${digest ? `\n${digest}` : ""}`;
  const [moderation, emb, buyerProfiles, priorEnquiries, priorResponded, signals] = await Promise.all([
    ai.moderate({ text, categorySlug: category?.slug ?? null }, { type: "enquiry", id }),
    ai.embed([`${text}\n${category?.name ?? ""}`.trim()]),
    profiles([actor.businessId]),
    prisma.enquiry.count({ where: { buyerBusinessId: actor.businessId } }),
    prisma.enquiry.count({ where: { buyerBusinessId: actor.businessId, matches: { some: { status: { in: ["accepted", "refunded"] } } } } }),
    // ADR-002 device/behavioural signals: server-side only, hashed /24, UA family, velocity (risk.ts). Never blocks posting.
    collectSignals(actor.personId, { ip: ctx.ip, userAgent: ctx.userAgent, phoneVerified: ctx.buyerPhoneVerified }),
  ]);
  const vector = emb.vectors[0]!;
  const vec = toVectorLiteral(vector);

  const dup = await prisma.$queryRaw<{ sim: number }[]>`
    SELECT 1 - (embedding <=> ${vec}::vector) AS sim FROM enquiries
    WHERE buyer_business_id = ${actor.businessId}::uuid AND created_at > now() - interval '7 days' AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vec}::vector LIMIT 1`;

  // ADR-008/010: only the text fields above reach the model. Attachments (drawings/specs) are stored privately and never sent.
  const blocked = moderation.verdict === "block";
  let intentScore: number | null = null;
  let intentReasons: string[] = [];
  let scoreNeedsReview = false;
  if (!blocked) {
    const intent = await ai.scoreIntent(
      {
        title: data.title,
        requirement: digest ? `${data.requirement}\n${digest}` : data.requirement,
        quantity: data.quantity,
        quantityUnit: data.quantityUnit,
        targetPricePaise: data.targetPricePaise,
        deliveryPincode: data.deliveryPincode,
        neededBy: data.neededBy,
        buyerVerificationTier: buyerProfiles.get(actor.businessId)?.verificationTier ?? 0,
        buyerPhoneVerified: ctx.buyerPhoneVerified ?? false,
        buyerPriorEnquiries: priorEnquiries,
        buyerPriorResponded: priorResponded,
        nearDuplicateSimilarity: dup[0]?.sim ?? null,
        fakeLeadRisk: signals ? { score: signals.risk.score, reasons: signals.risk.reasons } : null,
      },
      { type: "enquiry", id },
    );
    intentScore = Math.round(intent.score);
    intentReasons = intent.reasons;
    scoreNeedsReview = intent.needsReview;
  }
  const held = !blocked && (moderation.verdict === "review" || moderation.needsReview || scoreNeedsReview);
  // docs/design/buyer-approvals.md: a matching approval rule holds the RFQ (never matched, never shown to sellers) until the chain signs off.
  const approval = blocked
    ? { status: "not_required" as const, requestId: null }
    : await consult(actor, { action: "rfq_publish", amountPaise: rfqEstimatePaise(data), subject: { type: "enquiry", id, summary: `RFQ: ${data.title}` } }, isMember);
  const awaitingApproval = approval.status === "pending";
  const status = blocked ? "rejected" : awaitingApproval ? "pending_approval" : held ? "review" : "scoring";

  const stored = await storeAttachmentBytes(id, files, { actor, kind: "rfq" });
  const expiresAt = new Date(Date.now() + data.expiresInDays * 24 * 60 * 60 * 1000);
  try {
  await prisma.$transaction(async (tx) => {
    await tx.enquiry.create({
      data: {
        id,
        buyerBusinessId: actor.businessId,
        buyerPersonId: actor.personId,
        categoryId: category?.id ?? null,
        title: data.title,
        requirement: data.requirement,
        quantity: data.quantity,
        quantityUnit: data.quantityUnit,
        targetPricePaise: data.targetPricePaise === null ? null : BigInt(data.targetPricePaise),
        deliveryCity: data.deliveryCity,
        deliveryPincode: data.deliveryPincode,
        neededBy: data.neededBy ? new Date(data.neededBy) : null,
        language: data.language,
        intentScore,
        intentReasons,
        moderationStatus: blocked ? "rejected" : held ? "review" : "approved",
        status,
        sellerCap: category?.leadCap ?? 3,
        buyerPicks: data.buyerPicks,
        budgetMinPaise: data.budgetMinPaise === null ? null : BigInt(data.budgetMinPaise),
        budgetMaxPaise: data.budgetMaxPaise === null ? null : BigInt(data.budgetMaxPaise),
        expiresAt,
        minSellerTier: data.minSellerTier,
      },
    });
    await tx.enquiryLine.createMany({
      data: lineRows.map((l) => ({ enquiryId: id, ordinal: l.ordinal, itemName: l.itemName, spec: l.spec, quantity: l.quantity, unit: l.unit, targetPricePaise: l.targetPricePaise === null ? null : BigInt(l.targetPricePaise), categoryId: l.categoryId, hsn: l.hsn })),
    });
    if (stored.length) {
      await tx.enquiryAttachment.createMany({
        data: stored.map((s) => ({ id: s.id, enquiryId: id, uploadedByBusiness: actor.businessId, key: s.key, fileName: s.fileName, mimeType: s.mimeType, sizeBytes: s.sizeBytes, createdAt: s.createdAt, scannedAt: s.scannedAt, scanner: s.scanner })),
      });
    }
    await tx.$executeRaw`UPDATE enquiries SET embedding = ${vec}::vector, embedding_version = ${emb.version} WHERE id = ${id}::uuid`;
    await emit(tx, "EnquiryCreated", { type: "enquiry", id }, {
      enquiryId: id, buyerBusinessId: actor.businessId, categoryId: category?.id ?? null,
      attachmentCount: stored.length, minSellerTier: data.minSellerTier, expiresAt: expiresAt.toISOString(), lineCount: lineRows.length,
    });
    if (signals) await recordSignals(tx, id, signals);
    if (intentScore !== null) await emit(tx, "EnquiryScored", { type: "enquiry", id }, { enquiryId: id, intentScore, needsReview: held });
  });
  } catch (err) {
    await discardStored(stored);
    if (approval.requestId && awaitingApproval) await approvals.cancelRequest({ requestId: approval.requestId, actorId: actor.personId }).catch(() => undefined);
    throw err;
  }

  if (status !== "rejected") await startProactiveReachability(id, { intentScore, riskScore: signals?.risk.score ?? 0 }).catch((err) => console.warn("[enquiry] proactive reachability not started", (err as Error).message));
  if (status === "scoring") {
    // A preference never bypasses matching rules: the seller is only ranked first if it is already an eligible
    // candidate (category, trust, cap). Only LIVE listings count, so a draft id in a URL can't steer a lead.
    let preferredSellerId: string | null = data.preferredSellerId;
    if (!preferredSellerId && data.preferredListingId) preferredSellerId = (await catalogue.getPublicListing(data.preferredListingId))?.sellerBusinessId ?? null;
    await runMatching(id, { preferredSellerId });
  }
  return (await getBuyerEnquiry(actor.businessId, id))!;
}

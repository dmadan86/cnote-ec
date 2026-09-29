import * as ai from "@cnote/ai";
import * as catalogue from "@cnote/catalogue";
import { DomainError, emit, rateLimit } from "@cnote/core";
import { prisma, toVectorLiteral } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { getBuyerEnquiry } from "./buyer";
import { runMatching } from "./matching";
import { enquiryInputSchema } from "./schemas";
import { profiles } from "./support";
import type { Actor, CreateEnquiryContext, EnquiryInput, EnquiryView } from "./types";

/** Validates, moderates, embeds, scores intent, matches top-N sellers synchronously (< 2s). */
export async function createEnquiry(actor: Actor, input: EnquiryInput, ctx: CreateEnquiryContext = {}): Promise<EnquiryView> {
  const data = enquiryInputSchema.parse(input);
  if (!(await rateLimit(`enquiry:create:${actor.businessId}`, 10, 3600))) {
    throw new DomainError("rate_limited", "You have posted many requirements this hour. Please try again a little later.");
  }

  const category = data.categorySlug ? await catalogue.getCategoryBySlug(data.categorySlug) : null;
  if (data.categorySlug && !category) throw new DomainError("validation", "Unknown category");
  if (category?.prohibited) throw new DomainError("validation", "This category is not allowed on the marketplace.");

  const id = randomUUID();
  const text = `${data.title}\n${data.requirement}`;
  const [moderation, emb, buyerProfiles, priorEnquiries, priorResponded] = await Promise.all([
    ai.moderate({ text, categorySlug: category?.slug ?? null }, { type: "enquiry", id }),
    ai.embed([`${text}\n${category?.name ?? ""}`.trim()]),
    profiles([actor.businessId]),
    prisma.enquiry.count({ where: { buyerBusinessId: actor.businessId } }),
    prisma.enquiry.count({ where: { buyerBusinessId: actor.businessId, matches: { some: { status: { in: ["accepted", "refunded"] } } } } }),
  ]);
  const vector = emb.vectors[0]!;
  const vec = toVectorLiteral(vector);

  const dup = await prisma.$queryRaw<{ sim: number }[]>`
    SELECT 1 - (embedding <=> ${vec}::vector) AS sim FROM enquiries
    WHERE buyer_business_id = ${actor.businessId}::uuid AND created_at > now() - interval '7 days' AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vec}::vector LIMIT 1`;

  const blocked = moderation.verdict === "block";
  let intentScore: number | null = null;
  let intentReasons: string[] = [];
  let scoreNeedsReview = false;
  if (!blocked) {
    const intent = await ai.scoreIntent(
      {
        title: data.title,
        requirement: data.requirement,
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
      },
      { type: "enquiry", id },
    );
    intentScore = Math.round(intent.score);
    intentReasons = intent.reasons;
    scoreNeedsReview = intent.needsReview;
  }
  const held = !blocked && (moderation.verdict === "review" || moderation.needsReview || scoreNeedsReview);
  const status = blocked ? "rejected" : held ? "review" : "scoring";

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
      },
    });
    await tx.$executeRaw`UPDATE enquiries SET embedding = ${vec}::vector, embedding_version = ${emb.version} WHERE id = ${id}::uuid`;
    await emit(tx, "EnquiryCreated", { type: "enquiry", id }, { enquiryId: id, buyerBusinessId: actor.businessId, categoryId: category?.id ?? null });
    if (intentScore !== null) await emit(tx, "EnquiryScored", { type: "enquiry", id }, { enquiryId: id, intentScore, needsReview: held });
  });

  if (status === "scoring") {
    let preferredSellerId: string | null = null;
    if (data.preferredListingId) preferredSellerId = (await catalogue.getListing(data.preferredListingId))?.sellerBusinessId ?? null;
    await runMatching(id, { preferredSellerId });
  }
  return (await getBuyerEnquiry(actor.businessId, id))!;
}

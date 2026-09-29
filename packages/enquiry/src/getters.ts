// Public lookups for other modules (reviews' verified-enquiry badge, notifications, ops UIs).
import { prisma } from "@cnote/db";

/** True when the buyer business has an accepted match (lead) with this seller (ADR-003 "verified enquiry"). */
export async function hasAcceptedMatch(buyerBusinessId: string, sellerBusinessId: string): Promise<boolean> {
  const n = await prisma.match.count({ where: { sellerBusinessId, status: "accepted", enquiry: { buyerBusinessId } } });
  return n > 0;
}

export interface EnquirySummary {
  id: string;
  title: string;
  buyerBusinessId: string;
  buyerPersonId: string;
  intentScore: number | null;
  status: string;
}

export async function getEnquirySummary(id: string): Promise<EnquirySummary | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const e = await prisma.enquiry.findUnique({
    where: { id },
    select: { id: true, title: true, buyerBusinessId: true, buyerPersonId: true, intentScore: true, status: true },
  });
  return e;
}

export interface EnquiryOpsView extends EnquirySummary {
  requirement: string;
  quantity: number | null;
  quantityUnit: string | null;
  targetPricePaise: number | null;
  deliveryCity: string | null;
  deliveryPincode: string | null;
  language: string;
  intentReasons: unknown;
  moderationStatus: string;
  createdAt: string;
}

/** Full enquiry for staff review screens (callers gate on an ops privilege). */
export async function getEnquiryForOps(id: string): Promise<EnquiryOpsView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const e = await prisma.enquiry.findUnique({ where: { id } });
  if (!e) return null;
  return {
    id: e.id, title: e.title, buyerBusinessId: e.buyerBusinessId, buyerPersonId: e.buyerPersonId, intentScore: e.intentScore, status: e.status,
    requirement: e.requirement, quantity: e.quantity, quantityUnit: e.quantityUnit,
    targetPricePaise: e.targetPricePaise == null ? null : Number(e.targetPricePaise),
    deliveryCity: e.deliveryCity, deliveryPincode: e.deliveryPincode, language: e.language, intentReasons: e.intentReasons,
    moderationStatus: e.moderationStatus, createdAt: e.createdAt.toISOString(),
  };
}

export interface ConversationParties {
  enquiryId: string;
  enquiryTitle: string;
  buyerBusinessId: string;
  buyerName: string;
  sellerBusinessId: string;
  sellerName: string;
}

export async function getConversationParties(conversationId: string): Promise<ConversationParties | null> {
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return null;
  const c = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      match: {
        select: {
          sellerBusinessId: true,
          seller: { select: { name: true } },
          enquiry: { select: { id: true, title: true, buyerBusinessId: true, buyer: { select: { name: true } } } },
        },
      },
    },
  });
  if (!c) return null;
  return {
    enquiryId: c.match.enquiry.id,
    enquiryTitle: c.match.enquiry.title,
    buyerBusinessId: c.match.enquiry.buyerBusinessId,
    buyerName: c.match.enquiry.buyer.name,
    sellerBusinessId: c.match.sellerBusinessId,
    sellerName: c.match.seller.name,
  };
}

export interface MatchSummary {
  id: string;
  enquiryId: string;
  enquiryTitle: string;
  buyerBusinessId: string;
  sellerBusinessId: string;
  status: string;
  rank: number;
}

export async function getMatchSummary(matchId: string): Promise<MatchSummary | null> {
  if (!/^[0-9a-f-]{36}$/i.test(matchId)) return null;
  const m = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, enquiryId: true, sellerBusinessId: true, status: true, rank: true, enquiry: { select: { title: true, buyerBusinessId: true } } },
  });
  if (!m) return null;
  return {
    id: m.id, enquiryId: m.enquiryId, enquiryTitle: m.enquiry.title, buyerBusinessId: m.enquiry.buyerBusinessId,
    sellerBusinessId: m.sellerBusinessId, status: m.status, rank: m.rank,
  };
}

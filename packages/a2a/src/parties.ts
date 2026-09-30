// System read for notifiers (no actor): the two businesses on a negotiation and whose human still has to act.
import { prisma } from "@cnote/db";

export interface NegotiationPartiesView {
  buyerBusinessId: string;
  sellerBusinessId: string;
  /** businesses whose human confirmation is still missing on an agreed negotiation */
  awaitingConfirmation: string[];
  /** agents (internal or external) answer offers themselves, so no human reply is ever awaited mid-negotiation */
  awaitingReplyBusinessId: null;
}

export async function getNegotiationParties(negotiationId: string): Promise<NegotiationPartiesView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(negotiationId)) return null;
  const n = await prisma.agentNegotiation.findUnique({
    where: { id: negotiationId },
    select: { buyerBusinessId: true, sellerBusinessId: true, status: true, buyerConfirmation: true, sellerConfirmation: true },
  });
  if (!n) return null;
  const awaiting = n.status === "agreed"
    ? [...(n.buyerConfirmation === "pending" ? [n.buyerBusinessId] : []), ...(n.sellerConfirmation === "pending" ? [n.sellerBusinessId] : [])]
    : [];
  return { buyerBusinessId: n.buyerBusinessId, sellerBusinessId: n.sellerBusinessId, awaitingConfirmation: awaiting, awaitingReplyBusinessId: null };
}

import { getJobQueue, queueConsumer, type ModuleWorker } from "@cnote/core";
import { prisma } from "@cnote/db";
import * as enquiry from "@cnote/enquiry";
import { DomainError } from "@cnote/core";
import { isQuoteAssistEnabled } from "./common";
import { generateDraft } from "./draft";

export const DRAFT_TOPIC = "negotiation.draft_quote";
declare module "@cnote/core" {
  interface JobTopics {
    "negotiation.draft_quote": { matchId: string; sellerBusinessId: string };
  }
}

/** LeadAccepted: always record the timing row (so "before" data exists with the flag off); enqueue a draft job only when the flag is on. */
export async function onLeadAccepted(p: { matchId: string; sellerBusinessId: string }, occurredAt: string): Promise<void> {
  const lead = await enquiry.getSellerLead(p.sellerBusinessId, p.matchId);
  if (lead?.conversationId) {
    await prisma.leadQuoteTiming.upsert({
      where: { matchId: p.matchId }, update: {},
      create: { matchId: p.matchId, conversationId: lead.conversationId, sellerBusinessId: p.sellerBusinessId, acceptedAt: new Date(occurredAt) },
    });
  }
  if (isQuoteAssistEnabled()) await getJobQueue().enqueue(DRAFT_TOPIC, { matchId: p.matchId, sellerBusinessId: p.sellerBusinessId }, { dedupeKey: `draft:${p.matchId}` });
}

/** QuoteSent: the first quote on a conversation closes its timing row (idempotent: only fills an empty firstQuoteAt). */
export async function onQuoteSent(p: { conversationId: string }, occurredAt: string): Promise<void> {
  await prisma.leadQuoteTiming.updateMany({ where: { conversationId: p.conversationId, firstQuoteAt: null }, data: { firstQuoteAt: new Date(occurredAt) } });
}

export async function handleDraftJob(p: { matchId: string; sellerBusinessId: string }): Promise<void> {
  if (!isQuoteAssistEnabled()) return; // flag turned off after enqueue
  try {
    await generateDraft(p.sellerBusinessId, p.matchId);
  } catch (err) {
    if (err instanceof DomainError) return; // lead gone / not accepted: nothing to retry
    throw err;
  }
}

export const worker: ModuleWorker = {
  name: "negotiation",
  handlers: {
    LeadAccepted: async (e) => onLeadAccepted(e.payload, e.occurredAt),
    QuoteSent: async (e) => onQuoteSent(e.payload, e.occurredAt),
  },
  jobs: [],
  queues: [queueConsumer(DRAFT_TOPIC, async (m) => handleDraftJob(m.payload))],
};

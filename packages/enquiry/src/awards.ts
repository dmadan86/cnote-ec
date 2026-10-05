// Per-line awards (docs/design/rfq-multiline.md, ADR-007): the buyer gives different requirement lines to different suppliers.
// Each supplier with awarded lines gets ONE off-platform Order (one order per match) that covers only its lines.
import { DomainError, emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { z } from "zod";
import { MAX_ENQUIRY_LINES } from "./lines";
import { recordOrderTx } from "./orders";
import type { Actor } from "./types";

const UUID = /^[0-9a-f-]{36}$/i;

export const awardInputSchema = z
  .array(z.object({ enquiryLineId: z.string().uuid(), quoteId: z.string().uuid() }))
  .min(1, "Pick at least one line to award")
  .max(MAX_ENQUIRY_LINES);
export type LineAwardInput = z.input<typeof awardInputSchema>[number];

export interface AwardResult {
  orderId: string;
  quoteId: string;
  matchId: string;
  sellerBusinessId: string;
  enquiryLineIds: string[];
  /** payable for the awarded lines (GST per line), integer paise */
  totalPaise: number;
}

/**
 * Buyer awards requirement lines to supplier quotes. Rules, all enforced here and not by the client:
 * - the enquiry is the actor's; each quote is the supplier's LATEST quote on it; a line is awarded at most once;
 * - only lines the quote actually priced (not "can't supply", not skipped) can be awarded to it;
 * - one order per supplier: a supplier that already has an order on this requirement cannot be awarded more lines;
 * - the amounts are the stored, server-computed line totals.
 * Everything runs in one transaction (awards, buyer-confirmed "won" deal report, Order, events).
 */
export async function awardLines(actor: Actor, enquiryId: string, input: LineAwardInput[]): Promise<{ results: AwardResult[] }> {
  if (!UUID.test(enquiryId)) throw new DomainError("not_found", "Requirement not found");
  const parsed = awardInputSchema.safeParse(input);
  if (!parsed.success) throw new DomainError("validation", parsed.error.issues[0]?.message ?? "Invalid award");
  const awards = parsed.data;
  if (new Set(awards.map((a) => a.enquiryLineId)).size !== awards.length) throw new DomainError("validation", "A line can only be awarded once.");

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM enquiries WHERE id = ${enquiryId}::uuid FOR UPDATE`;
    const enq = await tx.enquiry.findFirst({ where: { id: enquiryId, buyerBusinessId: actor.businessId }, select: { id: true } });
    if (!enq) throw new DomainError("not_found", "Requirement not found");

    const quotes = await tx.quote.findMany({
      where: { id: { in: [...new Set(awards.map((a) => a.quoteId))] } },
      include: { conversation: { include: { match: true } }, lines: true },
    });
    const quoteById = new Map(quotes.map((q) => [q.id, q]));
    const lines = await tx.enquiryLine.findMany({ where: { enquiryId } });
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const alreadyAwarded = await tx.enquiryLineAward.findMany({ where: { enquiryId }, select: { enquiryLineId: true } });
    const taken = new Set(alreadyAwarded.map((a) => a.enquiryLineId));

    const bySupplier = new Map<string, { quoteId: string; items: typeof awards }>();
    for (const a of awards) {
      const q = quoteById.get(a.quoteId);
      if (!q || q.conversation.match.enquiryId !== enquiryId) throw new DomainError("not_found", "Quote not found");
      if (!lineById.has(a.enquiryLineId)) throw new DomainError("validation", "A line does not belong to this requirement.");
      if (taken.has(a.enquiryLineId)) throw new DomainError("conflict", "A line in this award has already been awarded.");
      const group = bySupplier.get(q.sellerBusinessId) ?? { quoteId: q.id, items: [] };
      if (group.quoteId !== q.id) throw new DomainError("validation", "Award one quote per supplier.");
      group.items.push(a);
      bySupplier.set(q.sellerBusinessId, group);
    }

    const results: AwardResult[] = [];
    for (const [sellerBusinessId, { quoteId, items }] of bySupplier) {
      const q = quoteById.get(quoteId)!;
      const matchId = q.conversation.matchId;
      const latest = await tx.quote.findFirst({ where: { conversationId: q.conversationId }, orderBy: { createdAt: "desc" }, select: { id: true } });
      if (latest?.id !== q.id) throw new DomainError("conflict", "That quote was replaced by a newer one. Reload and compare again.");
      if (q.conversation.match.status !== "accepted") throw new DomainError("conflict", "Only accepted leads can be awarded.");
      await tx.$queryRaw`SELECT id FROM matches WHERE id = ${matchId}::uuid FOR UPDATE`;
      if (await tx.order.findUnique({ where: { matchId }, select: { id: true } })) {
        throw new DomainError("conflict", "This supplier already has an order on this requirement. Lines awarded now would need a new order.");
      }
      const rows = items.map((a) => {
        const line = lineById.get(a.enquiryLineId)!;
        const ql = q.lines.find((l) => l.enquiryLineId === a.enquiryLineId);
        if (!ql || ql.cantSupply || ql.unitPricePaise === null || ql.lineTotalPaise === null || ql.lineSubtotalPaise === null || ql.lineGstPaise === null) {
          throw new DomainError("validation", `Line ${line.ordinal} was not priced in this quote.`);
        }
        return { line, ql };
      });
      const totalPaise = rows.reduce((s, r) => s + r.ql.lineTotalPaise!, 0n);

      await tx.dealReport.create({ data: { matchId, reportedByBusinessId: actor.businessId, outcome: "won", valuePaise: totalPaise } });
      await emit(tx, "DealReportedOffPlatform", { type: "match", id: matchId }, { matchId, reportedByBusinessId: actor.businessId, outcome: "won", valuePaise: Number(totalPaise) });
      const { order } = await recordOrderTx(tx, matchId, { quoteId: q.id, totalPaise: Number(totalPaise), lineItems: true });

      await tx.enquiryLineAward.createMany({
        data: rows.map(({ line, ql }) => ({
          enquiryId, enquiryLineId: line.id, quoteId: q.id, quoteLineId: ql.id, sellerBusinessId, orderId: order.id,
          ordinal: line.ordinal, itemName: line.itemName, spec: line.spec, hsn: line.hsn, quantity: ql.quantity, unit: line.unit,
          unitPricePaise: ql.unitPricePaise!, gstRatePct: ql.gstRatePct, leadTimeDays: ql.leadTimeDays,
          lineSubtotalPaise: ql.lineSubtotalPaise!, lineGstPaise: ql.lineGstPaise!, lineTotalPaise: ql.lineTotalPaise!, gstIncluded: q.gstIncluded,
        })),
      });
      await emit(tx, "LinesAwarded", { type: "order", id: order.id }, {
        enquiryId, quoteId: q.id, orderId: order.id, matchId, buyerBusinessId: actor.businessId, sellerBusinessId,
        enquiryLineIds: rows.map((r) => r.line.id), totalPaise: Number(totalPaise),
      });
      results.push({ orderId: order.id, quoteId: q.id, matchId, sellerBusinessId, enquiryLineIds: rows.map((r) => r.line.id), totalPaise: Number(totalPaise) });
    }
    return { results };
  });
}

/** Immutable snapshot of one awarded line, as captured when the buyer awarded it (what a purchase order consumes). */
export interface AwardedLine {
  enquiryLineId: string;
  quoteLineId: string;
  quoteId: string;
  orderId: string;
  enquiryId: string;
  sellerBusinessId: string;
  ordinal: number;
  itemName: string;
  spec: string | null;
  hsn: string | null;
  quantity: number;
  unit: string;
  unitPricePaise: number;
  gstRatePct: number | null;
  /** true when the unit price already includes GST */
  gstIncluded: boolean | null;
  leadTimeDays: number | null;
  lineSubtotalPaise: number;
  lineGstPaise: number;
  lineTotalPaise: number;
  awardedAt: string;
}

type AwardRow = Awaited<ReturnType<typeof prisma.enquiryLineAward.findMany>>[number];
const toAwardedLine = (a: AwardRow): AwardedLine => ({
  enquiryLineId: a.enquiryLineId, quoteLineId: a.quoteLineId, quoteId: a.quoteId, orderId: a.orderId!, enquiryId: a.enquiryId, sellerBusinessId: a.sellerBusinessId,
  ordinal: a.ordinal, itemName: a.itemName, spec: a.spec, hsn: a.hsn, quantity: a.quantity, unit: a.unit, unitPricePaise: Number(a.unitPricePaise),
  gstRatePct: a.gstRatePct, gstIncluded: a.gstIncluded, leadTimeDays: a.leadTimeDays, lineSubtotalPaise: Number(a.lineSubtotalPaise),
  lineGstPaise: Number(a.lineGstPaise), lineTotalPaise: Number(a.lineTotalPaise), awardedAt: a.awardedAt.toISOString(),
});

/**
 * The lines awarded to an order's supplier, as immutable snapshots, ordered by line number. Empty for single-field orders.
 * Module-level read for other modules (e.g. purchase orders); callers authorise the order themselves.
 */
export async function getAwardedLines(orderId: string): Promise<AwardedLine[]> {
  if (!UUID.test(orderId)) return [];
  const rows = await prisma.enquiryLineAward.findMany({ where: { orderId }, orderBy: { ordinal: "asc" } });
  return rows.map(toAwardedLine);
}

/** Same snapshots for a whole requirement (all suppliers), for the buyer's award summary. */
export async function listAwardedLines(actor: Actor, enquiryId: string): Promise<AwardedLine[]> {
  if (!UUID.test(enquiryId)) return [];
  const rows = await prisma.enquiryLineAward.findMany({ where: { enquiryId, enquiry: { buyerBusinessId: actor.businessId } }, orderBy: { ordinal: "asc" } });
  return rows.map(toAwardedLine);
}

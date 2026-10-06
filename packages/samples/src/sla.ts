// Seller SLA: a request not answered within the response window (48h by default) expires on its own. Idempotent sweep.
import { emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { lockSample, logStatus } from "./internal";
import { samplesEnabled } from "./config";

/** Expires every `requested` sample past its deadline. Returns how many were expired. Safe to run concurrently and repeatedly. */
export async function expireOverdueSamples(now = new Date(), limit = 200): Promise<number> {
  const due = await prisma.sampleRequest.findMany({ where: { status: "requested", respondBy: { lte: now } }, select: { id: true }, orderBy: { respondBy: "asc" }, take: limit });
  let n = 0;
  for (const { id } of due) {
    const done = await prisma.$transaction(async (tx) => {
      await lockSample(tx, id);
      const r = await tx.sampleRequest.findUniqueOrThrow({ where: { id } });
      if (r.status !== "requested" || r.respondBy.getTime() > now.getTime()) return false;
      await tx.sampleRequest.update({ where: { id }, data: { status: "expired", activeKey: null } });
      await logStatus(tx, id, "expired", "system");
      await emit(tx, "SampleExpired", { type: "sample", id }, { sampleId: id, buyerBusinessId: r.buyerBusinessId, sellerBusinessId: r.sellerBusinessId });
      return true;
    });
    if (done) n++;
  }
  return n;
}

/** Scheduled entry: a no-op while SAMPLES_ENABLED is off. */
export async function runExpiryJob(): Promise<void> {
  if (!samplesEnabled()) return;
  const n = await expireOverdueSamples();
  if (n) console.log(`[samples] expired ${n} unanswered request(s)`);
}

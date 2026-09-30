import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cnote/db";
import { feeBreakdown, processPayouts, trialBalance } from "../src/index";
import { onDisputeOpened, onDisputeResolved } from "../src/escrow";
import { cleanup, fundedEscrow, ledgerFor, uid } from "./helpers";

afterAll(cleanup);

describe("settlement invariants (property)", () => {
  it("for any dispute decision: journals balance, buyer_escrow never goes negative, money is conserved and payouts drain payables", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 10_000, max: 50_000_000 }), fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }),
      async (total, relPct, refPct) => {
        const f = await fundedEscrow({ total });
        const d = uid();
        await onDisputeOpened({ disputeId: d, orderId: f.orderId });
        const release = Math.floor((total * relPct) / 100);
        const refund = Math.floor((total * refPct) / 100);
        await onDisputeResolved({ disputeId: d, refundPaise: refund, releasePaise: release });
        await processPayouts();
        const e = await prisma.escrowAgreement.findUniqueOrThrow({ where: { id: f.escrowId } });
        const refundEff = Math.min(refund, total);
        const releaseEff = Math.min(release, total - refundEff);
        expect(Number(e.refundedPaise)).toBe(refundEff);
        expect(Number(e.releasedPaise)).toBe(releaseEff);
        const l = await ledgerFor(f.escrowId);
        expect(l.debit).toBe(l.credit);
        expect(l.escrowHeld).toBe(total - releaseEff - refundEff);
        expect(l.escrowHeld).toBeGreaterThanOrEqual(0);
        expect(l.sellerPayable + 0).toBe(0);
        expect(l.refundPayable + 0).toBe(0);
        const b = releaseEff > 0 ? feeBreakdown(releaseEff) : { feePaise: 0, gstPaise: 0 };
        expect(l.fee).toBe(b.feePaise);
        expect(l.gst).toBe(b.gstPaise);
        // what is left at the partner = still-held escrow + fee + gst
        expect(l.nodal).toBe(l.escrowHeld + b.feePaise + b.gstPaise);
        expect((await trialBalance()).balanced).toBe(true);
      },
    ), { numRuns: 12 });
  });
});

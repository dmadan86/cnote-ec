// Default ports built on other modules' PUBLIC exports only. Where a module lacks the exact read we need, the adapter uses
// the closest public function and the gap is listed in docs/design/credit.md ("Requests for other modules").
import { disputeRecordForBusiness } from "@cnote/disputes";
import { feeBreakdown, fundEscrowFromLender, getEscrowDetail, listEscrows, setEscrowLenderAssignment } from "@cnote/escrow";
import { getGstEvidence, getTrustProfiles } from "@cnote/identity";
import { setDefaultPorts, type CreditPorts } from "./ports";
import type { EscrowFacts } from "./types";

const factsOf = (e: { id: string; orderId: string; status: string; frozen: boolean; amountPaise: number; heldPaise: number; buyerBusinessId: string; sellerBusinessId: string }): EscrowFacts => ({
  escrowId: e.id, orderId: e.orderId, status: e.status, frozen: e.frozen, amountPaise: e.amountPaise, heldPaise: e.heldPaise, buyerBusinessId: e.buyerBusinessId, sellerBusinessId: e.sellerBusinessId,
});

export const defaultPorts: CreditPorts = {
  async gst(businessId) {
    const ev = (await getGstEvidence(businessId, 5)).find((r) => r.status !== "pending");
    if (!ev) return { verified: false, status: null, lastCheckedAt: null, filings: [] };
    return {
      verified: ev.status === "passed",
      status: ev.snapshot?.status ?? null,
      lastCheckedAt: ev.status === "passed" ? new Date(ev.createdAt) : null,
      filings: (ev.snapshot?.filings ?? []).slice(0, 6).map((f) => ({ filed: f.filed })),
    };
  },
  async trust(businessId) {
    const p = (await getTrustProfiles([businessId])).get(businessId);
    return { trustScore: p?.trustScore ?? 0, badgeActive: p?.badgeActive ?? false };
  },
  async escrowHistory(businessId) {
    // NOTE: listEscrows is a global newest-first page (max 200); a per-business history read is requested from @cnote/escrow.
    const rows = (await listEscrows({ limit: 200 })).filter((e) => e.buyerBusinessId === businessId || e.sellerBusinessId === businessId);
    const released = rows.filter((e) => e.status === "released");
    let clean = 0;
    for (const e of released.slice(0, 30)) {
      const d = await getEscrowDetail(e.id);
      if (d && d.freezes.length === 0) clean += 1;
    }
    const sample = Math.min(released.length, 30);
    return {
      completed: released.length,
      completedPaise: released.reduce((a, e) => a + e.amountPaise, 0),
      // unsampled older releases are assumed clean in proportion to the sample
      clean: sample === 0 ? 0 : Math.round((clean / sample) * released.length),
      refunded: rows.filter((e) => e.status === "refunded").length,
    };
  },
  disputes: (businessId) => disputeRecordForBusiness(businessId),
  async escrowFacts(escrowId) {
    const d = await getEscrowDetail(escrowId);
    return d ? factsOf(d) : null;
  },
  async fundedEscrowsForSeller(businessId) {
    return (await listEscrows({ status: "funded", limit: 200 })).filter((e) => e.sellerBusinessId === businessId).map(factsOf);
  },
  sellerNetPaise: (amountPaise) => feeBreakdown(amountPaise).netPaise,
  async fundEscrowFromLender(escrowId, amountPaise, ref) {
    const out = await fundEscrowFromLender(escrowId, amountPaise, ref);
    return out === "funded" || out === "duplicate";
  },
  assignEscrowProceeds: (i) => setEscrowLenderAssignment(i),
};
setDefaultPorts(defaultPorts);

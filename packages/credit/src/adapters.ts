// Default ports built on other modules' PUBLIC exports only. Where a module lacks the exact read we need, the adapter uses
// the closest public function and the gap is listed in docs/design/credit.md ("Requests for other modules").
import { disputeRecordForBusiness } from "@cnote/disputes";
import { escrowHistoryForBusiness, feeBreakdown, fundEscrowFromLender, getEscrowDetail, listEscrowsForBusiness, setEscrowLenderAssignment } from "@cnote/escrow";
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
  // per-business aggregates from @cnote/escrow (counted in SQL over every escrow, not a sampled page)
  escrowHistory: (businessId) => escrowHistoryForBusiness(businessId),
  disputes: (businessId) => disputeRecordForBusiness(businessId),
  async escrowFacts(escrowId) {
    const d = await getEscrowDetail(escrowId);
    return d ? factsOf(d) : null;
  },
  async fundedEscrowsForSeller(businessId) {
    const out: EscrowFacts[] = [];
    let cursor: string | null = null;
    do {
      const page = await listEscrowsForBusiness(businessId, { role: "seller", status: "funded", cursor, limit: 100 });
      out.push(...page.items.map(factsOf));
      cursor = page.nextCursor;
    } while (cursor && out.length < 500);
    return out;
  },
  sellerNetPaise: (amountPaise) => feeBreakdown(amountPaise).netPaise,
  async fundEscrowFromLender(escrowId, amountPaise, ref) {
    const out = await fundEscrowFromLender(escrowId, amountPaise, ref);
    return out === "funded" || out === "duplicate";
  },
  assignEscrowProceeds: (i) => setEscrowLenderAssignment(i),
};
setDefaultPorts(defaultPorts);

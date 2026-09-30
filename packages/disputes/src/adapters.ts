// Real adapters for the escrow + quality ports. Kept out of the defaults so unit tests stay isolated; composition roots
// (worker, web, seller, admin) call wireDisputeAdapters() once at startup.
import { getEscrowSnapshotForOrder } from "@cnote/escrow";
import { listChecksForOrder } from "@cnote/quality";
import { setEscrowPort, setQualityEvidencePort, type EscrowPort, type QualityEvidencePort } from "./ports";

export const escrowAdapter: EscrowPort = {
  async getEscrowForOrder(orderId) {
    const e = await getEscrowSnapshotForOrder(orderId);
    return e ? { escrowId: e.escrowId, status: e.frozen ? `${e.status} (frozen)` : e.status, heldPaise: e.heldPaise, invoice: null } : null;
  },
};

export const qualityAdapter: QualityEvidencePort = {
  async listChecksForOrder(orderId) {
    return (await listChecksForOrder(orderId)).map((c) => ({
      id: c.checkId,
      verdict: c.verdict,
      confidence: c.confidence,
      summary: [`${c.photoCount} dispatch photo(s), advisory only`, ...c.results.map((r) => `${r.check}: ${r.result}${r.note ? ` (${r.note})` : ""}`)].join("; "),
      createdAt: c.completedAt,
    }));
  },
};

let wired = false;
export function wireDisputeAdapters(): void {
  if (wired) return;
  setEscrowPort(escrowAdapter);
  setQualityEvidencePort(qualityAdapter);
  wired = true;
}

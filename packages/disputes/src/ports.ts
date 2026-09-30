// Ports so @cnote/disputes never imports @cnote/escrow / @cnote/quality directly (built by other teams; ADR-006 keeps
// the graph acyclic). The composition root (apps/worker, apps/web, apps/seller, apps/admin) wires real adapters.
// Every default is safe: no escrow, no quality checks, media store = the PRIVATE bucket.
import { getMediaStore } from "@cnote/media";

export interface EscrowSnapshot {
  escrowId: string;
  status: string;
  /** funds currently held and therefore movable by this dispute, in paise */
  heldPaise: number;
  /** GST invoice for the order when one was generated on-platform (ADR-012) */
  invoice?: { number: string; totalPaise: number } | null;
}
export interface EscrowPort {
  getEscrowForOrder(orderId: string): Promise<EscrowSnapshot | null>;
}
export interface QualityCheckSummary {
  id: string;
  verdict: "consistent" | "inconsistent" | "inconclusive";
  confidence: number;
  summary: string;
  createdAt?: string;
}
export interface QualityEvidencePort {
  listChecksForOrder(orderId: string): Promise<QualityCheckSummary[]>;
}
export interface EvidenceStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

const nullEscrow: EscrowPort = { getEscrowForOrder: async () => null };
const nullQuality: QualityEvidencePort = { listChecksForOrder: async () => [] };
const privateStore: EvidenceStore = {
  put: (k, b, ct) => getMediaStore("private").put(k, b, ct),
  get: (k) => getMediaStore("private").get(k),
  delete: (k) => getMediaStore("private").delete(k),
};

let escrow: EscrowPort = nullEscrow;
let quality: QualityEvidencePort = nullQuality;
let store: EvidenceStore = privateStore;

/** Wire the escrow module: `setEscrowPort({ getEscrowForOrder })`. Pass null to restore the safe default. */
export function setEscrowPort(p: EscrowPort | null): void { escrow = p ?? nullEscrow; }
/** Wire the quality module: `setQualityEvidencePort({ listChecksForOrder })`. */
export function setQualityEvidencePort(p: QualityEvidencePort | null): void { quality = p ?? nullQuality; }
/** Override evidence storage (tests). Default: the PRIVATE media bucket, keys `disputes/<disputeId>/<evidenceId>.<ext>`. */
export function setEvidenceStore(s: EvidenceStore | null): void { store = s ?? privateStore; }

export const escrowPort = (): EscrowPort => escrow;
export const qualityPort = (): QualityEvidencePort => quality;
export const evidenceStore = (): EvidenceStore => store;

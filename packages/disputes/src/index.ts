// @cnote/disputes: ADR-013 AI-mediated dispute resolution with human adjudication. Flag DISPUTES_ENABLED.
// PUBLIC CONTRACT. Extend, don't break. Escrow freezing/releasing is event-driven: this module emits
// DisputeOpened / DisputeEscalated / DisputeResolved and never moves money. See docs/design/disputes.md.
export type {
  Actor, AddEvidenceInput, AdjudicateInput, AppealView, BriefView, DecisionView, DisputeMetrics, DisputeOutcome, DisputeStatus, DisputeSummary, DisputeTypeName,
  DisputeView, EvidenceUpload, EvidenceView, Lang, MessageView, OpenDisputeInput, PartyRole, ProposalView, RespondInput, StaffDisputeSummary, StaffDisputeView, StaffEvidenceView,
} from "./types";
export {
  DISPUTE_TYPES, SLA_DAYS, APPEAL_WINDOW_DAYS, EVIDENCE_RETENTION_DAYS, disputesEnabled, disputeConfig, type DisputeConfig,
} from "./config";
export { ACTIVE_STATUSES, TRANSITIONS, canTransition, faultFor, routeBrief, validateSplit, deadlines, median } from "./state";
export { MAX_EVIDENCE_BYTES, MAX_EVIDENCE_FILES } from "./files";
export {
  setEscrowPort, setQualityEvidencePort, setEvidenceStore, type EscrowPort, type EscrowSnapshot, type QualityEvidencePort, type QualityCheckSummary, type EvidenceStore,
} from "./ports";
export {
  openDispute, respondToDispute, addDisputeEvidence, withdrawDispute, escalateDispute, appealDecision, postDisputeMessage, getDispute, getDisputeForOrder, listDisputes,
  readEvidenceFileForParty,
} from "./parties";
export { collectEvidence, runBrief, queueBrief, orderFacts } from "./brief";
export { adjudicateDispute, decideAppeal, staffPostDisputeMessage, finalizeAutoResolutions } from "./resolve";
export { listDisputeQueue, countDisputesNeedingStaff, getDisputeForStaff, readEvidenceFileForStaff, type QueueFilter } from "./staff";
export { advanceDisputes, flagOverdueDisputes, disputeMetrics } from "./sla";
export { purgeResolvedDisputeEvidence } from "./retention";
export { COLLECT_TOPIC, BRIEF_TOPIC } from "./jobs";
export { worker } from "./worker";
export { escrowAdapter, qualityAdapter, wireDisputeAdapters } from "./adapters";

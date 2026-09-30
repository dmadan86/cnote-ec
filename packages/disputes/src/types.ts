// Public view/input types of @cnote/disputes.
import type { Actor } from "@cnote/enquiry";
import type { EvidenceUpload } from "./files";
import type { DisputeOutcome, DisputeStatus } from "./state";
import type { DisputeTypeName } from "./config";

export type { Actor };
export type { DisputeOutcome, DisputeStatus, DisputeTypeName, EvidenceUpload };
export type Lang = "en" | "hi" | "kn" | "ta" | "te" | "mr" | "gu" | "bn";
export type EvidenceKind = "statement" | "photo" | "document" | "voice" | "system";
export type PartyRole = "buyer" | "seller";

export interface OpenDisputeInput {
  orderId: string;
  type: DisputeTypeName;
  /** may be empty when a voice note is attached (the transcript becomes the description) */
  description?: string;
  /** what the opener claims, in paise */
  amountPaise?: number | null;
  language?: Lang;
  /** ADR-010: voice notes are personal data; the opener must say they consent to storage + transcription */
  voiceConsent?: boolean;
  attachments?: EvidenceUpload[];
}
export interface RespondInput {
  text?: string;
  language?: Lang;
  voiceConsent?: boolean;
  attachments?: EvidenceUpload[];
}
export interface AddEvidenceInput {
  text?: string;
  language?: Lang;
  voiceConsent?: boolean;
  attachment?: EvidenceUpload;
}

export interface EvidenceView {
  id: string;
  party: "buyer" | "seller" | "system" | "staff";
  /** true when submitted by the viewing business */
  mine: boolean;
  kind: EvidenceKind;
  text: string | null;
  hasFile: boolean;
  mimeType: string | null;
  source: string;
  purged: boolean;
  createdAt: string;
}
export interface MessageView { id: string; authorType: "buyer" | "seller" | "staff" | "system"; mine: boolean; body: string; createdAt: string }
export interface DecisionView {
  outcome: DisputeOutcome | "withdrawn";
  refundPaise: number;
  releasePaise: number;
  decidedBy: "auto" | "staff";
  rationale: string;
  faultBusinessId: string | null;
  createdAt: string;
}
export interface ProposalView { outcome: DisputeOutcome; refundPaise: number; releasePaise: number; escalationDeadline: string }
export interface AppealView { id: string; status: "open" | "upheld" | "modified"; reason: string; resolutionNote: string | null; createdAt: string; decidedAt: string | null }

export interface DisputeView {
  id: string;
  orderId: string;
  status: DisputeStatus;
  type: DisputeTypeName;
  role: PartyRole;
  openedByMe: boolean;
  counterpartyBusinessId: string;
  description: string;
  language: string;
  amountPaise: number | null;
  atStakePaise: number;
  createdAt: string;
  dueAt: string;
  responseDueAt: string;
  counterpartyRespondedAt: string | null;
  resolvedAt: string | null;
  proposal: ProposalView | null;
  decision: DecisionView | null;
  evidence: EvidenceView[];
  messages: MessageView[];
  appeal: AppealView | null;
  can: { respond: boolean; addEvidence: boolean; escalate: boolean; appeal: boolean; withdraw: boolean; message: boolean };
}
export interface DisputeSummary {
  id: string;
  orderId: string;
  status: DisputeStatus;
  type: DisputeTypeName;
  role: PartyRole;
  openedByMe: boolean;
  amountPaise: number | null;
  createdAt: string;
  dueAt: string;
  resolvedAt: string | null;
  needsMyAction: boolean;
}

// ---- staff (callers gate on disputes.read / disputes.adjudicate) ----
export interface StaffEvidenceView extends Omit<EvidenceView, "mine"> { submittedByBusinessId: string | null; language: string | null }
export interface BriefView {
  id: string;
  version: number;
  classifiedType: DisputeTypeName;
  summary: string;
  citedEvidenceIds: string[];
  specChecks: { field: string; agreed: string; claimed: string; match: "match" | "mismatch" | "unknown" }[];
  specVerdict: string;
  recommendedOutcome: DisputeOutcome;
  recommendedRefundPaise: number;
  recommendedReleasePaise: number;
  rationale: string;
  confidence: number;
  autoResolvable: boolean;
  needsReview: boolean;
  evidenceCount: number;
  provider: string;
  modelId: string;
  promptVersion: string;
  createdAt: string;
}
export interface StaffDisputeSummary {
  id: string;
  orderId: string;
  status: DisputeStatus;
  type: DisputeTypeName;
  buyerBusinessId: string;
  sellerBusinessId: string;
  amountPaise: number | null;
  atStakePaise: number;
  createdAt: string;
  dueAt: string;
  overdue: boolean;
  msToDue: number;
  escalated: boolean;
  hasOpenAppeal: boolean;
  briefConfidence: number | null;
}
export interface StaffDisputeView extends StaffDisputeSummary {
  openedByBusinessId: string;
  againstBusinessId: string;
  description: string;
  language: string;
  responseDueAt: string;
  counterpartyRespondedAt: string | null;
  evidence: StaffEvidenceView[];
  briefs: BriefView[];
  /** evidence rows added after the latest brief was written */
  evidenceAfterBrief: number;
  proposal: ProposalView | null;
  decision: (DecisionView & { followedRecommendation: boolean; decidedByStaffPersonId: string | null }) | null;
  threads: { partyBusinessId: string; messages: (Omit<MessageView, "mine"> & { authorPersonId: string | null })[] }[];
  appeals: (AppealView & { byBusinessId: string; newOutcome: DisputeOutcome | null; newRefundPaise: number | null; newReleasePaise: number | null })[];
}
export interface AdjudicateInput {
  outcome: DisputeOutcome;
  refundPaise?: number;
  releasePaise?: number;
  rationale: string;
  /** use the latest brief's recommendation verbatim (amounts and outcome) */
  acceptRecommendation?: boolean;
}
export interface DisputeMetrics {
  opened: number;
  resolved: number;
  withdrawn: number;
  medianResolutionMs: number | null;
  medianResolutionDays: number | null;
  targetDays: number;
  meetsTarget: boolean | null;
  withinSlaShare: number | null;
  autoResolvedShare: number | null;
  overdueActive: number;
  appealRate: number | null;
  briefAgreementRate: number | null;
}

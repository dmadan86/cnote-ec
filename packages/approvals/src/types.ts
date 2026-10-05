import type { TeamRole } from "@cnote/identity";

export const APPROVAL_ACTIONS = ["rfq_publish", "quote_accept", "order_confirm", "po_issue"] as const;
export type ApprovalActionName = (typeof APPROVAL_ACTIONS)[number];
/** Actions that commit money: only these count towards (and are checked against) a member's monthly spend limit. */
export const SPEND_ACTIONS: readonly ApprovalActionName[] = ["quote_accept", "order_confirm", "po_issue"];

/** Roles a chain level can name. A member of that role, or of a higher one (owner > admin > approver/finance), may decide. */
export const APPROVER_ROLES = ["approver", "finance", "admin", "owner"] as const;
export type ApproverRole = (typeof APPROVER_ROLES)[number];
export const MAX_LEVELS = 3;

/** What an approval is about. Opaque to this module: the caller names it and resumes the held action itself. */
export interface ApprovalSubject {
  /** e.g. "enquiry", "quote", "order", "purchase_order" */
  type: string;
  id: string;
  /** short human label shown to approvers, e.g. "RFQ: 500 kg cotton yarn" (no secrets: it appears in notifications) */
  summary: string;
}

export type ApprovalStatusName = "pending" | "approved" | "rejected" | "cancelled" | "expired";

export interface RequireApprovalInput {
  businessId: string;
  /** the person asking to do the thing (the requester: can never approve their own request) */
  actorId: string;
  action: ApprovalActionName;
  amountPaise: number;
  subject: ApprovalSubject;
}

export interface RequireApprovalResult {
  status: "not_required" | "pending" | "approved" | "rejected";
  requestId: string | null;
  /** why approval was (or was not) needed */
  reason?: "policy" | "spend_limit" | "no_eligible_approver" | "none";
}

export interface ChainLevel {
  level: number;
  role: ApproverRole;
  /** specific members; when set (and any are still on the team) they decide instead of the role */
  personIds: string[];
}

export interface PolicyLevelInput {
  role: ApproverRole;
  personIds?: string[];
  /** paise; the level only applies when the amount is at or above it */
  minAmountPaise?: number;
}

export interface PolicyInput {
  id?: string;
  name: string;
  action: ApprovalActionName;
  minAmountPaise: number;
  enabled?: boolean;
  levels: PolicyLevelInput[];
}

export interface PolicyView {
  id: string;
  name: string;
  action: ApprovalActionName;
  minAmountPaise: number;
  enabled: boolean;
  levels: { level: number; role: ApproverRole; personIds: string[]; minAmountPaise: number }[];
}

export interface DecisionView {
  id: string;
  level: number;
  kind: "approved" | "rejected" | "cancelled" | "expired" | "auto_approved";
  deciderPersonId: string | null;
  onBehalfOfPersonId: string | null;
  comment: string | null;
  createdAt: string;
}

export interface RequestView {
  id: string;
  businessId: string;
  action: ApprovalActionName;
  subject: ApprovalSubject;
  amountPaise: number;
  requesterPersonId: string;
  status: ApprovalStatusName;
  reason: "policy" | "spend_limit";
  currentLevel: number;
  totalLevels: number;
  /** who can decide the current level right now (direct approvers) */
  approverPersonIds: string[];
  dueAt: string;
  createdAt: string;
  resolvedAt: string | null;
  decisions: DecisionView[];
}

export interface SpendSummary {
  personId: string;
  role: TeamRole;
  capPaise: number | null;
  spentPaise: number;
}

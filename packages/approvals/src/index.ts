// @cnote/approvals: buyer approval chains, spend limits and delegation (docs/design/buyer-approvals.md).
// Depends on core, db and identity only: callers (enquiry now, purchase orders next) pass an opaque subject {type, id, summary} and resume
// the held action from the ApprovalApproved / ApprovalRejected domain events. PUBLIC CONTRACT. Extend, don't break.
//
//   const r = await requireApproval({ businessId, actorId, action: "po_issue", amountPaise, subject: { type: "purchase_order", id, summary } });
//   r.status === "not_required" | "approved"  -> go ahead;  "pending" -> hold, resume on ApprovalApproved (subjectType "purchase_order");
//   "rejected" -> do not proceed.  After committing money call recordSpend(...) once per subject.
export {
  APPROVAL_ACTIONS, APPROVER_ROLES, MAX_LEVELS, SPEND_ACTIONS,
  type ApprovalActionName, type ApproverRole, type ApprovalSubject, type ApprovalStatusName, type RequireApprovalInput, type RequireApprovalResult,
  type ChainLevel, type PolicyInput, type PolicyLevelInput, type PolicyView, type DecisionView, type RequestView, type SpendSummary,
} from "./types";
export { requireApproval, decide, cancelRequest, getRequest, listPending, listRequests, getSubjectTrail, getSubjectStatuses, countPending, type DecideInput } from "./requests";
export { listPolicies, savePolicy, setPolicyEnabled, deletePolicy, matchPolicy, MAX_POLICIES_PER_BUSINESS } from "./policies";
export { createDelegation, revokeDelegation, listDelegations, type DelegationView } from "./delegation";
export { setSpendLimit, listSpend, recordSpend, getSpentPaise, getSpendLimitPaise, monthBounds } from "./spend";
export { exportApprovalsData, exportPersonalData, eraseApprovalsData, purgeResolvedRequests, purgeEndedDelegations } from "./privacy";
export { runSlaSweep } from "./sla";
export { worker } from "./worker";

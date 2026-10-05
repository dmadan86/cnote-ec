# Buyer team roles, spend limits and approval chains

Status: built, always on (rules are per business and empty by default, so nothing changes until an owner or admin adds a rule or a spend limit).
Related: ADR-006 (module boundaries), ADR-007 (event log), ADR-010 (DPDP), `docs/design/buyer-account.md`.

## What it does

1. **Team roles** on the buyer side: `owner`, `admin`, `requester`, `approver`, `finance`, `viewer`. Owner and admin manage the team and rules; requesters publish RFQs and accept quotes; approvers and finance decide approvals; viewers only look.
2. **Invitations**: owner/admin invites by email (single-use token, 7-day expiry, sha256 stored, email from the DB template `team.invite`), changes roles, removes members. Ownership transfer needs step-up (password or MFA code, same check as account erasure).
3. **`@cnote/approvals`**: per-business policies (action, amount threshold in paise, up to 3 sequential levels by role or named members), requests with an append-only decision log, self-approval forbidden, out-of-office delegation, SLA reminders and expiry, versioned events.
4. **Spend limits**: a monthly cap per member (IST calendar month) computed from quote acceptances recorded through `recordSpend`.
5. **Integration**: RFQ publish and quote acceptance (enquiry) consult approvals and resume from events. Approver inbox, rule builder, team page and audit trail live in `apps/web`.

## Public API of `@cnote/approvals` (dependencies: core, db, identity)

```ts
requireApproval({ businessId, actorId, action, amountPaise, subject: { type, id, summary } })
  -> { status: "not_required" | "pending" | "approved" | "rejected", requestId, reason? }
decide({ requestId, deciderId, decision: "approve" | "reject", comment? })
cancelRequest, listPending, listRequests, getRequest, getSubjectTrail, getSubjectStatuses, countPending
savePolicy / listPolicies / setPolicyEnabled / deletePolicy / matchPolicy
createDelegation / revokeDelegation / listDelegations
setSpendLimit / listSpend / recordSpend
```

Semantics: `not_required` and `approved` mean go ahead; `pending` means hold and wait for the `ApprovalApproved` event; `rejected` means do not proceed. The call is idempotent per (business, action, subject).

### Events (all version 1, no free text or email addresses in payloads)

`ApprovalRequested` (a level opened; `approverPersonIds` includes active delegates), `ApprovalDecided`, `ApprovalApproved` (whole chain approved; resume), `ApprovalRejected` (`cause`: rejected, cancelled, expired), `ApprovalReminder`, `BuyerMemberInvited`, `BuyerMemberJoined`, `BuyerMemberRoleChanged`, `BuyerMemberRemoved`, `BusinessOwnershipTransferred`.

### Purchase orders (built by another agent in parallel)

PO issuance should call `requireApproval({ action: "po_issue", subject: { type: "purchase_order", id, summary } })`, hold the PO when `pending`, and handle `ApprovalApproved` / `ApprovalRejected` for `subjectType === "purchase_order"` in its own worker (idempotently, as `packages/enquiry/src/approvals.ts` does). After committing money it should call `recordSpend` once per subject, but not when the PO derives from a quote that was already recorded (same money). `order_confirm` is available the same way. Nothing in `@cnote/approvals` needs to change.

## Decisions

- **Legacy `staff`**: the enum value stays (existing rows and the seller side untouched, no data rewrite). `effectiveRole("staff")` is `requester`, so it can post RFQs and accept quotes but not approve. New invitations never create `staff`.
- **Roles are enforced only for team members**: `createEnquiry` and `decideQuote` refuse a member whose role lacks the capability; an actor that is not a member at all (system/agent callers, legacy fixtures) is unchanged, because authentication is the caller's job.
- **One-person businesses**: if nobody but the requester could ever approve, the request is auto-approved with a visible `auto_approved` decision (no deadlock, but never silent). The same applies to a level with nobody left (everyone eligible already decided earlier).
- **Distinct approvers per level**: someone who decided (or was covered by a delegate) at an earlier level is excluded later. Delegation cannot be used to approve for, or as, the requester.
- **Eligibility is live**: roles, removals and delegations apply immediately; only the chain shape is snapshotted on the request. A level naming specific members falls back to its role if they all left, so a request is never orphaned.
- **Role hierarchy for a level**: `owner` only owners; `admin` owner or admin; `approver` and `finance` their role plus admin and owner.
- **Spend limit never blocks**: going over the cap forces a request that an owner or admin must approve (`reason: spend_limit`), added as the last level of any matching policy.
- **Held RFQ**: `EnquiryStatus.pending_approval`; never matched, so sellers never see it. Approval moves it to `review` (moderation still pending) or `scoring` and matches it; rejection, withdrawal or expiry closes it. The preferred-seller hint from the posting form is not preserved across the hold (a known limitation; it is only a ranking nudge).
- **Held quote acceptance**: `decideQuote` returns `{ status: "accepted" | "declined" | "pending_approval" }`; on `ApprovalApproved` the enquiry worker completes the buyer's "won" report (creating the order record) and records spend, idempotently.
- **Invitation email**: sent with `sendEmail` and the DB template `team.invite` (queue `email.send`), not the plain-text `identity.mail` queue, because the copy must live in the template studio. The token only appears in that email.
- **Active business**: sessions still pick the person's first membership (owner first). A person who already owns a business and is invited elsewhere has no business switcher yet; not built here.
- **Decision comments** are free text: erasure nulls them (the append-only trigger allows exactly that update); pseudonymous person ids stay with the business record.
- **Notifications**: category `leads` for approvals, `security` for team changes (always on). Approver lists come from event payloads, so `@cnote/notifications` gained no new dependency.
- **Error text** for the new `team.*` / `approvals.*` error keys is localised from the `approvals` web namespace (en, hi and the six disk catalogues), not the shared `errors` namespace.

## Data (`approvals.prisma`, identity changes)

`approval_policies`, `approval_policy_levels`, `approval_requests` (unique `active_key` keeps one open request per subject), `approval_decisions` (append-only trigger; only `comment` may become NULL), `approval_delegations`, `member_spend_limits`, `spend_records` (unique per subject). Identity adds `business_invites` and the `member_role` values. Enquiry adds `enquiry_status = pending_approval`.

## DPDP

Export: `approvals` source in `@cnote/compliance` (requests raised, decisions made, delegations, caps, spend) plus `team` (invitations sent or received) inside the identity export. Erasure: invitations deleted, comments nulled, delegations and caps deleted. Retention: resolved requests 8 years (`RETENTION_APPROVAL_RECORDS_DAYS`), ended delegations 12 months, used or expired invites 30 days.

## Operations

`APPROVAL_SLA_HOURS` (24), `APPROVAL_MAX_REMINDERS` (3), `APPROVAL_EXPIRY_DAYS` (7); sweep job `approvals.sla-sweep` every 15 minutes in the worker (required, like the other module workers).

## UI and research

Screens: `/account/team`, `/account/team/accept`, `/account/approvals` (rules, out of office, spend limits), `/buyer/approvals` and `/buyer/approvals/[id]` (inbox and decision with comment), audit trail on `/buyer/enquiries/[id]`. WCAG 2.2 AA: labelled controls, errors via `Field`/alerts, 44px targets from `@cnote/ui`, text status (not colour alone), axe spec `e2e/a11y/buyer-approvals.spec.ts` (English and Hindi).

Mobbin references adopted:
- Team and invites: Vercel members (invite form above a members list) https://mobbin.com/screens/ba7f9ef8-19e2-4413-be29-7cd7dc617c19 ; AirOps team (pending badge, role select, revoke) https://mobbin.com/screens/1722c6f1-6c78-48d7-b459-3dfef04cdf12 ; Midday invite dialog https://mobbin.com/screens/b047c098-2b2c-4c70-8143-3742c9367a30
- Approval inbox: Toggl Track approvals (tabs by state, list rows) https://mobbin.com/screens/501c9ea1-ae92-497d-8157-db174d744524 ; Cofounder approve/reject with feedback https://mobbin.com/screens/666ce02d-80fc-49a0-993b-a131ff8fa168
- Rules builder: Square rules (condition and action summary cards with edit/deactivate) https://mobbin.com/screens/89b02f1d-3d90-481c-b8aa-1f0859bc7f16 ; Calendly route builder (ordered steps) https://mobbin.com/screens/d2ce399f-bd4c-441f-a786-2f1c5c8053a7

## Not done

Business switcher for people in several businesses; approval policies per category or per supplier; approvals for `order_confirm` (the API supports it, no caller yet); email-only approve links.

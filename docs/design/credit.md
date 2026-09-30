# Embedded credit via an NBFC partner (ADR-019)

Package `@cnote/credit`. Flag `CREDIT_ENABLED` (default off). Phase 3. cnote supplies an explainable platform credit score
and the orchestration; the **NBFC partner is the lender of record** (underwrites, disburses, collects, reports). cnote lends
nothing from its own balance sheet. Credit exists **only on escrowed orders** (ADR-012). Read with ADR-003 (verification and
trust), ADR-008 (explainable AI decisions), ADR-010 (DPDP: consent, minimisation, India-only), ADR-012 (escrow) and ADR-013 (disputes).

## What ships

| Piece | Where |
| --- | --- |
| Score model `credit-v1` (pure, deterministic) | `src/model.ts` |
| Features from identity / escrow / disputes through ports | `src/ports.ts`, `src/adapters.ts`, `src/score.ts` |
| Consent (`credit_underwriting`) | `src/consent.ts`, table `credit_consent_links` |
| Eligibility and limits | `src/eligibility.ts` |
| Offer maths and Key Fact Statement | `src/kfs.ts` |
| Applications, offers, explicit acceptance | `src/applications.ts` |
| NBFC partner port + `mock` + `nbfc_partner` stub | `src/partner/` |
| Signed idempotent webhook ingress | `src/webhook.ts`, `apps/api/src/routes/webhooks/credit.ts` |
| Loan-book mirror, DPD, assignment contract | `src/loans.ts` |
| Metrics (GNPA, credit-attached GMV), FLDG, staff reads | `src/stats.ts` |
| DPDP retention | `src/retention.ts` |
| Worker (handlers and jobs) | `src/worker.ts` |
| UI | seller `apps/seller/src/app/(portal)/credit`, buyer BNPL `apps/web/src/features/credit`, admin `apps/admin/src/app/(console)/credit` |

Tables (schema `packages/db/prisma/schema/credit.prisma`, no relations to other modules, money in `BigInt` paise):
`credit_consent_links`, `credit_scores` (append-only snapshots), `credit_applications`, `credit_offers`, `credit_loans` (mirror),
`credit_repayments` (append-only, unique per loan and event), `credit_assignments`, `credit_webhook_events`, `credit_partner_shares`.

## Consent (DPDP, ADR-010)

Nothing is read from GST, escrow or dispute data, and nothing is sent to a partner, without an active `credit_underwriting`
consent. The consent ledger is identity's (`setConsent` / `hasConsent`, keyed by person); this module keeps a
business-to-person link so the worker can tell who consented. `hasActiveCreditConsent(businessId)` is true only when a linked
person's latest ledger row is `granted`, so withdrawing in any other place (for example a privacy page) also counts.

* `grantCreditConsent(actor)`: ledger row plus link. `withdrawCreditConsent(actor)`: ledger row, link closed, and when no
  consenting person is left, un-accepted applications are `cancelled` and their open offers `withdrawn`. Existing loans continue
  with the lender; data already shared stays with the lender, which the UI says.
* `computeAndStoreScore`, `applyForFinancing`, `acceptOffer` and every worker recompute return or refuse without consent.
* Every partner submission writes a `credit_partner_shares` row listing the feature keys that were sent (an audit of disclosure).

## Score model `credit-v1`

Score = 300 + up to 600 points, so 300 to 900, integer. Pure function of a feature vector, so it is deterministic and unit
testable. Inputs never include raw GST returns: only counts, ratios and flags.

| Component (reason code) | Max | Input |
| --- | --- | --- |
| `GST_NOT_VERIFIED` | 60 | GST verified (latest non-pending verification record passed) |
| `GST_STATUS_INACTIVE` | 40 | provider status is Active |
| `GST_VERIFICATION_STALE` | 30 | age of the last successful verification or re-check: full at 90 days or less, zero at 365 |
| `GST_FILINGS_MISSED` | 70 | share of the last six filing periods that were filed (0.5 when the provider returned none) |
| `ESCROW_FEW_ORDERS` | 80 | completed escrow orders, log scaled, full at 20 |
| `ESCROW_LOW_VOLUME` | 60 | value of completed escrow orders, log scaled, full at Rs 50 lakh |
| `ESCROW_DISPUTED_ORDERS` | 50 | share of completed orders that never had a dispute freeze |
| `ESCROW_REFUNDS` | 30 | one minus the refunded share of closed escrows |
| `DISPUTES_LOST` | 60 | minus 20 per dispute lost |
| `DISPUTES_OPEN` | 40 | minus 15 per open dispute |
| `TRUST_LOW` | 80 | trust score (tier, response behaviour, outcomes) scaled to 70, plus 10 for an active badge |

Properties (fast-check in `test/model.test.ts`): always within 300..900, deterministic, and monotone (more of a good signal
never lowers the score; more of a bad one never raises it). Bands: poor under 500, fair 500, good 600, very good 700, excellent 800.

**Explanations.** Each snapshot stores up to four negative reasons (largest shortfall first, adverse-action style) and up to two
strong positives, each with code, points and maximum. The seller UI renders them with translated text. Snapshots are append-only;
an unchanged feature vector is not stored again (feature hash). Recompute triggers: `EscrowReleased`, `EscrowRefunded`,
`DisputeResolved` (fault business), `BusinessVerified`, `TrustScoreChanged`, application time, portal view, and nightly for every
consenting business. Changing weights means a new `modelVersion` and golden-set review (ADR-008); nothing changes `credit-v1` in place.

**Limits by band** (`BAND_LIMITS`): invoice financing may advance 60% (fair), 70% (good), 80% (very good), 85% (excellent) of
the seller's net escrow proceeds; BNPL is capped per band (Rs 1 lakh, 5 lakh, 15 lakh, 50 lakh) and by the order value. Poor gets nothing.

## Partner port

`CreditPartner` (`src/partner/types.ts`): `submitApplication`, `getOffers`, `acceptOffer`, `getDisbursementStatus`,
`listRepayments`, `verifyWebhook(raw, headers)` (null on a bad signature) and `lender` (name and grievance officer).
Factory `getCreditPartner()` from `CREDIT_PARTNER=mock|nbfc_partner` (default `mock`); an application remembers its partner.

* `mock`: deterministic and stateless. Declines below score 500, approves 60% below 550, otherwise the requested amount; APR
  falls as the score rises (36% at 500 to 12% from 900). The partner reference encodes amount, tenor and score so `getOffers` works
  across processes. `signedEvent` builds the exact signed webhook a real partner sends; the dev button feeds it through
  `handleCreditWebhook` (`simulateMockDisbursal`, refused in production unless `CREDIT_MOCK_CHECKOUT=1`).
* `nbfc_partner`: underwriting and money calls throw "Credit partner is not configured." Webhook verification is real
  (HMAC-SHA256 hex over the raw body in header `x-credit-signature`, secret `CREDIT_WEBHOOK_SECRET`).

**Data minimisation.** `buildPartnerRequest` is the only thing sent: application, amount and tenor, score, band, model version,
negative reason codes, a whitelist of features (verified/active flags, verification age, filed ratio, escrow counts and volume,
clean ratio, refunds, disputes, trust score) and an opaque escrow and order reference. No GSTIN, no GST returns, no contact details.
A test asserts none of those strings appear. The partner runs its own KYC in its journey.

## Flow

1. **Apply** (`applyForFinancing`): flag and consent checks, fresh score, eligibility (GST verified and active, score at or above
   `CREDIT_MIN_SCORE` 500 or `CREDIT_BNPL_MIN_SCORE` 550, escrow rules below, amount within the limit), one live application per
   (product, escrow) under an advisory lock. `CreditApplicationSubmitted` is emitted with the row; the partner call happens outside
   the transaction, and a partner outage marks the application `failed` (never offered).
2. **Offers** arrive synchronously or by `application.offered` webhook. Each is stored with its KFS and `CreditOfferReceived` is emitted.
3. **Explicit acceptance** (`acceptOffer`): separate action, requires a ticked "I have read the Key Fact Statement" and the KFS version
   shown, an open, unexpired offer, active consent, and the escrow still in the right state. One winner under concurrency; if the partner
   cannot confirm, the offer reopens. There is no auto-accept anywhere.
4. **Disbursal** by `loan.disbursed` webhook: creates the `credit_loans` mirror (only for an application the borrower explicitly
   accepted), emits `CreditDisbursed`, and for invoice financing records the assignment.
5. **Repayment** by `loan.repayment` webhook or by escrow settlement (below): idempotent per event, `CreditRepaid`; at zero outstanding
   the loan closes and `CreditClosed(repaid)` is emitted. `loan.overdue` and the hourly DPD job set days past due; `CreditOverdue`
   is emitted when a loan first crosses into the 1, 30, 60 or 90 day bucket. `loan.written_off` closes with `CreditClosed(written_off)`.

Escrow rules: **invoice financing** needs a `funded`, unfrozen escrow and the applicant must be its seller; **BNPL** needs a `created`
or `awaiting_funding`, unfrozen escrow and the applicant must be its buyer. Offers expire after `CREDIT_OFFER_TTL_HOURS` (48).

### Key Fact Statement (RBI digital lending guidelines)

Shown before acceptance in every UI: lender of record, amount, tenor, interest rate and all-in annualised cost (interest plus fees),
interest, processing and other fees, total repayable, late payment charge, cooling-off period (`CREDIT_COOLING_OFF_DAYS`, 3),
prepayment charge, how it is repaid, grievance officer (name, email, phone) and the offer expiry. Stored with the offer (`kfs-v1`)
so the borrower can later see exactly what they accepted. UI copy says the partner is the lender and cnote is not.

## Escrow contract for invoice financing (for the lead to wire in `@cnote/escrow`)

Invoice financing is repaid from the escrow release, and **the escrow module must pay the partner first**. `@cnote/credit` exports:

```ts
getPayoutAssignmentForEscrow(escrowId: string): Promise<null | {
  assignmentId: string; loanId: string; partner: string; partnerLoanRef: string; lenderName: string;
  dueToPartnerPaise: number;              // what the partner is still owed
}>;
recordAssignmentSettlement(i: { assignmentId: string; amountPaise: number; reference: string; at?: Date }): Promise<{ recorded: boolean }>;
```

Escrow side, where it creates the seller payout for a release: call `getPayoutAssignmentForEscrow(escrowId)`; when it returns a value,
pay `min(sellerNetPaise, dueToPartnerPaise)` to the partner as a separate payout (a new `lender_repayment` kind, journalled
`seller_payable -> partner_nodal` like any transfer, idempotent by payout id) and only the remainder to the seller. When that transfer
settles call `recordAssignmentSettlement({ assignmentId, amountPaise, reference: payoutId })` (idempotent by `reference`). Escrow
cannot import `@cnote/credit` (credit depends on escrow), so inject it with a port set by the composition root, the same way disputes
injects its escrow port. Credit already reacts to `EscrowReleased` (assignment `released`) and `EscrowRefunded` (assignment `cancelled`
when the escrow ends fully refunded; the borrower then repays the partner directly). A split dispute outcome repays from whatever is released.

**BNPL** is the mirror: the partner pays the escrow collect account on the buyer's behalf. On disbursal credit calls
`ports().fundEscrowFromLender(escrowId, amountPaise, loanId)` (idempotent by loan id; also retried every five minutes for any BNPL
loan whose escrow is still unfunded). The default is a no-op returning false until `@cnote/escrow` exports
`fundEscrowFromLender(escrowId, amountPaise, ref)` (record funding from a lender payout, same effect as a `collect.captured` webhook,
idempotent by `ref`) and the composition root injects it with `setCreditPorts`.

## Loan book, metrics, FLDG

* **Partner GNPA** (`partnerGnpa`, `overallGnpa`, `computeGnpa`): (outstanding on loans 90 or more days past due plus written-off
  amounts) over (outstanding on open loans plus written-off amounts). Repaid loans are excluded, write-offs stay in both parts so they
  never flatter the ratio. Target under 2% (`CREDIT_GNPA_TARGET_BPS`).
* **Credit-attached GMV** (`creditAttachedGmvShare({from,to})`): distinct escrowed orders with a loan disbursed in range, valued at the
  escrow amount at application, over `escrowStats().fundedPaise` for the range. Target at least 15% (`CREDIT_ATTACHED_GMV_TARGET_BPS`).
* `creditStats({from,to})`: applications, offered, accepted, rejected, disbursed, repaid, outstanding, overdue.
* **FLDG** (`fldgExposure`): per partner, cap = `CREDIT_FLDG_CAP_BPS` (500, 5%) of the originated principal, defaulted = 90+ DPD
  outstanding plus write-offs, exposure = min(cap, defaulted), headroom and utilisation. Read-only: nothing pays a guarantee claim automatically.

## Retention (DPDP)

`purgeClosedCreditData(before: Date)` deletes repaid and written-off loans closed before the cutoff with their repayments and
assignments, terminal applications (rejected, declined, expired, failed, cancelled, or whose loan was purged) with their offers and
partner-share audit rows, webhook inbox rows older than the cutoff, and score snapshots older than the cutoff except each business's
latest. Open loans and live applications are never touched. The retention period itself (and any RBI record-keeping duty, which the
lender holds on its own books) is a compliance decision.

## Flag behaviour

`CREDIT_ENABLED` off: consent grant, apply, accept, BNPL option, score recompute handlers and the nightly job refuse or do nothing;
the seller page says credit is not available and the buyer BNPL option is hidden. Webhooks, the loan-book mirror, DPD, offer expiry,
the assignment contract and `withdrawCreditConsent` are not gated: loans that exist keep moving and a person can always withdraw.

## UI

* Seller `(portal)/credit`: consent card, score with translated reasons, funded orders that can be financed (amount and period form),
  applications (offer card with the full KFS, acknowledgement checkbox, accept and decline), loans with repaid, outstanding, due date and DPD.
  Strings via next-intl namespace `credit` in eight locales.
* Buyer web: `BnplOption` inside the escrow panel (one mount line in `escrow-panel.tsx`), shown while the buyer's escrow is unfunded:
  consent checkbox and period, then the KFS and explicit accept, then status. Hidden when the flag is off.
* Admin `(console)/credit` (`credit.read`; actions need `credit.manage`, every one through `audited()`): partner book health with GNPA
  against target, credit-attached GMV, FLDG exposure, the score model and its components, applications and loans lists, recompute
  score for a business and refresh DPD and expiry.

WCAG 2.2 AA for the buyer surface: labelled section, real checkboxes with visible labels and 44px targets, definition list for the KFS,
status never by colour alone (text in every badge), polite live regions for errors, no motion.

### Design research (Mobbin)

Web patterns adopted:

* Klarna, "Buying an item" (https://mobbin.com/flows/9ad76fc9-865b-4bff-9841-ad1edc8edfb5) and "Order detail"
  (https://mobbin.com/flows/b7998015-eec7-4ffb-8ba8-0c9a327c5921): pay-later is an option shown at payment time with the amount due and the
  schedule stated plainly, and the order detail keeps subtotal and total as a short itemised block. We adopted the itemised KFS block
  (principal, interest, fees, total) and showing what is due and when.
* Zillow, "Finalize your lease" review-and-sign dialog (https://mobbin.com/screens/0db1bc75-d0fd-4596-9fe0-d6574ccf03f0): an irreversible
  commitment needs one explicit "review and sign" step with a plain sentence about what happens. We adopted a single explicit accept step
  with an acknowledgement checkbox, and a visible decline beside it, instead of one-tap acceptance.
* Dribbble, project payment (https://mobbin.com/screens/bd118195-d121-4631-978d-5c6b939b25e0): terms sit next to the payment and the copy
  states that money is held until approval. We adopted terms beside the action and a "nothing is charged until you accept" line.
* v0 plan picker (https://mobbin.com/screens/ef33a6d9-8d05-4ccc-8ba6-1f6b91f39e3a): a short fact list above one total and one primary button.
  We adopted the fact list, then the total repayable, then the single primary action.

## Environment

`CREDIT_ENABLED`, `CREDIT_PARTNER` (`mock`), `CREDIT_WEBHOOK_SECRET`, `CREDIT_MOCK_CHECKOUT`, `CREDIT_MIN_SCORE` (500), `CREDIT_BNPL_MIN_SCORE` (550),
`CREDIT_MIN_AMOUNT_PAISE` (500000), `CREDIT_OFFER_TTL_HOURS` (48), `CREDIT_COOLING_OFF_DAYS` (3), `CREDIT_LATE_FEE_BPS_PER_MONTH` (200),
`CREDIT_FLDG_CAP_BPS` (500), `CREDIT_GNPA_TARGET_BPS` (200), `CREDIT_ATTACHED_GMV_TARGET_BPS` (1500), and for the real adapter
`CREDIT_LENDER_NAME`, `CREDIT_GRIEVANCE_NAME`, `CREDIT_GRIEVANCE_EMAIL`, `CREDIT_GRIEVANCE_PHONE`.

## Requests for other modules

The default ports use the closest public function; these exact reads would replace them:

* `@cnote/escrow`: `escrowHistoryForBusiness(businessId)` returning `{ completed, completedPaise, clean, refunded }` (today `listEscrows`
  is one global page of at most 200 rows, so history for a busy marketplace is truncated); `listEscrowsForBusiness(businessId, { status })`
  (same reason, used for the seller's financeable orders); `fundEscrowFromLender(escrowId, amountPaise, ref)` and the payout-first hook above.
* `@cnote/disputes`: `disputeRecordForBusiness(businessId)` returning `{ lost, open }` (the public summary has no outcome, so `lost` is 0 here;
  the trust score already carries lost disputes).
* `@cnote/identity`: nothing required. `getGstEvidence` supplies status and filings.
* `@cnote/metrics`: call `partnerGnpa()` and `creditAttachedGmvShare()` for the two ADR-019 metrics.
* `@cnote/compliance`: register `purgeClosedCreditData(before)` in the retention registry.

## Open items

* Legal and partner contract: which NBFC, co-lending structure, FLDG terms, who does KYC and e-sign, and the real webhook format.
* Cooling-off exit is disclosed but not operated here: the partner port has no cancel-within-cooling-off call yet.
* Repayment schedule is a single bullet payment (one repayment by the due date); instalment schedules need the partner's schedule in the offer.
* Model calibration on real defaults and a golden-set eval gate before any weight change (Appendix C item 7).
* Partial release settlement: if escrow releases less than the amount due, the remainder stays with the borrower; collections are the lender's.

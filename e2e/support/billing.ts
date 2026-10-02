/** Shared by e2e/setup/seed-billing.ts (writes the accounts) and the seller billing spec (signs in with them). */
export const BILLING_E2E_PASSWORD = "BillingE2e#2026";
export const billingE2eEmail = (n: number) => `billing-cancel-${n}@example.com`;
/** One account per attempt (first run + retries); each is reset whenever the e2e database is prepared. */
export const BILLING_E2E_ACCOUNTS = 3;
/** Annual Starter: 959,040 + 18% GST paid, period began 40 days ago -> 2 months used, 10 unused (ADR-005). */
export const E2E_PAID_TOTAL_PAISE = 1_131_667;
export const E2E_EXPECTED_REFUND_PAISE = Math.floor((E2E_PAID_TOTAL_PAISE * 10) / 12);
/** Monthly Starter sellers for the one-tap undo spec (no refund is involved, so undo is allowed). */
export const billingUndoEmail = (n: number) => `billing-undo-${n}@example.com`;
export const BILLING_E2E_UNDO_ACCOUNTS = 2;

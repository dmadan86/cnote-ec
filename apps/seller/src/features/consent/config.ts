import type { AccountSyncOptions, ConsentConfig } from "@cnote/consent/client";
import { SELLER_CONSENT_COOKIE, SELLER_POLICY_VERSION, SELLER_STORAGE_REGISTRY } from "./registry";

/** Client-side consent config of the seller app (see @cnote/consent/client). Receipts go to POST /api/consent of THIS host. */
export const SELLER_CONSENT_CONFIG: ConsentConfig = {
  cookieName: SELLER_CONSENT_COOKIE,
  policyVersion: SELLER_POLICY_VERSION,
  registry: SELLER_STORAGE_REGISTRY,
  pendingKey: "seller_consent_pending",
  receiptPath: "/api/consent",
};

/** sessionStorage key marking that this visit was checked against the account ledger (registered as strictly necessary). */
export const SELLER_CONSENT_SYNC_KEY = "seller_consent_sync";

/** Account sync (signed-in sellers): GET /api/consent/account returns the ledger; the newer of cookie and ledger wins per purpose. */
export const SELLER_ACCOUNT_SYNC: AccountSyncOptions = { syncKey: SELLER_CONSENT_SYNC_KEY, accountPath: "/api/consent/account" };

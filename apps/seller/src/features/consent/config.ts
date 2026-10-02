import type { ConsentConfig } from "@cnote/consent/client";
import { SELLER_CONSENT_COOKIE, SELLER_POLICY_VERSION, SELLER_STORAGE_REGISTRY } from "./registry";

/** Client-side consent config of the seller app (see @cnote/consent/client). Receipts go to POST /api/consent of THIS host. */
export const SELLER_CONSENT_CONFIG: ConsentConfig = {
  cookieName: SELLER_CONSENT_COOKIE,
  policyVersion: SELLER_POLICY_VERSION,
  registry: SELLER_STORAGE_REGISTRY,
  pendingKey: "seller_consent_pending",
  receiptPath: "/api/consent",
};

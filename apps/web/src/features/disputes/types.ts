// Client-safe types + constants (labels.ts is server-only).
import type en from "../../../messages/en.disputes.json";
export type DisputeLabels = Record<keyof typeof en.disputes, string>;
export const DISPUTE_TYPES = ["non_delivery", "quality_mismatch", "quantity_short", "damaged", "wrong_item", "payment_issue", "other"] as const;

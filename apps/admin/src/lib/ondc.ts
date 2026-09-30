// @cnote/ondc with the enquiry order sink installed (composition root, ADR-006/017): ONDC orders mirror into platform
// Orders and inbox accept/reject keeps them in step. Import ONDC from here, not from "@cnote/ondc" directly.
import "server-only";
import { wireOndcOrderSink } from "@cnote/ondc";

wireOndcOrderSink();

export * from "@cnote/ondc";

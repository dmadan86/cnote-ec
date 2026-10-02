// Proof of control over a GSTIN (ADR-003): the registry lookup proves a GSTIN EXISTS and whose it is, not that the person
// typing it controls it. Name/state/PAN agreement raises the bar a lot, but the strongest proof is a one-time code sent by the
// GST system to the contact registered for that GSTIN (the GST portal's own taxpayer-OTP flow, offered by GSP/KYC vendors),
// entered by the person claiming it.
//
// This file is the PORT plus a development mock; it is deliberately not wired into verifyGstin yet. Production needs:
//   1. A GSP/KYC vendor that exposes "GSTIN OTP / taxpayer authentication" (e.g. a GSTN-registered GSP). Implement
//      GstControlProvider on top of it (start = request the OTP to the registered mobile/email, confirm = verify it).
//   2. Provider credentials in the secret store, DLT/consent copy for the registered contact, and per-GSTIN + per-person rate limits.
//   3. Call start/confirm from the verification forms and require a confirmed control proof (kind "gstin", details.control = true)
//      before verifyCompanyGst may grant tier 1 for a GSTIN whose name check is only borderline, or before a dispute is auto-resolved.
import { randomUUID } from "node:crypto";
import { DomainError } from "@cnote/core";

export interface GstControlChallenge {
  /** opaque handle to pass back to confirm() */
  ref: string;
  /** e.g. "+91XXXXXX1234" or "a***@example.com": where the code went, never the full contact */
  maskedContact: string;
}

export interface GstControlProvider {
  name: string;
  /** Ask the GST system to send a one-time code to the contact registered for `gstin`. */
  start(gstin: string): Promise<GstControlChallenge>;
  /** True when `code` is the code sent for `ref`. */
  confirm(ref: string, code: string): Promise<boolean>;
}

/** Dev/CI only: every challenge accepts the code 123456. Refuses to run in production so it can never "prove" anything there. */
export const mockGstControlProvider: GstControlProvider = {
  name: "mock-control",
  async start() {
    if (process.env.NODE_ENV === "production") throw new DomainError("validation", "GSTIN ownership checks are not configured.");
    return { ref: randomUUID(), maskedContact: "+91XXXXXX0000" };
  },
  async confirm(ref, code) {
    if (process.env.NODE_ENV === "production") return false;
    return !!ref && code.trim() === "123456";
  },
};

let provider: GstControlProvider = mockGstControlProvider;
export const getGstControlProvider = (): GstControlProvider => provider;
export const setGstControlProvider = (p: GstControlProvider | null) => void (provider = p ?? mockGstControlProvider);

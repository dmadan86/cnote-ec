// @cnote/leadgen — buyer lead capture from gated, high-intent actions unlocked by phone OTP.
// Lifecycle: started -> otp_sent -> verified -> converted | abandoned. Only sha256(phone) is stored here.
// PUBLIC CONTRACT. Extend, don't break.
export * from "./types";
export { startCapture, markOtpSent, markVerified, markConverted, getCapture } from "./capture";
export { completeUnlock } from "./unlock";
export { funnelByTriggerDay, type FunnelRow } from "./funnel";
export { sweepAbandoned, ABANDON_AFTER_MS } from "./abandon";
export { worker } from "./worker";
export * from "./retention";
export { getUnlockedSupplierContact, recordSupplierContacted, CONTACT_CHANNELS, type ContactChannel, type SupplierContact } from "./contact";

// DPDP access right: registered with @cnote/compliance's export registry (security audit M10).
export { exportPersonalData } from "./privacy";

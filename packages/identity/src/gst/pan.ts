// PAN at rest (ADR-010 / DPDP): envelope-encrypted with @cnote/security field encryption, bound to the
// business via the AAD context "business.pan:<id>". SINGLE CALL SITE: every read/write of Business.pan goes
// through these two functions; all views show the masked form only.
import { decryptField, encryptField } from "@cnote/security";

const ctx = (businessId: string) => `business.pan:${businessId}`;

export const sealPan = (pan: string, businessId: string): Promise<string> => encryptField(pan, ctx(businessId));

/** null when nothing is stored or it cannot be decrypted (caller then shows a fully masked placeholder). */
export async function openPan(stored: string | null, businessId: string): Promise<string | null> {
  if (!stored) return null;
  try {
    return await decryptField(stored, ctx(businessId));
  } catch {
    return null;
  }
}

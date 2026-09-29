// GSTIN structure + mod-36 checksum. Client-side feedback only: a valid checksum does not prove the GSTIN
// is active; the server verifies with the GSTN provider (identity.verifyGstin, ADR-003).
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PATTERN = /^(0[1-9]|[1-3][0-9])[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function normalizeGstin(v: string): string {
  return v.replace(/\s+/g, "").toUpperCase();
}

export function gstinChecksumChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36]!;
}

export type GstinCheck = { ok: true } | { ok: false; message: string };

export function checkGstin(raw: string): GstinCheck {
  const v = normalizeGstin(raw);
  if (v.length < 15) return { ok: false, message: `${v.length} of 15 characters` };
  if (v.length > 15) return { ok: false, message: "GSTIN has 15 characters" };
  if (!PATTERN.test(v)) return { ok: false, message: "This does not look like a GSTIN. Check the letters and digits." };
  if (gstinChecksumChar(v.slice(0, 14)) !== v[14]) return { ok: false, message: "Last character does not match. Check for a typing mistake." };
  return { ok: true };
}

/** Udyam registration number, e.g. UDYAM-KA-03-0012345. */
export const UDYAM_PATTERN = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/;

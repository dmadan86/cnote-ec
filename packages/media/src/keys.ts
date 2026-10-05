// Generic object keys shared by every driver and every module (listings, template assets, storefronts).
// Lowercase only, so keys behave identically on case-insensitive disks and case-sensitive object stores.

const MEDIA_KEY_RE = /^(listings|templates|storefronts|bulk|invoices|kyc|disputes|quality|rfq|samples)\/[a-z0-9/_.-]+$/;

/**
 * Prefixes that may only ever live in the PRIVATE bucket: product sheets (prices/SKUs), voice recordings, GST invoices
 * KYC documents, dispute evidence and dispatch-quality photos are personal or commercially sensitive and must never be publicly addressable.
 */
const PRIVATE_ONLY = ["bulk/", "listings/_voice/", "invoices/", "kyc/", "disputes/", "quality/", "rfq/", "samples/"];

/**
 * Safe key: allowed prefix, restricted charset, no empty/dot segments (no traversal), bounded length, has an extension.
 * `bulk/` holds sellers' uploaded/exported product sheets (prices, SKUs): only ever valid in the PRIVATE bucket.
 */
export function isValidMediaKey(key: string, bucket?: MediaBucket): boolean {
  if (key.length > 300 || !MEDIA_KEY_RE.test(key)) return false;
  // Private-only content: product sheets and voice recordings (personal data under DPDP) are never publicly addressable.
  if (bucket === "public" && PRIVATE_ONLY.some((p) => key.startsWith(p))) return false;
  const segs = key.split("/");
  if (segs.some((s) => s === "" || s.startsWith("."))) return false;
  return /\.[a-z0-9]{2,5}$/.test(key);
}

export function assertMediaKey(key: string, bucket?: MediaBucket): void {
  if (!isValidMediaKey(key, bucket)) throw new Error("Invalid media key");
}

export const KEY_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  // Bulk import/export documents (private bucket only, see isValidMediaKey).
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
  pdf: "application/pdf",
  // Seller voice notes (private bucket only, see isValidMediaKey).
  ogg: "audio/ogg",
  opus: "audio/opus",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  webm: "audio/webm",
};

export const keyExt = (key: string): string => key.slice(key.lastIndexOf(".") + 1);
export const mimeForKey = (key: string): string => KEY_MIME[keyExt(key)] ?? "application/octet-stream";

/** Which logical bucket a store handle points at. */
export type MediaBucket = "private" | "public";

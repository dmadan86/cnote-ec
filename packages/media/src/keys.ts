// Generic object keys shared by every driver and every module (listings, template assets, storefronts).
// Lowercase only, so keys behave identically on case-insensitive disks and case-sensitive object stores.

const MEDIA_KEY_RE = /^(listings|templates|storefronts|bulk)\/[a-z0-9/_.-]+$/;

/**
 * Safe key: allowed prefix, restricted charset, no empty/dot segments (no traversal), bounded length, has an extension.
 * `bulk/` holds sellers' uploaded/exported product sheets (prices, SKUs): only ever valid in the PRIVATE bucket.
 */
export function isValidMediaKey(key: string, bucket?: MediaBucket): boolean {
  if (key.length > 300 || !MEDIA_KEY_RE.test(key)) return false;
  if (bucket === "public" && key.startsWith("bulk/")) return false;
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
};

export const keyExt = (key: string): string => key.slice(key.lastIndexOf(".") + 1);
export const mimeForKey = (key: string): string => KEY_MIME[keyExt(key)] ?? "application/octet-stream";

/** Which logical bucket a store handle points at. */
export type MediaBucket = "private" | "public";

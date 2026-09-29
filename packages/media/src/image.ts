import { createHash } from "node:crypto";

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";
export const IMAGE_EXT: Record<ImageMime, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MIN_DIMENSION = 200;
export const MAX_DIMENSION = 6000;

/** Detect the real type from magic bytes. Never trust the client-supplied content-type or filename. */
export function sniffImageMime(b: Uint8Array): ImageMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  return null;
}

function ascii(b: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < to && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}
const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);

export interface Dimensions {
  width: number;
  height: number;
}

function jpegSize(b: Uint8Array): Dimensions | null {
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    let marker = b[o + 1]!;
    while (marker === 0xff && o + 2 < b.length) { o++; marker = b[o + 1]!; } // fill bytes
    o += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any SOF
    if (o + 2 > b.length) return null;
    const len = u16be(b, o);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (o + 7 > b.length) return null;
      return { height: u16be(b, o + 3), width: u16be(b, o + 5) };
    }
    o += len;
  }
  return null;
}

function pngSize(b: Uint8Array): Dimensions | null {
  if (b.length < 24 || ascii(b, 12, 16) !== "IHDR") return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function webpSize(b: Uint8Array): Dimensions | null {
  if (b.length < 30) return null;
  const fourcc = ascii(b, 12, 16);
  if (fourcc === "VP8 ") {
    // frame tag (3) + start code 9d 01 2a + 14-bit w/h
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff };
  }
  if (fourcc === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (fourcc === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  return null;
}

/** Width/height from the file header, no decoding. Null when the header is malformed/truncated. */
export function readImageDimensions(b: Uint8Array, mime: ImageMime): Dimensions | null {
  const d = mime === "image/jpeg" ? jpegSize(b) : mime === "image/png" ? pngSize(b) : webpSize(b);
  return d && d.width > 0 && d.height > 0 ? d : null;
}

export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export interface ValidatedImage {
  mime: ImageMime;
  ext: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

export class ImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageValidationError";
  }
}

/** Throws ImageValidationError with a seller-presentable message. */
export function validateImage(b: Uint8Array): ValidatedImage {
  if (b.length === 0) throw new ImageValidationError("The file is empty");
  if (b.length > MAX_IMAGE_BYTES) throw new ImageValidationError("Image is larger than 5 MB");
  const mime = sniffImageMime(b);
  if (!mime) throw new ImageValidationError("Only JPEG, PNG or WebP images are allowed");
  const dim = readImageDimensions(b, mime);
  if (!dim) throw new ImageValidationError("Could not read the image; the file may be corrupt");
  if (dim.width < MIN_DIMENSION || dim.height < MIN_DIMENSION) throw new ImageValidationError(`Image must be at least ${MIN_DIMENSION}x${MIN_DIMENSION} pixels`);
  if (dim.width > MAX_DIMENSION || dim.height > MAX_DIMENSION) throw new ImageValidationError(`Image must be at most ${MAX_DIMENSION}x${MAX_DIMENSION} pixels`);
  return { mime, ext: IMAGE_EXT[mime], width: dim.width, height: dim.height, bytes: b.length, sha256: sha256Hex(b) };
}

const KEY_RE = /^listings\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;
export const isValidListingImageKey = (k: string) => KEY_RE.test(k);

/** listings/<listingId>/<imageId>.<ext>; ids must be UUIDs (filenames are never used in keys). */
export function listingImageKey(listingId: string, imageId: string, ext: string): string {
  const key = `listings/${listingId.toLowerCase()}/${imageId.toLowerCase()}.${ext}`;
  if (!KEY_RE.test(key)) throw new Error("invalid listing image key");
  return key;
}

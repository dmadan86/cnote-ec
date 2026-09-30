// Photo → listing draft support (ADR-004/008): input validation, audit shape, and the offline heuristic provider.
import { createHash } from "node:crypto";
import { DomainError } from "@cnote/core";
import type { ExtractListingFromImagesInput, ExtractListingFromImagesOutput } from "./index";
import { extractListingHeuristic } from "./heuristic/extract";
import { HEURISTIC_MODEL } from "./heuristic/intent";
import type { ProviderResult } from "./types";

export const MAX_VISION_IMAGES = 4;
export const VISION_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export const VISION_MAX_LONG_EDGE = 1568;
export const EXTRACT_IMAGE_HEURISTIC_VERSION = "extract-image-heuristic-v1";
/** Without vision the heuristic can only echo the seller's hint; keep it below every review threshold. */
export const HEURISTIC_IMAGE_MAX_CONFIDENCE = 0.3;

const has = (b: Uint8Array, at: number, s: string) => s.split("").every((c, i) => b[at + i] === c.charCodeAt(0));

/** True when the bytes still carry an EXIF block (JPEG APP1, PNG eXIf, WebP EXIF chunk). Callers must strip first. */
export function hasExifMetadata(b: Uint8Array, mime: string): boolean {
  if (mime === "image/jpeg") {
    let o = 2;
    while (o + 4 <= b.length && b[o] === 0xff) {
      const marker = b[o + 1]!;
      if (marker === 0xda || marker === 0xd9) return false; // pixel data starts; no more metadata segments
      if (marker === 0xe1 && has(b, o + 4, "Exif")) return true;
      o += 2 + ((b[o + 2]! << 8) | b[o + 3]!);
    }
    return false;
  }
  if (mime === "image/png") {
    for (let o = 8; o + 8 <= b.length; o += 12 + new DataView(b.buffer, b.byteOffset + o, 4).getUint32(0)) {
      if (has(b, o + 4, "eXIf")) return true;
    }
    return false;
  }
  for (let o = 12; o + 8 <= b.length;) {
    const size = new DataView(b.buffer, b.byteOffset + o + 4, 4).getUint32(0, true);
    if (has(b, o, "EXIF")) return true;
    o += 8 + size + (size & 1); // RIFF chunks are padded to even length
  }
  return false;
}

/** Magic-byte check so a mislabeled file never reaches the vendor. */
const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => has(b, 1, "PNG"),
  "image/webp": (b) => has(b, 0, "RIFF") && has(b, 8, "WEBP"),
};

export function assertVisionImages(images: ExtractListingFromImagesInput["images"]): void {
  if (images.length < 1 || images.length > MAX_VISION_IMAGES) throw new DomainError("validation", `Send 1 to ${MAX_VISION_IMAGES} photos`);
  for (const im of images) {
    const check = MAGIC[im.mimeType];
    if (!check) throw new DomainError("validation", "Photos must be JPEG, PNG or WebP");
    if (!im.bytes.length || !check(im.bytes)) throw new DomainError("validation", "A photo is empty or not the type it claims to be");
    if (Math.max(im.width ?? 0, im.height ?? 0) > VISION_MAX_LONG_EDGE * 2) throw new DomainError("validation", "Photo is too large; resize before sending");
    if (hasExifMetadata(im.bytes, im.mimeType)) throw new DomainError("validation", "Photo still contains EXIF metadata; strip it before sending");
  }
}

/** Audit shape: never the bytes, only hash + size + dimensions. */
export function imageAudit(input: ExtractListingFromImagesInput) {
  return {
    images: input.images.map((im) => ({
      sha256: createHash("sha256").update(im.bytes).digest("hex"), mimeType: im.mimeType, bytes: im.bytes.length,
      width: im.width ?? null, height: im.height ?? null,
    })),
    hintText: input.hintText ?? null, language: input.language, categories: input.categories.map((c) => c.slug),
  };
}

/** No vision offline: derive what we can from the hint, always low confidence so a human reviews it. */
export function extractFromImagesHeuristic(input: ExtractListingFromImagesInput): ProviderResult<ExtractListingFromImagesOutput> {
  const hint = input.hintText?.trim() ?? "";
  const base = hint
    ? extractListingHeuristic({ text: hint, language: input.language, categories: input.categories })
    : null;
  const o = base?.output ?? { title: "Untitled product", description: "", categorySlug: null, attributes: {}, pricePaise: null, priceUnit: null, moq: null, moqUnit: null, hsn: null };
  return {
    output: { ...o, visualAttributes: {}, detected: { productType: hint ? o.title : "", quantityVisible: null } },
    confidence: Math.min(HEURISTIC_IMAGE_MAX_CONFIDENCE, base?.confidence ?? 0.1),
    provider: "heuristic", modelId: HEURISTIC_MODEL, promptVersion: EXTRACT_IMAGE_HEURISTIC_VERSION,
  };
}

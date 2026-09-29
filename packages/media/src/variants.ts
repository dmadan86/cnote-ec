// Responsive image pipeline: original bytes -> resized AVIF/WebP/JPEG derivatives + a tiny blur placeholder.
// Pure (no I/O): callers persist the returned buffers. All metadata (EXIF, GPS, ICC, XMP) is stripped - sharp drops
// it unless withMetadata()/keepMetadata() is called, and we never call either. Orientation is baked in via rotate().
import sharp, { type Sharp } from "sharp";
import { assertMediaKey } from "./keys";

export const VARIANT_WIDTHS = [160, 320, 640, 960, 1280, 1920] as const;
export type VariantFormat = "avif" | "webp" | "jpeg";
export const VARIANT_FORMATS: readonly VariantFormat[] = ["avif", "webp", "jpeg"];

export const VARIANT_EXT: Record<VariantFormat, string> = { avif: "avif", webp: "webp", jpeg: "jpg" };
export const VARIANT_MIME: Record<VariantFormat, string> = { avif: "image/avif", webp: "image/webp", jpeg: "image/jpeg" };

/** Quality presets (visually similar output across formats; AVIF is smallest, JPEG is the universal fallback). */
export const QUALITY_PRESETS = {
  avif: { quality: 50, effort: 4 },
  webp: { quality: 78, effort: 4 },
  jpeg: { quality: 80, mozjpeg: true },
} as const;

export const BLUR_MAX_CHARS = 1024;
/** Decompression-bomb guard; uploads are already capped at 6000x6000 (36 MP). */
const MAX_INPUT_PIXELS = 6000 * 6000 + 1;

export interface ImageVariant {
  width: number;
  height: number;
  format: VariantFormat;
  key: string;
  bytes: number;
  contentType: string;
  data: Uint8Array;
}

export interface ProcessedImage {
  /** Dimensions after auto-orientation. */
  width: number;
  height: number;
  variants: ImageVariant[];
  /** data: URL, at most BLUR_MAX_CHARS characters. */
  blurDataUrl: string;
}

/** `listings/<listingId>/<imageId>/<width>.<ext>` */
export function variantKey(listingId: string, imageId: string, width: number, format: VariantFormat): string {
  const key = `listings/${listingId.toLowerCase()}/${imageId.toLowerCase()}/${width}.${VARIANT_EXT[format]}`;
  assertMediaKey(key);
  return key;
}

/** Parse a variant key/URL tail back into its parts (used by the next/image loader). */
export function parseVariantPath(p: string): { dir: string; width: number; ext: string } | null {
  const m = /^(.*\/listings\/[0-9a-f-]{36}\/[0-9a-f-]{36})\/(\d{2,4})\.(avif|webp|jpg)(?:\?.*)?$/.exec(p);
  return m ? { dir: m[1]!, width: Number(m[2]), ext: m[3]! } : null;
}

async function encode(base: Sharp, width: number, format: VariantFormat): Promise<{ data: Buffer; width: number; height: number }> {
  let p = base.clone().resize({ width, withoutEnlargement: true }).toColourspace("srgb");
  p = format === "avif" ? p.avif(QUALITY_PRESETS.avif) : format === "webp" ? p.webp(QUALITY_PRESETS.webp) : p.jpeg(QUALITY_PRESETS.jpeg);
  const { data, info } = await p.toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function blurPlaceholder(base: Sharp): Promise<string> {
  for (const [w, q] of [[16, 30], [12, 25], [8, 20], [6, 15], [4, 10]] as const) {
    const buf = await base.clone().resize({ width: w }).toColourspace("srgb").webp({ quality: q, effort: 6 }).toBuffer();
    const url = `data:image/webp;base64,${buf.toString("base64")}`;
    if (url.length <= BLUR_MAX_CHARS) return url;
  }
  // 1x1 neutral grey; unreachable in practice.
  return "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";
}

export interface ProcessOptions {
  widths?: readonly number[];
  formats?: readonly VariantFormat[];
}

/**
 * Produce every (width x format) derivative <= the original width (never upscales; a 700 px original yields
 * 160/320/640) plus the blur placeholder. Throws on undecodable input.
 */
export async function processImage(original: Uint8Array, ids: { listingId: string; imageId: string }, opts: ProcessOptions = {}): Promise<ProcessedImage> {
  const widths = [...(opts.widths ?? VARIANT_WIDTHS)].sort((a, b) => a - b);
  const formats = opts.formats ?? VARIANT_FORMATS;
  const base = sharp(original, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).rotate(); // rotate() = auto-orient by EXIF, then EXIF is dropped
  const meta = await base.metadata();
  if (!meta.width || !meta.height) throw new Error("Could not read image dimensions");
  const swap = (meta.orientation ?? 1) >= 5;
  const width = swap ? meta.height : meta.width;
  const height = swap ? meta.width : meta.height;

  const variants: ImageVariant[] = [];
  for (const w of widths.filter((x) => x <= width)) {
    for (const format of formats) {
      const out = await encode(base, w, format);
      variants.push({
        width: out.width,
        height: out.height,
        format,
        key: variantKey(ids.listingId, ids.imageId, out.width, format),
        bytes: out.data.length,
        contentType: VARIANT_MIME[format],
        data: new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength),
      });
    }
  }
  if (!variants.length) throw new Error("Image is smaller than the smallest variant width");
  return { width, height, variants, blurDataUrl: await blurPlaceholder(base) };
}

/** Solid-colour JPEG (fixtures, placeholders). */
export async function solidJpeg(width: number, height: number, rgb: [number, number, number] = [128, 128, 128]): Promise<Uint8Array> {
  const buf = await sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).jpeg().toBuffer();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

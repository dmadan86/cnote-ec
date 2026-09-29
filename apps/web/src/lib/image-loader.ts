// Custom next/image loader for our pre-generated variants (`.../listings/<listingId>/<imageId>/<width>.<ext>`).
// Instead of the on-demand /_next/image optimiser, it picks the nearest pre-built width (>= the requested one,
// capped at the largest) and keeps the format, so the CDN serves an immutable, already-optimised file.
// Anything that is not a variant URL (route fallback, external art) is returned untouched.
// Client-safe: no server imports. Widths must match VARIANT_WIDTHS in @cnote/media.
export const VARIANT_WIDTHS = [160, 320, 640, 960, 1280, 1920] as const;

const VARIANT_RE = /^(.*\/listings\/[0-9a-f-]{36}\/[0-9a-f-]{36})\/(\d{2,4})\.(avif|webp|jpg)(\?.*)?$/;

export function nearestVariantWidth(requested: number, available: readonly number[] = VARIANT_WIDTHS): number {
  return available.find((w) => w >= requested) ?? available[available.length - 1]!;
}

export default function variantImageLoader({ src, width }: { src: string; width: number; quality?: number }): string {
  const m = VARIANT_RE.exec(src);
  if (!m) return src;
  return `${m[1]}/${nearestVariantWidth(width)}.${m[3]}${m[4] ?? ""}`;
}

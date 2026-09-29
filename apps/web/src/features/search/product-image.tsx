import { Package } from "lucide-react";
import Image from "next/image";

/**
 * Listing image inside a positioned (relative, sized) parent.
 * - Uploaded photos (/media/listing-images/…) go through the next/image optimiser (AVIF/WebP, responsive srcset).
 * - Seed placeholders are local SVGs, which the optimiser must not touch, hence `unoptimized` for those only.
 * - `priority` = above-the-fold (eager + fetchPriority high); `preload` additionally emits <link rel=preload> (use for the single LCP image).
 * - `alt` defaults to "" (decorative) because cards sit inside a link that already carries the product name.
 */
export function ProductImage({ src, sizes, priority = false, preload = false, alt = "" }: { src: string | undefined; sizes: string; priority?: boolean; preload?: boolean; alt?: string }) {
  if (!src) {
    return (
      <div className="flex size-full items-center justify-center text-muted" role={alt ? "img" : undefined} aria-label={alt || undefined}>
        <Package className="size-10" aria-hidden />
      </div>
    );
  }
  const svg = src.split("?")[0]!.endsWith(".svg");
  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes={sizes}
      unoptimized={svg}
      className="object-contain p-2"
      {...(preload ? { preload: true } : priority ? { loading: "eager" as const, fetchPriority: "high" as const } : {})}
    />
  );
}

import { Package } from "lucide-react";
import { BlurImage } from "@/features/media/blur-image";

/**
 * Listing image inside a positioned (relative, sized) parent.
 * - Uploaded photos (/media/listing-images/…) go through the next/image optimiser (AVIF/WebP, responsive srcset).
 * - Seed placeholders are local SVGs, which the optimiser must not touch, hence `unoptimized` for those only.
 * - `priority` = above-the-fold (eager + fetchPriority high); `preload` additionally emits <link rel=preload> (use for the single LCP image).
 * - `blur` = tiny blur-up data URL from the media pipeline (listing.imageBlurs[i]); shown until the image loads (see BlurImage).
 * - `alt` defaults to "" (decorative) because cards sit inside a link that already carries the product name.
 */
export function ProductImage({ src, sizes, priority = false, preload = false, alt = "", blur = null }: { src: string | undefined; sizes: string; priority?: boolean; preload?: boolean; alt?: string; blur?: string | null }) {
  if (!src) {
    return (
      <div className="flex size-full items-center justify-center text-muted" role={alt ? "img" : undefined} aria-label={alt || undefined}>
        <Package className="size-10" aria-hidden />
      </div>
    );
  }
  return <BlurImage src={src} alt={alt} sizes={sizes} blurDataUrl={blur} priority={priority} preload={preload} className="object-contain p-2" />;
}

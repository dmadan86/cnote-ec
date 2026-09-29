import { Package } from "lucide-react";
import Image from "next/image";

/**
 * Listing image inside a positioned (relative, sized) parent. Seed images are local SVGs, which
 * next/image cannot optimise, hence `unoptimized`. Falls back to an icon when there is no image.
 */
export function ProductImage({ src, sizes, priority = false }: { src: string | undefined; sizes: string; priority?: boolean }) {
  if (!src) {
    return (
      <div className="flex size-full items-center justify-center text-muted">
        <Package className="size-10" aria-hidden />
      </div>
    );
  }
  return <Image src={src} alt="" fill sizes={sizes} unoptimized className="object-contain p-2" priority={priority} />;
}

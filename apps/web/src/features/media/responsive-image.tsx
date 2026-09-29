import type { CSSProperties } from "react";

/** Structural twin of `PublicListingImage` from @cnote/catalogue (kept local so this stays client-safe). */
export interface ResponsiveImageData {
  src: string;
  srcSet: string;
  width: number;
  height: number;
  blurDataUrl: string | null;
  alt: string;
  /** AVIF / WebP <source> sets; empty until the image has been processed. */
  sources?: { type: string; srcSet: string }[];
}

export interface ResponsiveImageProps {
  image: ResponsiveImageData;
  /** CSS sizes hint, e.g. "(min-width: 1024px) 33vw, 50vw". Drives which width the browser downloads. */
  sizes?: string;
  /** Above-the-fold hero image: eager + high fetch priority. Everything else lazy-loads. */
  priority?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Overrides image.alt (pass "" for purely decorative use). */
  alt?: string;
}

/**
 * <picture> with AVIF/WebP sources + JPEG fallback, srcset/sizes, intrinsic width/height (no layout shift) and a blur
 * placeholder painted as the background until the bytes arrive. Unprocessed images degrade to a plain <img>.
 * Server component; no client JS.
 */
export function ResponsiveImage({ image, sizes = "(min-width: 1024px) 50vw, 100vw", priority = false, className, style, alt }: ResponsiveImageProps) {
  const bg: CSSProperties = image.blurDataUrl ? { backgroundImage: `url("${image.blurDataUrl}")`, backgroundSize: "cover", backgroundPosition: "center" } : {};
  const hasSet = image.srcSet !== "";
  return (
    <picture>
      {(image.sources ?? []).map((s) => (
        <source key={s.type} type={s.type} srcSet={s.srcSet} sizes={sizes} />
      ))}
      {/* eslint-disable-next-line @next/next/no-img-element -- pre-generated variants; the <picture> art direction is the optimiser */}
      <img
        src={image.src}
        srcSet={hasSet ? image.srcSet : undefined}
        sizes={hasSet ? sizes : undefined}
        width={image.width || undefined}
        height={image.height || undefined}
        alt={alt ?? image.alt ?? ""}
        loading={priority ? "eager" : "lazy"}
        decoding={priority ? "sync" : "async"}
        fetchPriority={priority ? "high" : "auto"}
        className={className}
        style={{ ...bg, maxWidth: "100%", height: "auto", ...style }}
      />
    </picture>
  );
}

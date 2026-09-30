"use client";

import Image from "next/image";
import type { CSSProperties } from "react";

export interface BlurImageProps {
  src: string;
  /** Empty string = decorative. */
  alt: string;
  sizes?: string;
  /** Intrinsic size for flow-layout images (no `fill`, no shimmer). Omit both to fill a positioned parent. */
  width?: number;
  height?: number;
  style?: CSSProperties;
  /** Tiny blur data URL from the media pipeline (@cnote/media `blurDataUrl`). Falls back to a neutral shimmer when absent. */
  blurDataUrl?: string | null;
  /** Above-the-fold: eager + high fetch priority. Everything else lazy-loads. */
  priority?: boolean;
  /** Additionally emit <link rel=preload>; use for the single LCP image. */
  preload?: boolean;
  className?: string;
}

/**
 * Blur-up image for a positioned (relative, sized) parent: zero layout shift (`fill`), lazy by default, a tiny blurred
 * placeholder shows at once and the image de-blurs when loaded. Images that already finished before hydration (or when JS
 * is off) are never hidden: the pending state is set imperatively only for images still loading. The transition and the
 * shimmer are switched off under prefers-reduced-motion (WCAG 2.2 SC 2.3.3 / 2.2.2). SVG art (seed illustrations) is served
 * as-is (no optimiser) and gets no blur placeholder.
 */
export function BlurImage({ src, alt, sizes, blurDataUrl, priority = false, preload = false, className = "", width, height, style }: BlurImageProps) {
  const svg = src.split("?")[0]!.endsWith(".svg");
  const fill = !(width && height);
  const blur = !svg && blurDataUrl ? blurDataUrl : null;
  return (
    <>
      <Image
        src={src}
        alt={alt}
        {...(width && height ? { width, height } : { fill: true as const })}
        style={style}
        sizes={sizes}
        unoptimized={svg}
        {...(blur ? { placeholder: "blur" as const, blurDataURL: blur } : {})}
        {...(preload ? { preload: true } : priority ? { loading: "eager" as const, fetchPriority: "high" as const } : {})}
        className={`peer transition-[filter] duration-300 ease-out motion-reduce:transition-none data-pending:blur-md ${className}`}
        ref={(el) => {
          if (el && !el.complete) el.dataset.pending = "";
        }}
        onLoad={(e) => {
          delete e.currentTarget.dataset.pending;
        }}
        onError={(e) => {
          delete e.currentTarget.dataset.pending;
        }}
        data-blur-image=""
      />
      {blur || !fill ? null : <span aria-hidden className="pointer-events-none absolute inset-0 hidden animate-pulse bg-line/40 peer-data-pending:block motion-reduce:animate-none" />}
    </>
  );
}

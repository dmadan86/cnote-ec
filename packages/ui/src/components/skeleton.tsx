import type { HTMLAttributes } from "react";
import { cn } from "../cn";

export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn("animate-pulse rounded-lg bg-line/70", className)} {...rest} />;
}

/** Placeholder matching ProductCard's footprint (no layout shift). */
export function ProductCardSkeleton() {
  return (
    <div className="rounded-card border border-line bg-surface p-2.5" aria-hidden>
      <Skeleton className="aspect-square w-full" />
      <Skeleton className="mt-3 h-4 w-3/4" />
      <Skeleton className="mt-2 h-4 w-1/2" />
      <Skeleton className="mt-2 h-3 w-2/3" />
    </div>
  );
}

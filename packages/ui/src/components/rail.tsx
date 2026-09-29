import type { HTMLAttributes } from "react";
import { cn } from "../cn";

/** Horizontal scroll rail below `sm`, grid from `sm` up (override columns via className, e.g. `xl:grid-cols-8`). */
export function Rail({ className, ...rest }: HTMLAttributes<HTMLUListElement>) {
  return (
    <ul
      className={cn(
        "-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-3 sm:snap-none sm:overflow-visible sm:px-0 sm:pb-0",
        "[&>*]:w-40 [&>*]:shrink-0 [&>*]:snap-start sm:[&>*]:w-auto sm:[&>*]:shrink",
        className,
      )}
      {...rest}
    />
  );
}

/** Responsive product-style grid. */
export function Grid({ className, cols = 4, ...rest }: HTMLAttributes<HTMLUListElement> & { cols?: 2 | 3 | 4 }) {
  return (
    <ul
      className={cn(
        "grid grid-cols-2 gap-3 sm:gap-4",
        cols === 2 && "md:grid-cols-2",
        cols === 3 && "md:grid-cols-3",
        cols === 4 && "md:grid-cols-3 lg:grid-cols-4",
        className,
      )}
      {...rest}
    />
  );
}

export function SectionHeader({ title, action, className, id }: { title: React.ReactNode; action?: React.ReactNode; className?: string; id?: string }) {
  return (
    <div className={cn("mb-4 flex items-end justify-between gap-4", className)}>
      <h2 id={id} className="text-xl font-bold tracking-tight text-ink sm:text-[22px]">
        {title}
      </h2>
      {action ? <div className="shrink-0 text-sm font-medium">{action}</div> : null}
    </div>
  );
}

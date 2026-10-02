import { Button, Input, LinkTabs, Select, cn } from "@cnote/ui";
import Link from "next/link";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

/**
 * Shared filter-bar primitives for the back office. Every control and button in a bar is the same height at every
 * breakpoint (`h-9 lg:h-9`: the `lg:` twin makes tailwind-merge drop the `@cnote/ui` `lg:h-10` / `lg:h-8` defaults),
 * labels sit above the control, and the bar bottom-aligns so a lone checkbox or button lines up with the inputs.
 */
export const FILTER_CONTROL_HEIGHT = "h-9 lg:h-9";

const WIDTHS = {
  xs: "sm:w-28",
  sm: "sm:w-36",
  md: "sm:w-44",
  lg: "sm:w-56",
  xl: "sm:w-72",
  "2xl": "sm:w-80",
} as const;
export type FilterWidth = keyof typeof WIDTHS;

/** A GET form that filters the page through the query string. Keep hidden inputs for params owned by other filters. */
export function FilterBar({
  label,
  action,
  search = true,
  className,
  children,
}: {
  label: string;
  action?: string;
  /** Marks the form as a search landmark (default). */
  search?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <form method="get" action={action} role={search ? "search" : undefined} aria-label={label} className={cn("flex flex-wrap items-end gap-3", className)}>
      {children}
    </form>
  );
}

/** Label above the control. Wrap a `FilterInput` / `FilterSelect` (the label wraps it, so the association is implicit). */
export function FilterField({ label, width = "md", className, children }: { label: ReactNode; width?: FilterWidth; className?: string; children: ReactNode }) {
  return (
    <label className={cn("flex w-full flex-col gap-1 text-xs font-medium text-muted", WIDTHS[width], className)}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function FilterInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <Input className={cn(FILTER_CONTROL_HEIGHT, className)} {...rest} />;
}

export function FilterSelect({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <Select className={cn(FILTER_CONTROL_HEIGHT, className)} {...rest} />;
}

/** A checkbox with its label, centred to the same height as the controls. */
export function FilterCheckbox({ label, className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode }) {
  return (
    <label className={cn("flex items-center gap-2 text-sm font-medium text-ink", FILTER_CONTROL_HEIGHT, className)}>
      <input type="checkbox" className="size-4 shrink-0 accent-brand-600" {...rest} />
      {label}
    </label>
  );
}

/** Apply button plus an optional "Clear" link (shown when `clearHref` is given). Extra children (e.g. an export link) follow. */
export function FilterActions({ submitLabel = "Filter", clearHref, clearLabel = "Clear", children }: { submitLabel?: string; clearHref?: string; clearLabel?: string; children?: ReactNode }) {
  return (
    <div className={cn("flex items-center gap-3", FILTER_CONTROL_HEIGHT)}>
      <Button type="submit" size="sm" variant="outline" className={FILTER_CONTROL_HEIGHT}>
        {submitLabel}
      </Button>
      {clearHref ? (
        <Link href={clearHref} className="inline-flex min-h-6 items-center text-sm font-medium text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">
          {clearLabel}
        </Link>
      ) : null}
      {children}
    </div>
  );
}

/** In-page anchor links styled like the console's link tabs. */
export function SectionNav({ items, label = "Sections", className }: { items: { id: string; label: ReactNode }[]; label?: string; className?: string }) {
  return <LinkTabs label={label} className={className} items={items.map((i) => ({ href: `#${i.id}`, label: i.label }))} />;
}

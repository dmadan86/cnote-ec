import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";
import type { LinkComponent } from "./link";

const chipClasses =
  "inline-flex min-h-8 items-center gap-1 rounded-full border border-line bg-canvas px-3 py-1 text-xs font-medium text-ink transition-colors hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

export function Chip({
  href,
  children,
  linkComponent,
  className,
  selected,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, "children"> & { href?: string; children: ReactNode; linkComponent?: LinkComponent; selected?: boolean }) {
  const cls = cn(chipClasses, selected && "border-brand-200 bg-brand-100 text-brand-700", className);
  if (href) {
    const A = linkComponent ?? "a";
    return (
      <A href={href} className={cls} aria-current={selected ? "true" : undefined}>
        {children}
      </A>
    );
  }
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
}

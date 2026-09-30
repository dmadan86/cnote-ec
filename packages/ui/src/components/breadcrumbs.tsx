import { ChevronRight } from "lucide-react";
import { cn } from "../cn";
import type { LinkComponent } from "./link";

export function Breadcrumbs({ items, linkComponent, className, label }: { items: { label: string; href?: string }[]; linkComponent?: LinkComponent; className?: string; /** Accessible name of the nav landmark (default "Breadcrumb"). */ label?: string }) {
  const A = linkComponent ?? "a";
  return (
    <nav aria-label={label ?? "Breadcrumb"} className={cn("text-sm text-muted", className)}>
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((it, i) => (
          <li key={i} className="flex items-center gap-1">
            {i > 0 ? <ChevronRight className="size-3.5" aria-hidden /> : null}
            {it.href && i < items.length - 1 ? (
              <A href={it.href} className="inline-flex min-h-6 items-center hover:text-brand-700 hover:underline">
                {it.label}
              </A>
            ) : (
              <span aria-current={i === items.length - 1 ? "page" : undefined} className={i === items.length - 1 ? "font-medium text-ink" : undefined}>
                {it.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

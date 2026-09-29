import type { ReactNode } from "react";
import { cn } from "../cn";
import type { LinkComponent } from "./link";

export interface LinkTabItem {
  href: string;
  label: ReactNode;
  active?: boolean;
  icon?: ReactNode;
}

/** Link-based tabs (state lives in the URL, so it works as a Server Component and without JS). */
export function LinkTabs({
  items,
  label,
  variant = "pill",
  linkComponent,
  className,
}: {
  items: LinkTabItem[];
  label: string;
  variant?: "pill" | "underline";
  linkComponent?: LinkComponent;
  className?: string;
}) {
  const A = linkComponent ?? "a";
  return (
    <nav aria-label={label} className={cn("-mx-1 overflow-x-auto px-1 [scrollbar-width:none]", className)}>
      <ul className="flex min-w-max items-center gap-1.5">
        {items.map((t, i) => (
          <li key={i}>
            <A
              href={t.href}
              aria-current={t.active ? "page" : undefined}
              className={cn(
                "inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap px-3.5 py-1.5 text-sm font-medium transition-colors",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
                variant === "pill"
                  ? cn("rounded-lg", t.active ? "bg-brand-100 text-brand-700" : "text-muted hover:bg-canvas hover:text-ink")
                  : cn("rounded-none border-b-2", t.active ? "border-brand-600 text-brand-700" : "border-transparent text-muted hover:text-ink"),
              )}
            >
              {t.icon}
              {t.label}
            </A>
          </li>
        ))}
      </ul>
    </nav>
  );
}

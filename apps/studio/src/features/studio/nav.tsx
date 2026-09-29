"use client";
import { cn } from "@cnote/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Overview", exact: true },
  { href: "/templates", label: "Templates" },
  { href: "/editor", label: "Editor" },
];

export function StudioNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Studio" className="flex items-center gap-1">
      {ITEMS.map((i) => {
        const active = i.exact ? pathname === i.href : pathname === i.href || pathname.startsWith(`${i.href}/`);
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-9 items-center rounded-full px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
              active ? "bg-brand-600 text-white" : "text-ink hover:bg-canvas",
            )}
          >
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}

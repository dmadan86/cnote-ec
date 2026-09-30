"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@cnote/ui";
import { NAV_ITEMS } from "./nav-items";

function useActive() {
  const pathname = usePathname();
  return (href: string) => pathname === href || pathname.startsWith(`${href}/`) || (href === "/leads" && pathname.startsWith("/conversations"));
}

export function SidebarNav() {
  const isActive = useActive();
  const t = useTranslations("shell");
  return (
    <nav aria-label={t("mainNav")} className="flex flex-col gap-1">
      {NAV_ITEMS.map(({ href, key, icon: Icon }) => {
        const active = isActive(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-brand-600",
              active ? "bg-brand-50 text-brand-700" : "text-ink hover:bg-canvas",
            )}
          >
            <Icon className="size-4" aria-hidden /> {t(`nav.${key}`)}
          </Link>
        );
      })}
    </nav>
  );
}

export function BottomNav() {
  const isActive = useActive();
  const t = useTranslations("shell");
  const items = NAV_ITEMS.filter((i) => i.primary);
  return (
    <nav aria-label={t("mainNav")} className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden">
      <ul className="grid grid-cols-5">
        {items.map(({ href, key, icon: Icon }) => {
          const active = isActive(href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium focus-visible:outline-2 focus-visible:outline-brand-600",
                  active ? "text-brand-700" : "text-muted",
                )}
              >
                <Icon className="size-5" aria-hidden /> {t(`nav.${key}`)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

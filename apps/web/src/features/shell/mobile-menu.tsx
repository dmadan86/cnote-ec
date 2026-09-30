"use client";
import { Menu, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Badge, buttonClasses } from "@cnote/ui";
import { useUserState } from "@/features/user-state/store";
import { LanguageSwitcher } from "@/i18n/language-switcher";
import { LocaleLink as Link } from "@/i18n/link";
import { NAV, SELLER_APP_URL, SITE_NAME } from "./site";

/** Mobile navigation sheet (dialog with Esc-to-close and scroll lock). */
export function MobileMenu() {
  const t = useTranslations("shell");
  const u = useUserState();
  const signedIn = u.signedIn;
  const userLabel = u.name ?? u.email;
  const savedCount = u.savedCount;
  const compareCount = u.compareIds.length;
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const opener = openerRef.current;
    // Modal dialog: Esc closes, Tab/Shift+Tab stay inside the panel, focus returns to the opener on close (WCAG 2.4.3).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return setOpen(false);
      if (e.key !== "Tab" || !panelRef.current) return;
      const f = [...panelRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((el) => el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        ref={openerRef}
        type="button"
        aria-label={t("openMenu")}
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="inline-flex size-11 items-center justify-center rounded-lg hover:bg-canvas focus-visible:outline-2 focus-visible:outline-brand-600"
      >
        <Menu className="size-6" aria-hidden />
      </button>
      {open ? (
        <div role="dialog" aria-modal="true" aria-label={t("menuTitle", { site: SITE_NAME })} className="fixed inset-0 z-50 flex justify-end">
          <button type="button" aria-label={t("closeMenu")} tabIndex={-1} className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
          <div ref={panelRef} className="relative flex h-full w-[min(22rem,90vw)] flex-col overflow-y-auto bg-surface p-4 shadow-xl" onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}>
            <div className="flex items-center justify-between">
              <span className="text-lg font-extrabold text-ink">{SITE_NAME}</span>
              <button ref={closeRef} type="button" aria-label={t("closeMenu")} onClick={() => setOpen(false)} className="inline-flex size-11 items-center justify-center rounded-lg hover:bg-canvas focus-visible:outline-2 focus-visible:outline-brand-600">
                <X className="size-6" aria-hidden />
              </button>
            </div>
            <nav aria-label={t("mobileNav")} className="mt-2 flex flex-col">
              {NAV.map((g) => (
                <details key={g.key} className="group border-b border-line">
                  <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between text-base font-semibold text-ink focus-visible:outline-2 focus-visible:outline-brand-600 [&::-webkit-details-marker]:hidden">
                    {t(`nav.${g.key}`)}
                    <span aria-hidden className="text-muted transition-transform group-open:rotate-90">
                      ›
                    </span>
                  </summary>
                  <ul className="pb-2">
                    {g.items.map((it) => (
                      <li key={it.href}>
                        <Link href={it.href} className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm text-ink hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-brand-600">
                          {t(`nav.${it.key}`)}
                          {it.soon ? <Badge tone="brand">{t("comingSoon")}</Badge> : null}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </nav>
            <div className="mt-4 flex flex-col gap-2">
              <Link href="/rfq/new" className={buttonClasses("accent", "lg")}>
                {t("requestQuote")}
              </Link>
              <Link href="/buyer/enquiries" className={buttonClasses("outline", "lg")}>
                {t("orders")}
              </Link>
              {signedIn ? (
                <Link href="/wishlist" className={buttonClasses("outline", "lg")}>
                  {t("savedItems")}{savedCount > 0 ? ` (${savedCount})` : ""}
                </Link>
              ) : null}
              <Link href="/compare" className={buttonClasses("outline", "lg")}>
                {t("compare")}{compareCount > 0 ? ` (${compareCount})` : ""}
              </Link>
              {signedIn ? (
                <p className="px-1 text-center text-sm text-muted">{t("signedInAs", { name: userLabel ?? "" })}</p>
              ) : (
                <>
                  <Link href="/signin" className={buttonClasses("outline", "lg")}>
                    {t("signIn")}
                  </Link>
                  <Link href="/signup" className={buttonClasses("primary", "lg")}>
                    {t("joinFree")}
                  </Link>
                </>
              )}
              <a href={SELLER_APP_URL} className="mt-1 text-center text-sm font-semibold text-brand-700 hover:underline">
                {t("sellOnPlain", { site: SITE_NAME })}
              </a>
              <LanguageSwitcher className="mt-3 flex items-center justify-center text-sm text-ink" />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

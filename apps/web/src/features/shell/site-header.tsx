import { Search } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Container, LogoMark } from "@cnote/ui";
import { CompareTray } from "@/features/compare/compare-tray";
import type { Locale } from "@/i18n/config";
import { LanguageSwitcher } from "@/i18n/language-switcher";
import { LanguageSuggestion } from "@/i18n/language-suggestion";
import { LocaleLink } from "@/i18n/link";
import { HeaderActions } from "./header-actions";
import { MobileMenu } from "./mobile-menu";
import { NavMenus } from "./nav-menus";
import { SELLER_APP_URL, SITE_NAME } from "./site";

/**
 * Site header. Fully static (no cookies, no session): every per-user bit (account menu, saved/compare counts,
 * pincode, compare tray) is a client island fed by GET /api/me, which is what lets pages be ISR/CDN cached.
 * `locale` selects the (statically known) language; nothing here reads the request.
 */
export async function SiteHeader({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "shell" });
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur">
        <div className="hidden border-b border-line bg-brand-900 text-xs text-brand-100 sm:block">
          <Container className="flex h-8 items-center justify-between gap-4">
            <p>{t("topbar")}</p>
            <div className="flex items-center gap-4">
              <LanguageSwitcher className="flex items-center" />
              <a href={SELLER_APP_URL} className="inline-flex min-h-6 items-center font-semibold text-white hover:underline focus-visible:outline-2 focus-visible:outline-white">
                {t("sellOn", { site: SITE_NAME })}
              </a>
            </div>
          </Container>
        </div>
        <Container className="flex h-16 items-center gap-3 lg:gap-4">
          <LocaleLink
            href="/"
            className="flex shrink-0 items-center gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            aria-label={t("homeAria", { site: SITE_NAME })}
          >
            <LogoMark />
            <span className="text-xl font-extrabold tracking-tight text-ink">{SITE_NAME}</span>
          </LocaleLink>
          <NavMenus locale={locale} />
          <div className="ml-auto flex items-center gap-1 lg:gap-2">
            <HeaderActions />
            <LocaleLink
              href="/search"
              aria-label={t("search")}
              className="inline-flex size-11 items-center justify-center rounded-lg hover:bg-canvas focus-visible:outline-2 focus-visible:outline-brand-600 lg:hidden"
            >
              <Search className="size-5" aria-hidden />
            </LocaleLink>
            <MobileMenu />
          </div>
        </Container>
      </header>
      <LanguageSuggestion />
      <CompareTray />
    </>
  );
}

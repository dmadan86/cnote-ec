import { Search } from "lucide-react";
import Link from "next/link";
import { Container, LogoMark } from "@cnote/ui";
import { CompareTray } from "@/features/compare/compare-tray";
import { HeaderActions } from "./header-actions";
import { MobileMenu } from "./mobile-menu";
import { NavMenus } from "./nav-menus";
import { SELLER_APP_URL, SITE_NAME } from "./site";

/**
 * Site header. Fully static (no cookies, no session): every per-user bit (account menu, saved/compare counts,
 * pincode, compare tray) is a client island fed by GET /api/me, which is what lets pages be ISR/CDN cached.
 */
export function SiteHeader() {
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur">
        <div className="hidden border-b border-line bg-brand-900 text-xs text-brand-100 sm:block">
          <Container className="flex h-8 items-center justify-between">
            <p>Ranked by relevance and supplier trust, never by payment.</p>
            <a href={SELLER_APP_URL} className="inline-flex min-h-6 items-center font-semibold text-white hover:underline focus-visible:outline-2 focus-visible:outline-white">
              Sell on {SITE_NAME} →
            </a>
          </Container>
        </div>
        <Container className="flex h-16 items-center gap-3 lg:gap-4">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            aria-label={`${SITE_NAME} home`}
          >
            <LogoMark />
            <span className="text-xl font-extrabold tracking-tight text-ink">{SITE_NAME}</span>
          </Link>
          <NavMenus />
          <div className="ml-auto flex items-center gap-1 lg:gap-2">
            <HeaderActions />
            <Link
              href="/search"
              aria-label="Search"
              className="inline-flex size-11 items-center justify-center rounded-lg hover:bg-canvas focus-visible:outline-2 focus-visible:outline-brand-600 lg:hidden"
            >
              <Search className="size-5" aria-hidden />
            </Link>
            <MobileMenu />
          </div>
        </Container>
      </header>
      <CompareTray />
    </>
  );
}

import {
  ClipboardList,
  FileText,
  Heart,
  Scale,
  Search,
  User,
} from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";
import { currentSession } from "@cnote/next-kit";
import { buttonClasses, Container, LogoMark } from "@cnote/ui";
import { CompareTray } from "@/features/compare/compare-tray";
import { readCompareIds } from "@/features/compare/state";
import { loadSavedCount } from "@/features/wishlist/saved";
import { AccountMenu } from "./account-menu";
import { MobileMenu } from "./mobile-menu";
import { NavMenus } from "./nav-menus";
import { PincodePicker } from "./pincode-picker";
import { PINCODE_COOKIE, SELLER_APP_URL, SITE_NAME } from "./site";

async function safeSession() {
  try {
    return await currentSession();
  } catch {
    return null; // Treat any failure as signed out; the page must still render.
  }
}

function CountBadge({ n }: { n: number }) {
  return n > 0 ? (
    <span className="ml-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-brand-600 px-1.5 text-xs font-bold text-white">
      {n}
      <span className="sr-only"> items</span>
    </span>
  ) : null;
}

export async function SiteHeader() {
  const [session, jar, compareIds] = await Promise.all([
    safeSession(),
    cookies(),
    readCompareIds(),
  ]);
  const savedCount = session ? await loadSavedCount(session.personId) : 0;
  const pin = jar.get(PINCODE_COOKIE)?.value;
  const pincode = pin && /^\d{6}$/.test(pin) ? pin : null;
  const linkCls =
    "inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-ink hover:text-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur">
        <div className="hidden border-b border-line bg-brand-900 text-xs text-brand-100 sm:block">
          <Container className="flex h-8 items-center justify-between">
            <p>Ranked by relevance and supplier trust, never by payment.</p>
            <a
              href={SELLER_APP_URL}
              className="font-semibold text-white hover:underline"
            >
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
            <span className="text-xl font-extrabold tracking-tight text-ink">
              {SITE_NAME}
            </span>
          </Link>
          <NavMenus />
          <div className="ml-auto flex items-center gap-1 lg:gap-2">
            <div className="hidden lg:block">
              <PincodePicker initial={pincode} />
            </div>
            <Link
              href="/rfq/new"
              className={`${linkCls} hidden lg:inline-flex`}
            >
              <FileText className="size-4" aria-hidden /> Request Quote
            </Link>
            <Link
              href="/buyer/enquiries"
              className={`${linkCls} hidden lg:inline-flex`}
            >
              <ClipboardList className="size-4" aria-hidden /> Orders
            </Link>
            {session ? (
              <Link
                href="/wishlist"
                className={`${linkCls} hidden lg:inline-flex`}
              >
                <Heart className="size-4" aria-hidden /> Saved
                <CountBadge n={savedCount} />
              </Link>
            ) : null}
            <Link
              href="/compare"
              className={`${linkCls} hidden lg:inline-flex`}
            >
              <Scale className="size-4" aria-hidden /> Compare
              <CountBadge n={compareIds.length} />
            </Link>
            {session ? (
              <div className="hidden lg:block">
                <AccountMenu
                  name={session.name}
                  email={session.email}
                  isSeller={!!session.business?.isSeller}
                />
              </div>
            ) : (
              <>
                <Link
                  href="/signin"
                  className={`${linkCls} hidden lg:inline-flex`}
                >
                  <User className="size-4" aria-hidden /> Sign in
                </Link>
                <Link
                  href="/signup"
                  className={buttonClasses(
                    "primary",
                    "md",
                    "hidden lg:inline-flex",
                  )}
                >
                  Join for Free
                </Link>
              </>
            )}
            <Link
              href="/search"
              aria-label="Search"
              className="inline-flex size-11 items-center justify-center rounded-lg hover:bg-canvas focus-visible:outline-2 focus-visible:outline-brand-600 lg:hidden"
            >
              <Search className="size-5" aria-hidden />
            </Link>
            <MobileMenu
              signedIn={!!session}
              userLabel={session?.name ?? session?.email ?? null}
              savedCount={savedCount}
              compareCount={compareIds.length}
            />
          </div>
        </Container>
      </header>
      <CompareTray />
    </>
  );
}

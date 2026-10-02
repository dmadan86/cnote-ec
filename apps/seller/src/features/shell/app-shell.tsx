import { LogOut } from "lucide-react";
import Link from "next/link";
import { signOutAction } from "@cnote/next-kit";
import { Button, TrustBadge } from "@cnote/ui";
import type { SessionWithBusiness } from "@cnote/next-kit";
import { getTranslations } from "next-intl/server";
import { LanguageSwitcher } from "@/i18n/language-switcher";
import { Logo } from "./logo";
import { BottomNav, SidebarNav } from "./nav";

async function SignOut() {
  const t = await getTranslations("shell");
  return (
    <form action={signOutAction}>
      <Button type="submit" variant="ghost" size="sm" icon={<LogOut className="size-4" aria-hidden />} className="min-h-11">
        {t("signOut")}
      </Button>
    </form>
  );
}

export function AppShell({ session, unansweredQuestions = 0, children }: { session: SessionWithBusiness; unansweredQuestions?: number; children: React.ReactNode }) {
  const b = session.business;
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r border-line bg-surface p-4 lg:flex">
        <Logo href="/dashboard" />
        <div className="rounded-card border border-line p-3">
          <p className="truncate text-sm font-semibold text-ink">{b.name}</p>
          <div className="mt-1.5">
            <TrustBadge tier={b.verificationTier} badgeActive={b.badgeActive} />
          </div>
        </div>
        <SidebarNav unanswered={unansweredQuestions} />
        <div className="mt-auto flex flex-col gap-3">
          <LanguageSwitcher />
          <SignOut />
        </div>
      </aside>
      <div className="flex min-w-0 flex-col pb-20 lg:pb-0">
        <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-2 lg:hidden">
          <Logo href="/dashboard" />
          <div className="flex min-w-0 items-center gap-2">
            <LanguageSwitcher />
            <Link href="/settings" className="max-w-[40vw] truncate text-sm font-medium text-ink">
              {b.name}
            </Link>
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
      <BottomNav />
    </div>
  );
}

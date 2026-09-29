import { LogOut } from "lucide-react";
import Link from "next/link";
import { signOutAction } from "@cnote/next-kit";
import { Button, TrustBadge } from "@cnote/ui";
import type { SessionWithBusiness } from "@cnote/next-kit";
import { Logo } from "./logo";
import { BottomNav, SidebarNav } from "./nav";

function SignOut() {
  return (
    <form action={signOutAction}>
      <Button type="submit" variant="ghost" size="sm" icon={<LogOut className="size-4" aria-hidden />} className="min-h-11">
        Sign out
      </Button>
    </form>
  );
}

export function AppShell({ session, children }: { session: SessionWithBusiness; children: React.ReactNode }) {
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
        <SidebarNav />
        <div className="mt-auto">
          <SignOut />
        </div>
      </aside>
      <div className="flex min-w-0 flex-col pb-20 lg:pb-0">
        <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-2 lg:hidden">
          <Logo href="/dashboard" />
          <Link href="/settings" className="max-w-[45%] truncate text-sm font-medium text-ink">
            {b.name}
          </Link>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
      <BottomNav />
    </div>
  );
}

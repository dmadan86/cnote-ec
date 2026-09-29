import { signOutAction } from "@cnote/next-kit";
import { ExternalLink, LogOut, Store } from "lucide-react";
import Link from "next/link";
import { SELLER_APP_URL } from "@/lib/env";
import { StudioNav } from "./nav";

export function StudioShell({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center gap-4 px-4">
          <Link href="/" className="inline-flex items-center gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">
            <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-white"><Store className="size-4" aria-hidden /></span>
            <span className="hidden text-base font-extrabold tracking-tight text-ink sm:inline">Storefront <span className="text-brand-600">Studio</span></span>
          </Link>
          <StudioNav />
          <div className="ml-auto flex items-center gap-3 text-sm">
            <a href={`${SELLER_APP_URL}/dashboard`} className="hidden items-center gap-1 text-muted hover:text-ink hover:underline md:inline-flex">
              Seller portal <ExternalLink className="size-3.5" aria-hidden />
            </a>
            <span className="hidden max-w-40 truncate text-muted lg:inline" title={name}>{name}</span>
            <form action={signOutAction}>
              <button type="submit" className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-ink hover:bg-canvas focus-visible:outline-2 focus-visible:outline-brand-600">
                <LogOut className="size-4" aria-hidden /> Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}

import { LogOut } from "lucide-react";
import { signOutAction } from "@cnote/next-kit";
import { Button } from "@cnote/ui";
import { Logo } from "@/features/shell/logo";

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-2 sm:px-8">
        <Logo />
        <form action={signOutAction}>
          <Button type="submit" variant="ghost" size="sm" icon={<LogOut className="size-4" aria-hidden />} className="min-h-11">Sign out</Button>
        </form>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6 sm:py-10">{children}</main>
    </div>
  );
}

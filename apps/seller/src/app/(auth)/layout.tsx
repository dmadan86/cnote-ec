import { Logo } from "@/features/shell/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="px-4 py-4 sm:px-8">
        <Logo />
      </header>
      <main className="mx-auto grid w-full max-w-5xl flex-1 items-center gap-10 px-4 pb-12 md:grid-cols-2">
        <aside className="hidden md:block">
          <h2 className="text-3xl font-extrabold leading-tight tracking-tight text-ink">
            Fewer leads. <span className="text-brand-600">Real buyers.</span>
          </h2>
          <ul className="mt-6 space-y-3 text-sm text-ink">
            <li>Each lead goes to at most 3 sellers, never a crowd.</li>
            <li>You see the buyer&apos;s intent score and your rank before you spend a credit.</li>
            <li>Buyer unreachable or fake? The credit comes back within 72 hours, no ticket needed.</li>
            <li>Free plan. Public pricing. Your badge never depends on what you pay.</li>
          </ul>
        </aside>
        <div className="mx-auto w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}

import { getTranslations } from "next-intl/server";
import { Logo } from "@/features/shell/logo";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("auth.aside");
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="px-4 py-4 sm:px-8">
        <Logo />
      </header>
      <main className="mx-auto grid w-full max-w-5xl flex-1 items-center gap-10 px-4 pb-12 md:grid-cols-2">
        <aside className="hidden md:block">
          <h2 className="text-3xl font-extrabold leading-tight tracking-tight text-ink">
            {t("title1")} <span className="text-brand-600">{t("title2")}</span>
          </h2>
          <ul className="mt-6 space-y-3 text-sm text-ink">
            <li>{t("p1")}</li>
            <li>{t("p2")}</li>
            <li>{t("p3")}</li>
            <li>{t("p4")}</li>
          </ul>
        </aside>
        <div className="mx-auto w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}

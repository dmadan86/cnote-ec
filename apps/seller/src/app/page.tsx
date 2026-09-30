import Link from "next/link";
import { ArrowRight, BadgeCheck, Gauge, Handshake, RefreshCcw, Sparkles, Users } from "lucide-react";
import { buttonClasses, Card, CardBody, Container, Money } from "@cnote/ui";
import { getTranslations } from "next-intl/server";
import { load } from "@/lib/safe";
import { Logo } from "@/features/shell/logo";
import { billing, currentSessionSafe } from "@/lib/services";
import { LanguageSwitcher } from "@/i18n/language-switcher";

const VALUE = [
  { icon: Users, key: "cap" },
  { icon: Gauge, key: "intent" },
  { icon: RefreshCcw, key: "refund" },
  { icon: BadgeCheck, key: "badge" },
  { icon: Handshake, key: "noSales" },
  { icon: Sparkles, key: "list" },
] as const;

const STEPS = [
  { n: "1", key: "one" },
  { n: "2", key: "two" },
  { n: "3", key: "three" },
] as const;

export default async function LandingPage() {
  const [plans, session] = await Promise.all([load(() => billing.listPlans()), currentSessionSafe()]);
  const t = await getTranslations("landing");
  const signedIn = Boolean(session);
  const cta = signedIn ? { href: "/dashboard", label: t("dashboard") } : { href: "/signup", label: t("start") };

  return (
    <div className="bg-canvas">
      <header className="border-b border-line bg-surface">
        <Container className="flex h-16 items-center justify-between">
          <Logo />
          <nav aria-label={t("accountNav")} className="flex items-center gap-2">
            <LanguageSwitcher />
            {signedIn ? null : (
              <Link href="/signin" className={buttonClasses("ghost", "md", "min-h-11")}>
                {t("signIn")}
              </Link>
            )}
            <Link href={cta.href} className={buttonClasses("primary", "md", "min-h-11")}>
              {signedIn ? cta.label : t("join")}
            </Link>
          </nav>
        </Container>
      </header>

      <main>
        <section className="bg-linear-to-b from-brand-50 to-canvas">
          <Container className="py-14 sm:py-20">
            <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">{t("eyebrow")}</p>
            <h1 className="mt-3 max-w-3xl text-4xl font-extrabold leading-tight tracking-tight text-ink sm:text-5xl lg:text-[3.5rem]">
              {t("headline1")} <span className="text-brand-600">{t("headline2")}</span>
            </h1>
            <p className="mt-5 max-w-2xl text-base text-muted sm:text-lg">
              {t("lede")}
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href={cta.href} className={buttonClasses("primary", "lg")}>
                {cta.label} <ArrowRight className="size-4" aria-hidden />
              </Link>
              <a href="#pricing" className={buttonClasses("outline", "lg")}>
                {t("seePricing")}
              </a>
            </div>
            <p className="mt-3 text-sm text-muted">{t("noGst")}</p>
          </Container>
        </section>

        <Container className="py-12 sm:py-14">
          <h2 className="text-xl font-bold text-ink sm:text-[22px]">{t("whyTitle")}</h2>
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {VALUE.map(({ icon: Icon, key }) => (
              <li key={key}>
                <Card className="h-full">
                  <CardBody>
                    <Icon className="size-5 text-brand-600" aria-hidden />
                    <h3 className="mt-3 font-semibold text-ink">{t(`value.${key}.title`)}</h3>
                    <p className="mt-1 text-sm text-muted">{t(`value.${key}.body`)}</p>
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        </Container>

        <section className="bg-surface">
          <Container className="py-12 sm:py-14">
            <h2 className="text-xl font-bold text-ink sm:text-[22px]">{t("howTitle")}</h2>
            <ol className="mt-6 grid gap-6 md:grid-cols-3">
              {STEPS.map((s) => (
                <li key={s.n} className="flex gap-4">
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-600 font-bold text-white">{s.n}</span>
                  <div>
                    <h3 className="font-semibold text-ink">{t(`steps.${s.key}.title`)}</h3>
                    <p className="mt-1 text-sm text-muted">{t(`steps.${s.key}.body`)}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Container>
        </section>

        <Container className="py-12 sm:py-14">
          <div id="pricing" className="scroll-mt-20">
            <h2 className="text-xl font-bold text-ink sm:text-[22px]">{t("pricingTitle")}</h2>
            <p className="mt-1 text-sm text-muted">{t("pricingIntro")}</p>
            {plans.ok ? (
              <ul className="mt-6 grid gap-4 md:grid-cols-3">
                {plans.data.map((p) => (
                  <li key={p.code}>
                    <Card className="h-full">
                      <CardBody className="flex h-full flex-col gap-3">
                        <h3 className="font-semibold text-ink">{p.name}</h3>
                        <p>
                          {p.monthlyPricePaise === 0 ? <span className="text-2xl font-bold text-ink">{t("free")}</span> : <Money paise={p.monthlyPricePaise} unit="month" className="text-2xl" />}
                        </p>
                        <p className="text-sm text-ink">{t("credits", { count: p.monthlyCredits })}</p>
                        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                          {p.features.map((f) => (
                            <li key={f}>{f}</li>
                          ))}
                        </ul>
                      </CardBody>
                    </Card>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-muted">{t("plansUnavailable")}</p>
            )}
            <div className="mt-8">
              <Link href={cta.href} className={buttonClasses("primary", "lg")}>
                {cta.label}
              </Link>
            </div>
          </div>
        </Container>
      </main>

      <footer className="border-t border-line bg-surface py-6 text-sm text-muted">
        <Container className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          <span>{t("footerNote")}</span>
          <Link href="/signin" className="font-medium text-brand-700">
            {t("signIn")}
          </Link>
        </Container>
      </footer>
    </div>
  );
}

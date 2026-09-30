import { BadgeCheck, Boxes, Factory, Sparkles, Tag, Truck, type LucideIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Container } from "@cnote/ui";
import { SITE_NAME } from "../site";
import { HeroVisual } from "./hero-visual";
import { SearchCard } from "@/features/search/search-card";
import type { Locale } from "@/i18n/config";
import { LocaleLink } from "@/i18n/link";

const TICKS: { icon: LucideIcon; key: string }[] = [
  { icon: BadgeCheck, key: "tickVerified" },
  { icon: Tag, key: "tickPrices" },
  { icon: Boxes, key: "tickBulk" },
  { icon: Truck, key: "tickDelivery" },
];

const VALUE_CARDS: { icon: LucideIcon; key: string; href: string; tint: string; tilt: string }[] = [
  { icon: Factory, key: "cardMfg", href: "/manufacturers", tint: "bg-brand-100 text-brand-700", tilt: "lg:-rotate-3 lg:self-start" },
  { icon: Sparkles, key: "cardAi", href: "/coming-soon/ai-design", tint: "bg-accent-100 text-accent-600", tilt: "lg:-rotate-2 lg:self-end" },
  { icon: Tag, key: "cardSource", href: "/search?tab=products", tint: "bg-green-100 text-green-700", tilt: "lg:-rotate-3 lg:self-start" },
];

export async function Hero({ suggestions, locale }: { suggestions: string[]; locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "home" });
  return (
    <section aria-labelledby="hero-title" className="relative isolate overflow-hidden bg-gradient-to-r from-brand-50 via-white to-white">
      {/* Warehouse backdrop, right half on desktop only (nothing heavy on mobile). */}
      <div className="pointer-events-none absolute inset-y-0 right-0 -z-10 hidden w-3/5 lg:block">
        <HeroVisual className="size-full" />
        <div className="absolute inset-0 bg-gradient-to-r from-white via-white/40 to-transparent" />
      </div>
      <Container className="grid gap-8 py-8 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)_minmax(0,320px)] lg:items-center lg:gap-6 lg:py-12">
        <div>
          <h1 id="hero-title" className="text-[2.5rem] font-extrabold leading-[1.05] tracking-tight text-ink sm:text-5xl lg:text-[3.25rem]">
            {t("titleLine1")}
            <span className="block text-brand-600">{t("titleLine2")}</span>
          </h1>
          <p className="mt-4 max-w-md text-base text-muted sm:text-lg">
            {t("subtitle")}
          </p>
          <ul className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2 text-sm font-medium text-ink">
            {TICKS.map((tick) => (
              <li key={tick.key} className="flex items-center gap-2">
                <span className="inline-flex size-6 items-center justify-center rounded-full bg-brand-100 text-brand-700">
                  <tick.icon className="size-3.5" aria-hidden />
                </span>
                {t(tick.key)}
              </li>
            ))}
          </ul>
        </div>

        <SearchCard suggestions={suggestions} />

        <div className="grid gap-3 sm:grid-cols-3 lg:flex lg:flex-col lg:gap-4" aria-label={t("whyAria", { site: SITE_NAME })}>
          {VALUE_CARDS.map((c) => (
            <LocaleLink
              key={c.key}
              href={c.href}
              className={`group flex items-center gap-3 rounded-2xl border border-line bg-surface/95 p-3.5 shadow-md transition-shadow hover:shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 lg:w-72 ${c.tilt}`}
            >
              <span className={`inline-flex size-11 shrink-0 items-center justify-center rounded-xl ${c.tint}`}>
                <c.icon className="size-5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-bold leading-tight text-ink">{t(c.key)}</span>
                <span className="mt-0.5 block text-xs text-muted">{t(`${c.key}Sub`)} →</span>
              </span>
            </LocaleLink>
          ))}
        </div>
      </Container>
    </section>
  );
}

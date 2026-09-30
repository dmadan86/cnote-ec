import { ArrowRight, Sparkles } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { Avatar, Badge, buttonClasses, Skeleton, TrustBadge } from "@cnote/ui";
import { loadSellers } from "@/features/search/data";
import { getUiLabels } from "@/features/search/labels";
import { stateLabel } from "@/features/identity/states";
import type { Locale } from "@/i18n/config";
import { LocaleLink as Link } from "@/i18n/link";
import { IndiaMap } from "./india-map";

async function AiDesignPanel({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "home" });
  const ts = await getTranslations({ locale, namespace: "shell" });
  return (
    <section aria-labelledby="promo-ai" className="@container relative overflow-hidden rounded-card bg-gradient-to-br from-brand-100 to-brand-50">
      <div className="relative z-10 p-6 pb-40 sm:p-7 sm:pb-44 @md:max-w-[60%] @md:pb-7">
        <p className="text-xs font-bold uppercase tracking-wider text-brand-700">{t("promoAiKicker")}</p>
        <h2 id="promo-ai" className="mt-2 text-xl font-bold leading-tight text-ink sm:text-2xl">
          {t("promoAiTitle")}
        </h2>
        <div className="mt-2">
          <Badge tone="brand">
            <Sparkles className="size-3" aria-hidden /> {ts("comingSoon")}
          </Badge>
        </div>
        <Link href="/coming-soon/ai-design" className={`${buttonClasses("primary", "lg")} mt-4`}>
          {t("promoAiCta")} <ArrowRight className="size-4" aria-hidden />
        </Link>
      </div>
      <svg viewBox="0 0 220 200" aria-hidden focusable="false" className="pointer-events-none absolute -bottom-2 right-0 h-40 w-auto opacity-90 @md:h-48 @xl:h-52">
        <ellipse cx="110" cy="188" rx="100" ry="10" fill="#5b2fd6" opacity=".12" />
        <path d="M20 110 70 92l50 18v60l-50 18-50-18Z" fill="#d9ad72" />
        <path d="M20 110l50 18v60l-50-18Z" fill="#b98a4e" />
        <path d="M20 110 70 92l50 18-50 18Z" fill="#ecc99a" />
        <text x="70" y="150" fontSize="11" fontWeight="700" fill="#fff" textAnchor="middle" transform="rotate(-8 70 150)">Your Brand</text>
        <path d="M110 70h50c6 0 10 4 10 10v96H100V80c0-6 4-10 10-10Z" fill="#f9a8d4" />
        <text x="135" y="130" fontSize="10" fontWeight="700" fill="#9d174d" textAnchor="middle">Your</text>
        <text x="135" y="142" fontSize="10" fontWeight="700" fill="#9d174d" textAnchor="middle">Brand</text>
        <rect x="176" y="96" width="34" height="80" rx="8" fill="#1f2937" />
        <rect x="186" y="82" width="14" height="16" rx="3" fill="#111827" />
      </svg>
    </section>
  );
}

async function QuotePanel({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "home" });
  const labels = await getUiLabels(locale);
  const all = await loadSellers({ limit: 12 });
  const states = await getTranslations({ locale, namespace: "states" });
  const sellers = all.filter((s) => s.badgeActive && s.verificationTier >= 1).slice(0, 3);
  return (
    <section aria-labelledby="promo-quotes" className="@container rounded-card bg-accent-50 p-6 sm:p-7">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 @2xl:grid-cols-2 @2xl:items-start">
        <div>
          <h2 id="promo-quotes" className="text-xl font-bold leading-tight text-ink sm:text-2xl">
            {t("promoQuotesTitle")}
          </h2>
          <p className="mt-2 text-sm text-muted">{t("promoQuotesText")}</p>
          <Link href="/rfq/new" className={`${buttonClasses("accent", "lg")} mt-5`}>
            {(await getTranslations({ locale, namespace: "shell" }))("requestQuote")} <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
        {sellers.length ? (
          <ul className="flex flex-col gap-2.5">
            {sellers.map((s) => (
              <li key={s.businessId}>
                <Link href={`/manufacturers/${s.businessId}`} className="flex items-center gap-3 rounded-xl bg-surface p-2.5 shadow-sm hover:shadow-md focus-visible:outline-2 focus-visible:outline-accent-500">
                  <Avatar name={s.name} size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-bold text-ink">{s.name}</span>
                    <span className="block truncate text-xs text-muted">{[s.city, stateLabel(s.state, (c) => (states.has(c) ? states(c) : undefined))].filter(Boolean).join(", ")}</span>
                  </span>
                  <TrustBadge tier={s.verificationTier} badgeActive={s.badgeActive} className="shrink-0" labels={labels.trust} />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl bg-surface p-4 text-sm text-muted">{t("promoQuotesEmpty")}</p>
        )}
      </div>
    </section>
  );
}

async function ManufacturersPanel({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "home" });
  return (
    <section aria-labelledby="promo-mfg" className="@container relative overflow-hidden rounded-card bg-gradient-to-br from-sky-50 to-brand-50 md:col-span-2 2xl:col-span-1">
      <div className="relative z-10 p-6 pb-44 sm:p-7 sm:pb-48 @md:max-w-[60%] @md:pb-7">
        <h2 id="promo-mfg" className="text-xl font-bold leading-tight text-brand-900 sm:text-2xl">
          {t("promoMfgTitle")}
        </h2>
        <p className="mt-2 text-sm text-muted">{t("promoMfgText")}</p>
        <Link href="/manufacturers" className={`${buttonClasses("outline-brand", "lg")} mt-5`}>
          {t("promoMfgCta")} <ArrowRight className="size-4" aria-hidden />
        </Link>
      </div>
      <IndiaMap className="pointer-events-none absolute -bottom-3 right-3 h-40 w-auto @md:bottom-auto @md:top-1/2 @md:h-36 @md:-translate-y-1/2 @2xl:h-44" />
    </section>
  );
}

export function PromoPanels({ locale }: { locale: Locale }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2 2xl:grid-cols-[1.2fr_1.2fr_1fr]">
      <AiDesignPanel locale={locale} />
      <QuotePanelBoundary locale={locale} />
      <ManufacturersPanel locale={locale} />
    </div>
  );
}

function QuotePanelBoundary({ locale }: { locale: Locale }) {
  return (
    <Suspense fallback={<Skeleton className="min-h-56 rounded-card" />}>
      <QuotePanel locale={locale} />
    </Suspense>
  );
}

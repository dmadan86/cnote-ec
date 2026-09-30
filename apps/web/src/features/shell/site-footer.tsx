import { getTranslations } from "next-intl/server";
import { Container, LogoMark } from "@cnote/ui";
import { ManageConsentLink } from "@/features/analytics";
import type { Locale } from "@/i18n/config";
import { LanguageSwitcher } from "@/i18n/language-switcher";
import { LocaleLink } from "@/i18n/link";
import { SELLER_APP_URL, SITE_NAME } from "./site";

interface FooterLink {
  key: string;
  href: string;
  external?: boolean;
}
const COLS: { key: "buy" | "sell" | "explore"; links: FooterLink[] }[] = [
  {
    key: "buy",
    links: [
      { key: "nav.allProducts", href: "/search?tab=products" },
      { key: "nav.shopByCategory", href: "/categories" },
      { key: "nav.allManufacturers", href: "/manufacturers" },
      { key: "footer.postRequirementLink", href: "/rfq/new" },
    ],
  },
  {
    key: "sell",
    links: [
      { key: "sellOnPlain", href: SELLER_APP_URL, external: true },
      { key: "footer.joinForFree", href: "/signup" },
    ],
  },
  {
    key: "explore",
    links: [
      { key: "nav.aiDesign", href: "/coming-soon/ai-design" },
      { key: "nav.templates", href: "/coming-soon/templates-design" },
      { key: "footer.businessServices", href: "/coming-soon/business-services" },
      { key: "nav.resources", href: "/coming-soon/resources" },
      // DPDP Act / IT Rules: grievance officer contact and complaint form must be reachable from every page.
      { key: "footer.grievance", href: "/grievance" },
    ],
  },
];

export async function SiteFooter({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "shell" });
  const tagline = (await getTranslations({ locale, namespace: "meta" }))("tagline");
  const linkCls = "inline-flex min-h-8 items-center text-muted hover:text-brand-700 hover:underline";
  return (
    <footer className="mt-16 border-t border-line bg-surface">
      <Container className="grid gap-8 py-10 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="flex items-center gap-2">
            <LogoMark className="size-7" />
            <span className="text-lg font-extrabold text-ink">{SITE_NAME}</span>
          </div>
          <p className="mt-3 max-w-xs text-sm text-muted">{t("footer.aboutText", { tagline })}</p>
        </div>
        {COLS.map((c) => (
          <nav key={c.key} aria-label={t(`footer.${c.key}`)}>
            <h2 className="text-sm font-bold text-ink">{t(`footer.${c.key}`)}</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {c.links.map((l) => {
                const label = l.key === "sellOnPlain" ? t("sellOnPlain", { site: SITE_NAME }) : t(l.key);
                return (
                  <li key={l.key}>
                    {l.external ? (
                      <a href={l.href} className={linkCls}>
                        {label}
                      </a>
                    ) : (
                      <LocaleLink href={l.href} className={linkCls}>
                        {label}
                      </LocaleLink>
                    )}
                  </li>
                );
              })}
            </ul>
          </nav>
        ))}
      </Container>
      <div className="flex flex-col items-center gap-2 border-t border-line py-4 text-center text-xs text-muted">
        <LanguageSwitcher className="flex items-center text-ink" />
        <p>
          {t("footer.copyright", { year: new Date().getFullYear(), site: SITE_NAME })}{" "}
          <a href="/llms.txt" className="inline-flex min-h-8 items-center underline hover:text-brand-700">
            llms.txt
          </a>
        </p>
        {process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID ? <ManageConsentLink className="inline-flex min-h-8 items-center underline hover:text-brand-700" /> : null}
      </div>
    </footer>
  );
}

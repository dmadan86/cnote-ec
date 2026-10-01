import { getTranslations } from "next-intl/server";
import { buttonClasses, Container, LogoMark } from "@cnote/ui";
import { BadgeCheck, Globe, ShieldCheck, Users } from "lucide-react";
import { CookieSettingsButton } from "@/features/consent";
import type { Locale } from "@/i18n/config";
import { LanguageSwitcher } from "@/i18n/language-switcher";
import { LocaleLink } from "@/i18n/link";
import { SELLER_APP_URL, SITE_NAME } from "./site";

// Layout research (Mobbin, docs/design/footer.md): Codecademy / Shop (brand + mission left, balanced link columns right,
// thin legal bar), GetYourGuide / lululemon (dark full-bleed footer, "Your privacy choices" next to the legal links),
// Fiverr / Amazon (a closing call to action above the links for visitors who scrolled to the end without finding it).

interface FooterLink {
  key: string;
  href: string;
  external?: boolean;
}
type ColKey = "buy" | "sell" | "explore" | "legal";
const COLS: { key: ColKey; links: FooterLink[] }[] = [
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
      { key: "footer.pricing", href: "/pricing" },
    ],
  },
  {
    key: "explore",
    links: [
      { key: "nav.aiDesign", href: "/coming-soon/ai-design" },
      { key: "nav.templates", href: "/coming-soon/templates-design" },
      { key: "footer.businessServices", href: "/coming-soon/business-services" },
      { key: "nav.resources", href: "/coming-soon/resources" },
    ],
  },
  {
    // Trust is the product (ADR-002/005): how ranking and ads work and how disputes are handled sit beside the legal links.
    key: "legal",
    links: [
      { key: "footer.ranking", href: "/ranking-and-ads" },
      { key: "footer.disputePolicy", href: "/dispute-policy" },
      // DPDP Act / IT Rules: grievance officer contact and complaint form must be reachable from every page.
      { key: "footer.grievance", href: "/grievance" },
      // ePrivacy Art 5(3) / DPDP s.5: the cookie notice is reachable from every page; withdrawal is the button below it.
      { key: "footer.cookiePolicy", href: "/cookies" },
    ],
  },
];

const TRUST = [
  { key: "trust1", Icon: BadgeCheck },
  { key: "trust2", Icon: Users },
  { key: "trust3", Icon: ShieldCheck },
] as const;

// On brand-900: white 14:1, brand-200 10:1, brand-100 12:1 (all AA). Focus ring is white for 3:1+ against the footer.
const linkCls =
  "inline-flex min-h-8 items-center text-brand-200 underline-offset-4 hover:text-white hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

export async function SiteFooter({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "shell" });
  const tagline = (await getTranslations({ locale, namespace: "meta" }))("tagline");
  const label = (key: string) => (key === "sellOnPlain" ? t("sellOnPlain", { site: SITE_NAME }) : t(key));

  return (
    <footer className="mt-16 bg-brand-900 text-white">
      <Container className="pt-10 lg:pt-12">
        {/* Closing call to action: the buyer's main job, for visitors who reached the end without finding it. */}
        <div className="flex flex-col gap-5 rounded-card border border-white/15 bg-white/5 p-5 sm:p-6 md:flex-row md:items-center md:justify-between">
          <div className="max-w-2xl">
            <p className="text-lg font-bold">{t("footer.ctaTitle")}</p>
            <p className="mt-1 text-sm text-brand-100">{t("footer.ctaText")}</p>
          </div>
          <div className="flex flex-wrap gap-3 md:shrink-0">
            <LocaleLink href="/rfq/new" className={buttonClasses("accent", "md", "min-h-11 focus-visible:outline-white")}>
              {t("footer.postRequirementLink")}
            </LocaleLink>
            <a
              href={SELLER_APP_URL}
              className={buttonClasses("ghost", "md", "min-h-11 border border-white/40 text-white hover:bg-white/10 focus-visible:outline-white")}
            >
              {t("sellOnPlain", { site: SITE_NAME })}
            </a>
          </div>
        </div>

        <div className="grid gap-10 py-10 lg:grid-cols-12 lg:gap-8 lg:py-12">
          <div className="lg:col-span-4">
            <LocaleLink href="/" className="inline-flex items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
              <LogoMark className="size-8 text-brand-500" />
              <span className="text-xl font-extrabold">{SITE_NAME}</span>
            </LocaleLink>
            <p className="mt-3 max-w-sm text-sm text-brand-100">{t("footer.aboutText", { tagline })}</p>
            <ul className="mt-5 space-y-2.5 text-sm">
              {TRUST.map(({ key, Icon }) => (
                <li key={key} className="flex items-start gap-2.5">
                  <Icon className="mt-0.5 size-4 shrink-0 text-accent-500" aria-hidden />
                  <span>{t(`footer.${key}`)}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* One landmark for all footer links; each column is a headed list (fewer, clearer landmarks than one nav per column). */}
          <nav aria-label={t("footer.navLabel")} className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-4 lg:col-span-8">
            {COLS.map((c) => (
              <div key={c.key}>
                <h2 className="text-xs font-bold tracking-wider text-white uppercase">{t(`footer.${c.key}`)}</h2>
                <ul className="mt-3 space-y-1.5 text-sm">
                  {c.links.map((l) => (
                    <li key={l.key}>
                      {l.external ? (
                        <a href={l.href} className={linkCls}>
                          {label(l.key)}
                        </a>
                      ) : (
                        <LocaleLink href={l.href} className={linkCls}>
                          {label(l.key)}
                        </LocaleLink>
                      )}
                    </li>
                  ))}
                  {c.key === "legal" ? (
                    <li>
                      {/* Always rendered: withdrawing consent must be as easy as giving it (DPDP s.6(4)). Opens the dialog, no reload. */}
                      <CookieSettingsButton label={t("footer.cookiePrefs")} className={`${linkCls} cursor-pointer text-left`} />
                    </li>
                  ) : null}
                </ul>
              </div>
            ))}
          </nav>
        </div>
      </Container>

      <div className="border-t border-white/15">
        <Container className="flex flex-col gap-3 py-5 text-xs text-brand-200 md:flex-row md:items-center md:justify-between">
          <p>
            {t("footer.copyright", { year: new Date().getFullYear(), site: SITE_NAME })}{" "}
            <a href="/llms.txt" className={`${linkCls} min-h-6 underline`}>
              llms.txt
            </a>
          </p>
          <div className="flex items-center gap-2 text-white">
            <Globe className="size-4 text-brand-200" aria-hidden />
            <LanguageSwitcher className="flex items-center [&_select]:border-white/40 [&_select]:focus-visible:outline-white" />
          </div>
        </Container>
      </div>
    </footer>
  );
}

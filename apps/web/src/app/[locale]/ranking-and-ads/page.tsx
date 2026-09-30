import { getAdsConfig, isAdsEnabled, RANKING_DISCLOSURE, resolveAdsConfig } from "@cnote/ads";
import { Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LocaleLink as Link } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";
import { localizedAlternates } from "@/lib/seo-i18n";

// Public ranking-parameter disclosure (Consumer Protection (E-Commerce) Rules, ranking parameters + sponsored listings).
// Numbers come from RANKING_DISCLOSURE (code constants) and the live ads configuration, so this page cannot drift from behaviour.
export const revalidate = 600;

export async function generateMetadata(props: PageProps<"/[locale]/ranking-and-ads">): Promise<Metadata> {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "ads" });
  return { title: t("rankingTitle"), description: t("rankingDescription"), alternates: localizedAlternates("/ranking-and-ads", locale) };
}

async function config() {
  try {
    return await getAdsConfig();
  } catch {
    return resolveAdsConfig([]); // database unreachable at build/regeneration: published defaults
  }
}

export default async function RankingAndAdsPage(props: PageProps<"/[locale]/ranking-and-ads">) {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "ads" });
  const cfg = await config();
  const d = RANKING_DISCLOSURE;
  const caps = { maxSlots: cfg.maxSearchSlots, perOrganic: cfg.perOrganicResults, sharePct: Math.round(cfg.maxAdShare * 100), minOrganic: cfg.minOrganicForAds };
  return (
    <Container className="py-10">
      <PageHeader title={t("rankingTitle")} description={t("rankingIntro")} />
      <p className="mt-2 text-sm text-muted">{t("rankingUpdated", { date: d.updated, version: d.version })}</p>
      {!isAdsEnabled() ? (
        <p role="note" className="mt-4 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink">
          <strong>{t("comingSoonTitle")}.</strong> {t("comingSoonText")}
        </p>
      ) : null}
      <div className="mt-8 flex max-w-3xl flex-col gap-8">
        <section aria-labelledby="organic-h">
          <h2 id="organic-h" className="text-lg font-bold text-ink">{t("organicH")}</h2>
          <p className="mt-2 text-ink">{t("organicP1", { trustPct: d.organic.trustWeightMaxPct })}</p>
          <p className="mt-2 text-ink">{t("organicP2", { locationPct: d.organic.locationBoostPct })}</p>
          <p className="mt-2 font-semibold text-ink">{t("organicP3")}</p>
        </section>
        <section aria-labelledby="sponsored-h">
          <h2 id="sponsored-h" className="text-lg font-bold text-ink">{t("sponsoredH")}</h2>
          <ul className="mt-2 flex list-disc flex-col gap-2 pl-5 text-ink">
            <li>{t("sponsoredP1")}</li>
            <li>{t("sponsoredWho", { minTier: cfg.minVerificationTier, trustFloor: cfg.trustFloor })}</li>
            <li>{t("sponsoredHow")}</li>
            <li>{t("sponsoredPrice")}</li>
            <li>{t("sponsoredCaps", caps)}</li>
            <li>{t("sponsoredRefund")}</li>
          </ul>
        </section>
        <section aria-labelledby="never-h">
          <h2 id="never-h" className="text-lg font-bold text-ink">{t("neverH")}</h2>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-ink">
            {(["never1", "never2", "never3"] as const).map((k) => (
              <li key={k}>{t(k)}</li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="contact-h">
          <h2 id="contact-h" className="text-lg font-bold text-ink">{t("contactH")}</h2>
          <p className="mt-2 text-ink">{t("contactP")}</p>
          <p className="mt-2">
            <Link href="/grievance" className="text-brand-700 underline underline-offset-2">{t("contactLink")}</Link>
          </p>
        </section>
      </div>
    </Container>
  );
}

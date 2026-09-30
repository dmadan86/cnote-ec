import { Badge } from "@cnote/ui";
import { getTranslations } from "next-intl/server";
import { LocaleLink } from "@/i18n/link";
import type { Locale } from "@/i18n/config";
import { Popover } from "./popover";
import { NAV } from "./site";

/** Desktop navigation dropdowns (server-rendered panels inside a small client popover). */
export async function NavMenus({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "shell" });
  return (
    <nav aria-label={t("primaryNav")} className="hidden items-center gap-0.5 lg:flex">
      {NAV.map((g) => (
        <Popover key={g.key} label={t(`nav.${g.key}`)} panelClassName="w-72">
          <ul>
            {g.items.map((it) => (
              <li key={it.href}>
                <LocaleLink href={it.href} className="flex flex-col gap-0.5 rounded-lg px-3 py-2.5 hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-brand-600">
                  <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                    {t(`nav.${it.key}`)}
                    {it.soon ? <Badge tone="brand">{t("comingSoon")}</Badge> : null}
                  </span>
                  <span className="text-xs text-muted">{t(`nav.${it.key}Desc`)}</span>
                </LocaleLink>
              </li>
            ))}
          </ul>
        </Popover>
      ))}
    </nav>
  );
}

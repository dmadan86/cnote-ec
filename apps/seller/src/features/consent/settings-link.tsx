import { CookieSettingsButton } from "@cnote/next-kit/consent";
import { getTranslations } from "next-intl/server";

/** "Cookie settings": reopens the preferences dialog without a reload (withdrawing is as easy as giving consent, DPDP s.6(4)). */
export async function CookieSettingsLink({ className = "text-sm font-medium text-brand-700 underline" }: { className?: string }) {
  const t = await getTranslations("consent");
  return <CookieSettingsButton label={t("openSettings")} className={`min-h-11 min-w-11 ${className}`} />;
}

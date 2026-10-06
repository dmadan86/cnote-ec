import { CookieSettingsButton } from "@cnote/next-kit/consent";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

const LINK = "text-sm font-medium text-brand-700 underline";

/** "Cookie settings": reopens the preferences dialog without a reload (withdrawing is as easy as giving consent, DPDP s.6(4)). */
export async function CookieSettingsLink({ className = LINK }: { className?: string }) {
  const t = await getTranslations("consent");
  return <CookieSettingsButton label={t("openSettings")} className={`min-h-11 min-w-11 ${className}`} />;
}

/** Footer pair: the cookie policy page (generated from the registry) and the settings dialog. */
export async function CookieLinks({ className = LINK }: { className?: string }) {
  const t = await getTranslations("consent");
  return (
    <span className="inline-flex flex-wrap items-center justify-center gap-x-4">
      <Link href="/cookies" className={`inline-flex min-h-11 min-w-11 items-center ${className}`}>
        {t("policyTitle")}
      </Link>
      <CookieSettingsLink className={className} />
    </span>
  );
}

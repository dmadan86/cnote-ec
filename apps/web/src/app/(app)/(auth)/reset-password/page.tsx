import { Alert } from "@cnote/ui";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { LocalizedResetPasswordForm } from "@/features/identity/localized-forms";
import { getRequestLocale } from "@/lib/request-locale";
import { AuthHeading, first } from "@/features/identity/auth-page";

export async function generateMetadata() {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("reset"), referrer: "no-referrer" as const };
}

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "auth" });
  const token = first((await searchParams).token);
  return (
    <>
      <AuthHeading title={t("resetTitle")} />
      {token ? (
        <LocalizedResetPasswordForm token={token} />
      ) : (
        <Alert tone="danger">
          {t("resetInvalid")}{" "}
          <Link href="/forgot-password" className="font-medium underline">
            {t("resetRequestNew")}
          </Link>
          .
        </Alert>
      )}
    </>
  );
}

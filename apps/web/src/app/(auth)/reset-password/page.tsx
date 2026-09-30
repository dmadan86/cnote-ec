import { Alert } from "@cnote/ui";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { LocalizedResetPasswordForm } from "@/features/identity/localized-forms";
import { AuthHeading, first } from "@/features/identity/auth-page";

export const metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const t = await getTranslations({ locale: "en", namespace: "auth" });
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

import { getTranslations } from "next-intl/server";
import { LocalizedForgotPasswordForm } from "@/features/identity/localized-forms";
import { getRequestLocale } from "@/lib/request-locale";
import { AuthHeading } from "@/features/identity/auth-page";

export async function generateMetadata() {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("forgot") };
}

export default async function ForgotPasswordPage() {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "auth" });
  return (
    <>
      <AuthHeading title={t("forgotTitle")} subtitle={t("forgotSubtitle")} />
      <LocalizedForgotPasswordForm />
    </>
  );
}

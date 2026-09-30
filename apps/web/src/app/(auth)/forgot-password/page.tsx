import { getTranslations } from "next-intl/server";
import { LocalizedForgotPasswordForm } from "@/features/identity/localized-forms";
import { AuthHeading } from "@/features/identity/auth-page";

export const metadata = { title: "Reset your password" };

export default async function ForgotPasswordPage() {
  const t = await getTranslations({ locale: "en", namespace: "auth" });
  return (
    <>
      <AuthHeading title={t("forgotTitle")} subtitle={t("forgotSubtitle")} />
      <LocalizedForgotPasswordForm />
    </>
  );
}

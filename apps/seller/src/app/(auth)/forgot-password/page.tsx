import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LocalizedForgotPasswordForm } from "@/features/shell/localized-auth-forms";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.forgot");
  return { title: t("meta") };
}

export default function ForgotPasswordPage() {
  return <LocalizedForgotPasswordForm />;
}

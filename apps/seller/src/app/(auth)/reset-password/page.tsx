import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { LocalizedResetPasswordForm } from "@/features/shell/localized-auth-forms";
import { Alert } from "@cnote/ui";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.reset");
  return { title: t("meta") };
}

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  if (!token) {
    const t = await getTranslations("auth.reset");
    return (
      <Alert tone="warning">
        {t.rich("incomplete", { link: (chunks) => <Link href="/forgot-password" className="font-medium underline">{chunks}</Link> })}
      </Alert>
    );
  }
  return <LocalizedResetPasswordForm token={token} />;
}

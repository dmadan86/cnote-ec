import { Alert } from "@cnote/ui";
import { safeNext } from "@cnote/next-kit";
import { getTranslations } from "next-intl/server";
import { LocalizedSignInForm } from "@/features/identity/localized-forms";
import { getRequestLocale } from "@/lib/request-locale";
import { AuthHeading, first, googleEnabled } from "@/features/identity/auth-page";

export async function generateMetadata() {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("signIn") };
}

export default async function SignInPage({ searchParams }: PageProps<"/signin">) {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "auth" });
  const sp = await searchParams;
  const next = safeNext(first(sp.next), "");
  const error = first(sp.error);
  return (
    <>
      <AuthHeading title={t("signInTitle")} subtitle={t("signInSubtitle")} />
      {first(sp.reset) ? <Alert tone="success">{t("resetDone")}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <LocalizedSignInForm next={next || undefined} googleEnabled={googleEnabled()} />
    </>
  );
}

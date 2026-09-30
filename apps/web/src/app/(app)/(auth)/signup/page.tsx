import { safeNext } from "@cnote/next-kit";
import { getTranslations } from "next-intl/server";
import { LocalizedSignUpForm } from "@/features/identity/localized-forms";
import { getRequestLocale } from "@/lib/request-locale";
import { AuthHeading, first, googleEnabled } from "@/features/identity/auth-page";

export async function generateMetadata() {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("signUp") };
}

export default async function SignUpPage({ searchParams }: PageProps<"/signup">) {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "auth" });
  const sp = await searchParams;
  const next = safeNext(first(sp.next), "/");
  // New accounts create their business profile first, then continue where they were headed.
  const afterSignUp = `/onboarding?next=${encodeURIComponent(next)}`;
  return (
    <>
      <AuthHeading title={t("signUpTitle")} subtitle={t("signUpSubtitle")} />
      <LocalizedSignUpForm next={afterSignUp} googleEnabled={googleEnabled()} paths={{ signIn: "/signin" }} />
    </>
  );
}

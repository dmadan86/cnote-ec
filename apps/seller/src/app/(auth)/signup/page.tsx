import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LocalizedSignUpForm } from "@/features/shell/localized-auth-forms";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.signup");
  return { title: t("meta") };
}

export default async function SignUpPage({ searchParams }: PageProps<"/signup">) {
  const sp = await searchParams;
  const t = await getTranslations("auth.signup");
  const next = typeof sp.next === "string" ? sp.next : "/onboarding";
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted">{t("body")}</p>
      </div>
      <LocalizedSignUpForm next={next} googleEnabled={Boolean(process.env.GOOGLE_CLIENT_ID)} />
    </div>
  );
}

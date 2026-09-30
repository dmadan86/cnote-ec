import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LocalizedSignInForm } from "@/features/shell/localized-auth-forms";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.signin");
  return { title: t("meta") };
}

export default async function SignInPage({ searchParams }: PageProps<"/signin">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : undefined;
  return <LocalizedSignInForm next={next} googleEnabled={Boolean(process.env.GOOGLE_CLIENT_ID)} />;
}

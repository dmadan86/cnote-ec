import { requireSession, safeNext } from "@cnote/next-kit";
import { Card, CardBody } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { AuthHeading, first } from "@/features/identity/auth-page";
import { OnboardingForm } from "@/features/identity/forms";
import { getRequestLocale } from "@/lib/request-locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("onboarding") };
}

export default async function OnboardingPage({ searchParams }: PageProps<"/onboarding">) {
  const next = safeNext(first((await searchParams).next), "/");
  const session = await requireSession(`/onboarding?next=${encodeURIComponent(next)}`);
  if (session.business) redirect(next);
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "account" });
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 py-12">
      <AuthHeading title={t("onbTitle")} subtitle={t("onbSubtitle")} />
      <Card>
        <CardBody className="p-6">
          <OnboardingForm next={next} />
        </CardBody>
      </Card>
    </div>
  );
}

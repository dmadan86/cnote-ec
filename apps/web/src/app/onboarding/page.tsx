import { requireSession, safeNext } from "@cnote/next-kit";
import { Card, CardBody } from "@cnote/ui";
import { redirect } from "next/navigation";
import { AuthHeading, first } from "@/features/identity/auth-page";
import { OnboardingForm } from "@/features/identity/forms";

export const metadata = { title: "Set up your business" };

export default async function OnboardingPage({ searchParams }: PageProps<"/onboarding">) {
  const next = safeNext(first((await searchParams).next), "/");
  const session = await requireSession(`/onboarding?next=${encodeURIComponent(next)}`);
  if (session.business) redirect(next);
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 py-12">
      <AuthHeading title="Tell us about your business" subtitle="Sellers use this to see who is asking. You can add more later." />
      <Card>
        <CardBody className="p-6">
          <OnboardingForm next={next} />
        </CardBody>
      </Card>
    </div>
  );
}

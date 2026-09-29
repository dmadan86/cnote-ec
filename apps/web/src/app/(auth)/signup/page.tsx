import { safeNext } from "@cnote/next-kit";
import { SignUpForm } from "@cnote/next-kit/client";
import { AuthHeading, first, googleEnabled } from "@/features/identity/auth-page";

export const metadata = { title: "Create your account" };

export default async function SignUpPage({ searchParams }: PageProps<"/signup">) {
  const sp = await searchParams;
  const next = safeNext(first(sp.next), "/");
  // New accounts create their business profile first, then continue where they were headed.
  const afterSignUp = `/onboarding?next=${encodeURIComponent(next)}`;
  return (
    <>
      <AuthHeading title="Join for free" subtitle="Find verified manufacturers and get quotes from up to 3 sellers." />
      <SignUpForm next={afterSignUp} googleEnabled={googleEnabled()} paths={{ signIn: "/signin" }} />
    </>
  );
}

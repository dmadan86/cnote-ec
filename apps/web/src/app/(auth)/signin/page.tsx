import { Alert } from "@cnote/ui";
import { safeNext } from "@cnote/next-kit";
import { SignInForm } from "@cnote/next-kit/client";
import { AuthHeading, first, googleEnabled } from "@/features/identity/auth-page";

export const metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: PageProps<"/signin">) {
  const sp = await searchParams;
  const next = safeNext(first(sp.next), "");
  const error = first(sp.error);
  return (
    <>
      <AuthHeading title="Welcome back" subtitle="Sign in to manage enquiries and quotes." />
      {first(sp.reset) ? <Alert tone="success">Password updated. Sign in with your new password.</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <SignInForm next={next || undefined} googleEnabled={googleEnabled()} />
    </>
  );
}

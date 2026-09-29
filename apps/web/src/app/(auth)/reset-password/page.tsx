import { Alert } from "@cnote/ui";
import { ResetPasswordForm } from "@cnote/next-kit/client";
import Link from "next/link";
import { AuthHeading, first } from "@/features/identity/auth-page";

export const metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const token = first((await searchParams).token);
  return (
    <>
      <AuthHeading title="Choose a new password" />
      {token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <Alert tone="danger">
          This reset link is invalid.{" "}
          <Link href="/forgot-password" className="font-medium underline">
            Request a new one
          </Link>
          .
        </Alert>
      )}
    </>
  );
}
